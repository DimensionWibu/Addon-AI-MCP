// Ambil limit paket langganan Claude via endpoint OAuth internal (sama seperti CLI).
// Token dibaca dari %USERPROFILE%\.claude\.credentials.json, hanya dipakai di main-process.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageInfo, UsageWindow } from '../shared/types'

function readToken(): string | null {
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

const toWindow = (x: { utilization?: number; resets_at?: string } | undefined): UsageWindow => ({
  utilization: x?.utilization ?? null,
  resetsAt: x?.resets_at ?? null
})

// Cache nilai sukses terakhir. Token OAuth expired ~tiap jam → fetch bisa 401 sesaat;
// alih-alih mengosongkan UI, kembalikan last-good bertanda stale sampai token segar lagi.
let lastGood: UsageInfo | null = null

export async function fetchUsage(): Promise<UsageInfo | null> {
  const fresh = await fetchUsageRaw()
  if (fresh) {
    lastGood = fresh
    return fresh
  }
  return lastGood ? { ...lastGood, stale: true } : null
}

async function fetchUsageRaw(): Promise<UsageInfo | null> {
  const token = readToken()
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
