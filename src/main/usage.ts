// Ambil limit paket langganan Claude via endpoint OAuth internal (sama seperti CLI).
// Token HANYA hidup di main-process — tak pernah dikirim ke renderer. Email BOLEH (bukan rahasia).
//
// Usage selalu diambil PER AKUN: pemanggil menyerahkan token akun yang dimaksud
// (dari DB, lihat SessionManager.getSessionAccountInfo). Untuk akun "default"
// (login utama CLI) token-nya dibaca dari ~/.claude/.credentials.json seperti dulu.
//
// KETERBATASAN NYATA (hasil probe 2026-07-19, jangan dihapus tanpa uji ulang):
// kedua endpoint di bawah menuntut scope `user:profile`. Login utama punya scope itu,
// tapi token dari `claude setup-token` (sk-ant-oat01-…) TIDAK — jawabannya 403
// "OAuth token does not meet scope requirement any_of(user:profile)". Jadi untuk akun
// tersimpan, usage MAUPUN email memang tak bisa didapat. Kita tampilkan apa adanya
// (lihat UsageUnavailable) dan TIDAK PERNAH jatuh ke angka/email login utama.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageInfo, UsageUnavailable, UsageWindow } from '../shared/types'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

/** Identitas akun untuk fetch. id null = login utama; selain itu token WAJIB dari DB. */
export interface UsageAccount {
  id: string | null
  token: string | null
}

export interface UsageResult {
  usage: UsageInfo | null
  reason?: UsageUnavailable // terisi hanya saat usage null
}

/** Token login utama CLI (dipakai HANYA untuk akun default). */
function readDefaultToken(): string | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN
  const p = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(p)) return null
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return j?.claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

/**
 * Token yang dipakai untuk akun ini.
 * PENTING: untuk akun tersimpan (id != null) TIDAK ADA fallback ke credentials.json —
 * kalau tokennya hilang kita lebih baik tak menampilkan apa-apa daripada menampilkan
 * milik login utama (itu persis bug yang sedang diperbaiki).
 */
function readToken(account: UsageAccount): string | null {
  if (account.id) return account.token
  return account.token ?? readDefaultToken()
}

const toWindow = (x: { utilization?: number; resets_at?: string } | undefined): UsageWindow => ({
  utilization: x?.utilization ?? null,
  resetsAt: x?.resets_at ?? null
})

const cacheKey = (accountId: string | null): string => accountId ?? 'default'

/** HTTP status → alasan yang bisa dijelaskan ke user. */
function reasonFor(status: number): UsageUnavailable {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'scope'
  if (status === 429) return 'rate-limited'
  return 'error'
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'Content-Type': 'application/json'
  }
}

// Cache nilai sukses terakhir PER AKUN. Token OAuth expired ~tiap jam → fetch bisa 401 sesaat;
// alih-alih mengosongkan UI, kembalikan last-good bertanda stale sampai token segar lagi.
// WAJIB per-akun: kalau satu variabel global, pindah sesi akan memperlihatkan angka akun
// SEBELUMNYA (ditandai stale) — kebingungan yang justru ingin kita hilangkan.
const lastGood = new Map<string, UsageInfo>()
const lastReason = new Map<string, UsageUnavailable>()

/** Nilai cache akun ini tanpa fetch (dipakai saat pindah sesi supaya UI langsung benar). */
export function peekUsage(accountId: string | null): UsageResult {
  const key = cacheKey(accountId)
  const prev = lastGood.get(key)
  if (prev) return { usage: prev }
  return { usage: null, reason: lastReason.get(key) }
}

export async function fetchUsage(account: UsageAccount): Promise<UsageResult> {
  const key = cacheKey(account.id)
  const fresh = await fetchUsageRaw(account)
  if (fresh.usage) {
    lastGood.set(key, fresh.usage)
    lastReason.delete(key)
    return fresh
  }
  lastReason.set(key, fresh.reason ?? 'error')
  const prev = lastGood.get(key)
  // Last-good HANYA milik akun ini (key), jadi tak mungkin bocor ke akun lain.
  return prev ? { usage: { ...prev, stale: true } } : { usage: null, reason: fresh.reason }
}

async function fetchUsageRaw(account: UsageAccount): Promise<UsageResult> {
  const token = readToken(account)
  if (!token) return { usage: null, reason: 'no-token' }
  try {
    const res = await fetch(USAGE_URL, { headers: authHeaders(token) })
    if (!res.ok) return { usage: null, reason: reasonFor(res.status) }
    const d = (await res.json()) as Record<string, never>
    const eu = (d as Record<string, { is_enabled?: boolean; monthly_limit?: number; used_credits?: number; utilization?: number; currency?: string }>)
      .extra_usage
    return {
      usage: {
        fiveHour: toWindow((d as Record<string, never>).five_hour),
        sevenDay: toWindow((d as Record<string, never>).seven_day),
        sevenDayOpus: (d as Record<string, never>).seven_day_opus ? toWindow((d as Record<string, never>).seven_day_opus) : undefined,
        sevenDaySonnet: (d as Record<string, never>).seven_day_sonnet
          ? toWindow((d as Record<string, never>).seven_day_sonnet)
          : undefined,
        monthly: eu
          ? {
              enabled: !!eu.is_enabled,
              limit: eu.monthly_limit ?? null,
              used: eu.used_credits ?? null,
              utilization: eu.utilization ?? null,
              currency: eu.currency ?? null
            }
          : undefined,
        fetchedAt: Date.now()
      }
    }
  } catch {
    return { usage: null, reason: 'error' }
  }
}

// ---- email akun ------------------------------------------------------------
// Endpoint usage TIDAK memuat identitas akun (sudah dicek: top-level keys-nya murni angka
// limit), jadi email harus dari /oauth/profile — dan hanya berhasil untuk token ber-scope
// user:profile. `retry:false` = gagal permanen (scope/401) → jangan hammer tiap poll.
const emailCache = new Map<string, { email: string | null; retry: boolean }>()

/** Email akun dari cache tanpa fetch. null = tidak diketahui (JANGAN diganti email akun lain). */
export function peekAccountEmail(accountId: string | null): string | null {
  return emailCache.get(cacheKey(accountId))?.email ?? null
}

export async function fetchAccountEmail(account: UsageAccount): Promise<string | null> {
  const key = cacheKey(account.id)
  const cached = emailCache.get(key)
  if (cached && (!cached.retry || cached.email)) return cached.email

  const token = readToken(account)
  if (!token) {
    emailCache.set(key, { email: null, retry: false })
    return null
  }
  try {
    const res = await fetch(PROFILE_URL, { headers: authHeaders(token) })
    if (!res.ok) {
      // 403 (scope kurang) / 401 → permanen untuk token ini; 429/5xx → boleh dicoba lagi nanti.
      const retry = res.status !== 403 && res.status !== 401
      emailCache.set(key, { email: null, retry })
      return null
    }
    const j = (await res.json()) as { account?: { email?: string } }
    const email = j?.account?.email ?? null
    emailCache.set(key, { email, retry: email == null })
    return email
  } catch {
    emailCache.set(key, { email: null, retry: true })
    return null
  }
}
