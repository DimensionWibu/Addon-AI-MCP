// Ambil limit paket langganan Claude via endpoint OAuth internal (sama seperti CLI).
// Token HANYA hidup di main-process — tak pernah dikirim ke renderer. Email BOLEH (bukan rahasia).
//
// Usage selalu diambil PER AKUN: pemanggil menyerahkan token akun yang dimaksud
// (dari DB, lihat SessionManager.getSessionAccountInfo). Untuk akun "default"
// (login utama CLI) token-nya dibaca dari ~/.claude/.credentials.json seperti dulu.
//
// SCOPE (hasil probe 2026-07-19, dikoreksi 2026-07-20 — jangan dihapus tanpa uji ulang):
// kedua endpoint OAuth di bawah menuntut scope `user:profile`. Login utama (hasil `claude login`)
// punya scope itu; token dari `claude setup-token` TIDAK — jawabannya 403 "OAuth token does not
// meet scope requirement". Keduanya sama-sama berformat sk-ant-oat01-…, jadi format BUKAN penanda.
//
// TAPI 403 itu BUKAN akhir cerita untuk usage: header `anthropic-ratelimit-unified-*` pada respons
// Messages API memuat utilisasi 5-jam & 7-hari, dan TIDAK menuntut scope `user:profile` — terbukti
// terisi untuk token setup-token (probe 2026-07-20, 200 OK). fetchUsageFromHeaders() memakainya
// sebagai cadangan, sehingga akun setup-token tetap bisa dipantau & di-auto-switch.
// EMAIL tetap tak bisa didapat untuk token semacam itu (hanya /oauth/profile yang menyediakannya).
// Kita selalu tampilkan apa adanya (lihat UsageUnavailable) dan TIDAK PERNAH jatuh ke angka/email
// login utama — angka akun A tak boleh muncul sebagai milik akun B.
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

// Probe header rate-limit (lihat fetchUsageFromHeaders). Model termurah + max_tokens=1 supaya
// biayanya mendekati nol; UA & system prompt meniru CLI karena token OAuth langganan hanya
// dilayani untuk klien Claude Code — request "telanjang" ditolak.
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const PROBE_MODEL = 'claude-haiku-4-5-20251001'
const CLI_UA = 'claude-cli/2.0.0 (external, cli)'
const CLI_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

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

/**
 * JALUR KEDUA untuk usage: header rate-limit pada respons Messages API.
 *
 * Kenapa perlu: /oauth/usage menuntut scope `user:profile`, yang TIDAK dimiliki token hasil
 * `claude setup-token` → 403, sehingga akun-akun itu dulu tak bisa dipantau sama sekali dan
 * ambang auto-switch-nya mustahil memicu. Header di bawah TIDAK menuntut scope itu dan
 * terbukti terisi untuk token setup-token (diprobe 2026-07-20, ketiga akun membalas 200).
 *
 * Biayanya nyata tapi kecil: satu request max_tokens=1 per akun per siklus poll (5 menit).
 * Karena itu ia dipakai sebagai CADANGAN — hanya saat endpoint resmi menolak — bukan pengganti.
 * Datanya lebih miskin dari /oauth/usage (tak ada rincian opus/sonnet & kuota bulanan), jadi
 * field-field itu sengaja dibiarkan undefined ketimbang diisi tebakan.
 */
async function fetchUsageFromHeaders(token: string): Promise<UsageResult> {
  try {
    const res = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { ...authHeaders(token), 'anthropic-version': '2023-06-01', 'user-agent': CLI_UA },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        system: [{ type: 'text', text: CLI_SYSTEM }],
        messages: [{ role: 'user', content: 'hi' }]
      })
    })
    // Header limit ikut terkirim pada 200 MAUPUN 429 — justru saat 429 angkanya paling penting.
    const util = (w: string): number | null => {
      const v = res.headers.get(`anthropic-ratelimit-unified-${w}-utilization`)
      const n = v == null ? NaN : Number(v)
      return Number.isFinite(n) ? n * 100 : null // header memakai 0..1, UI memakai persen
    }
    const reset = (w: string): string | null => {
      const v = res.headers.get(`anthropic-ratelimit-unified-${w}-reset`)
      const n = v == null ? NaN : Number(v)
      return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null // unix detik → ISO
    }
    const five = util('5h')
    if (five == null) return { usage: null, reason: res.ok ? 'error' : reasonFor(res.status) }
    return {
      usage: {
        fiveHour: { utilization: five, resetsAt: reset('5h') },
        sevenDay: { utilization: util('7d'), resetsAt: reset('7d') },
        fetchedAt: Date.now()
      }
    }
  } catch {
    return { usage: null, reason: 'error' }
  }
}

async function fetchUsageRaw(account: UsageAccount): Promise<UsageResult> {
  const token = readToken(account)
  if (!token) return { usage: null, reason: 'no-token' }
  try {
    const res = await fetch(USAGE_URL, { headers: authHeaders(token) })
    // Semua kegagalan yang MASIH mungkin ditolong jalur header:
    //   403/401 = token tanpa scope user:profile (kasus setup-token)
    //   429     = endpoint /oauth/usage sedang membatasi kita — bukan berarti akunnya kenapa-kenapa,
    //             dan header rate-limit tetap terkirim (terbukti: ZoraSupport 429 di sini, 200 di sana)
    if (res.status === 403 || res.status === 401 || res.status === 429) {
      const viaHeaders = await fetchUsageFromHeaders(token)
      if (viaHeaders.usage) return viaHeaders
      return { usage: null, reason: reasonFor(res.status) }
    }
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
