// Tes LIVE multi-akun: buktikan (a) tiap token = akun berbeda, (b) inject
// CLAUDE_CODE_OAUTH_TOKEN via options.env benar-benar memakai akun itu (billing pindah).
// Jalankan: npx tsx test/switch-live.ts
import { Board } from '../src/main/orchestrator/db'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface Usage {
  five_hour?: { utilization?: number; resets_at?: string }
  seven_day?: { utilization?: number }
}

async function fetchUsage(token: string): Promise<{ ok: boolean; status: number; u?: Usage }> {
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }
    })
    if (!r.ok) return { ok: false, status: r.status }
    return { ok: true, status: r.status, u: (await r.json()) as Usage }
  } catch (e) {
    console.log('   fetch error:', (e as Error).message)
    return { ok: false, status: 0 }
  }
}

const pct = (v?: number): string => (v == null ? '—' : `${Math.round(v)}%`)

/** Query minimal dengan token tertentu; kembalikan teks + token output + indikasi limit. */
async function tinyQuery(token: string | null, cwd: string): Promise<{ text: string; out: number; limited: boolean }> {
  const q = query({
    prompt: 'Reply with exactly: OK',
    options: {
      cwd,
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(token ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } as Record<string, string> } : {})
    }
  })
  let text = ''
  let out = 0
  try {
    for await (const m of q as AsyncIterable<Record<string, unknown>>) {
      if (m.type === 'assistant') {
        const msg = m.message as { content?: { type: string; text?: string }[]; usage?: { output_tokens?: number } }
        for (const b of msg?.content ?? []) if (b.type === 'text' && b.text) text += b.text
        out += msg?.usage?.output_tokens ?? 0
      }
    }
  } catch (e) {
    text += ` [error: ${(e as Error).message.slice(0, 120)}]`
  }
  const limited = /(hit|reached|exceeded)\s+your\s+[\w\s-]*limit|limit\s*·\s*resets/i.test(text)
  return { text: text.trim().slice(0, 160), out, limited }
}

async function main(): Promise<void> {
  const board = new Board(join(homedir(), 'AppData', 'Roaming', 'Grove', 'grove.sqlite'))
  await board.init()
  const accounts = board.getAccounts()
  console.log(`Akun tersimpan: ${accounts.length}\n`)
  if (accounts.length < 2) {
    console.log('Butuh ≥2 akun untuk tes switch.')
    process.exit(1)
  }

  console.log('=== 1) Identitas & usage tiap token (SEBELUM) ===')
  const before = new Map<string, Usage | undefined>()
  for (const a of accounts) {
    const tok = board.getAccountToken(a.id)!
    const r = await fetchUsage(tok)
    before.set(a.id, r.u)
    console.log(
      `  ${a.label.padEnd(14)} token…${tok.slice(-6)}  http=${r.status}  5jam=${pct(r.u?.five_hour?.utilization)}  minggu=${pct(r.u?.seven_day?.utilization)}  reset=${r.u?.five_hour?.resets_at ?? '—'}`
    )
  }

  console.log('\n=== 2) Query kecil per akun (inject CLAUDE_CODE_OAUTH_TOKEN) ===')
  const cwd = process.cwd()
  for (const a of accounts) {
    const tok = board.getAccountToken(a.id)!
    const r = await tinyQuery(tok, cwd)
    console.log(`  ${a.label.padEnd(14)} → out=${r.out} tok | limited=${r.limited} | "${r.text}"`)
  }

  console.log('\n=== 3) Usage SESUDAH (yang naik = akun yang tertagih) ===')
  for (const a of accounts) {
    const tok = board.getAccountToken(a.id)!
    const r = await fetchUsage(tok)
    const b = before.get(a.id)
    const d = (x?: number, y?: number): string =>
      x == null || y == null ? '?' : `${(y - x >= 0 ? '+' : '') + (y - x).toFixed(2)}`
    console.log(
      `  ${a.label.padEnd(14)} 5jam ${pct(b?.five_hour?.utilization)} → ${pct(r.u?.five_hour?.utilization)} (${d(b?.five_hour?.utilization, r.u?.five_hour?.utilization)})`
    )
  }
  process.exit(0)
}
void main()
