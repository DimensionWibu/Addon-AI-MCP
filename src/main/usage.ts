// Ambil limit paket langganan Claude via endpoint OAuth internal (sama seperti CLI).
// Token HANYA hidup di main-process — tak pernah dikirim ke renderer.
//
// Usage selalu diambil PER AKUN: pemanggil menyerahkan token akun yang dimaksud
// (dari DB, lihat SessionManager.getSessionAccountInfo). Untuk akun "default"
// (login utama CLI) token-nya dibaca dari ~/.claude/.credentials.json seperti dulu.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageInfo, UsageWindow } from '../shared/types'

/** Identitas akun untuk fetch. id null = login utama; selain itu token WAJIB dari DB. */
export interface UsageAccount {
  id: string | null
  token: string | null
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
 * kalau tokennya hilang/ditolak kita lebih baik tak menampilkan apa-apa daripada
 * menampilkan angka milik login utama (itu persis bug yang sedang diperbaiki).
 */
function readToken(account: UsageAccount): string | null {
  if (account.id) return account.token
  return account.token ?? readDefaultToken()
}

const toWindow = (x: { utilization?: number; resets_at?: string } | undefined): UsageWindow => ({
  utilization: x?.utilization ?? null,
  resetsAt: x?.resets_at ?? null
})

// Cache nilai sukses terakhir PER AKUN. Token OAuth expired ~tiap jam → fetch bisa 401 sesaat;
// alih-alih mengosongkan UI, kembalikan last-good bertanda stale sampai token segar lagi.
// WAJIB per-akun: kalau satu variabel global, pindah sesi akan memperlihatkan angka akun
// SEBELUMNYA (ditandai stale) — kebingungan yang justru ingin kita hilangkan.
const lastGood = new Map<string, UsageInfo>()

const cacheKey = (accountId: string | null): string => accountId ?? 'default'

/** Nilai cache akun ini tanpa fetch (dipakai saat pindah sesi supaya UI langsung benar). */
export function peekUsage(accountId: string | null): UsageInfo | null {
  return lastGood.get(cacheKey(accountId)) ?? null
}

export async function fetchUsage(account: UsageAccount): Promise<UsageInfo | null> {
  const key = cacheKey(account.id)
  const fresh = await fetchUsageRaw(account)
  if (fresh) {
    lastGood.set(key, fresh)
    return fresh
  }
  const prev = lastGood.get(key)
  return prev ? { ...prev, stale: true } : null
}

async function fetchUsageRaw(account: UsageAccount): Promise<UsageInfo | null> {
  const token = readToken(account)
  if (!token) return null
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json'
      }
    })
    if (!res.ok) return null
    const d = (await res.json()) as Record<string, never>
    const eu = (d as Record<string, { is_enabled?: boolean; monthly_limit?: number; used_credits?: number; utilization?: number; currency?: string }>)
      .extra_usage
    return {
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
  } catch {
    return null
  }
}
