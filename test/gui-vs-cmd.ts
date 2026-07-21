// Perbandingan usage NYATA: task yang SAMA dijalankan sebagai "CMD" (preset claude_code polos, =
// mode Lite / CLI) vs "GUI" (mode Orkestrator: + groveAppend + 13 tool MCP grove). Task memicu >1
// giliran (baca file → jawab) supaya efek PENGGANDA giliran (bookkeeping) kelihatan — bukan cuma prefix.
// Ukur: jumlah giliran, tool-call, panggilan bookkeeping/spawn, dan token (raw + estimasi efektif).
// Model HAIKU (murah; gap RELATIF antar-konfig representatif). Jalankan: npx tsx test/gui-vs-cmd.ts [N]
import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildGroveServer, type GroveHost } from '../src/main/orchestrator/mcpTools'
import { groveAppend } from '../src/main/orchestrator/prompts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODEL = 'claude-haiku-4-5-20251001'
const RUNS = Math.max(1, Number(process.argv[2]) || 2)
const TASK =
  'The file bug.js in the current working directory contains exactly one bug. Read it, then state the bug in ONE short sentence. Then stop.'

// Host perekam: tool bookkeeping no-op sukses; read* → []; spawn → id palsu seketika (tak menggantung).
// Kita UKUR apakah model memanggilnya, tanpa menjalankan orkestrasi nyata.
function recordingHost(): { host: GroveHost; calls: Record<string, number> } {
  const calls: Record<string, number> = {}
  const READS = new Set(['readBoard', 'listWorkers', 'readMessages'])
  const host = new Proxy(
    {},
    {
      get: (_t, p: string) => (..._a: unknown[]) => {
        calls[p] = (calls[p] ?? 0) + 1
        if (p === 'spawnWorker') return Promise.resolve('stub-worker-id')
        if (READS.has(p)) return []
        if (p === 'getSessionToken') return null
        return undefined
      }
    }
  ) as unknown as GroveHost
  return { host, calls }
}

interface Res {
  turns: number
  toolCalls: number
  input: number
  cacheWr: number
  cacheRd: number
  output: number
  book: number // total panggilan tool bookkeeping/koordinasi grove
  spawns: number
}
const blank = (): Res => ({ turns: 0, toolCalls: 0, input: 0, cacheWr: 0, cacheRd: 0, output: 0, book: 0, spawns: 0 })
// Estimasi token EFEKTIF (biaya nyata): cache-write 1.25×, cache-read 0.1×, output 5× harga input.
const eff = (r: Res): number => Math.round(r.input + 1.25 * r.cacheWr + 0.1 * r.cacheRd + 5 * r.output)

async function runOnce(cfg: { grove?: boolean }, cwd: string): Promise<Res> {
  const rec = cfg.grove ? recordingHost() : null
  const server = rec ? buildGroveServer('measure', rec.host) : null
  const q = query({
    prompt: TASK,
    options: {
      model: MODEL,
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        excludeDynamicSections: true,
        ...(cfg.grove ? { append: groveAppend('root') } : {})
      },
      settingSources: ['user', 'project', 'local'], // sama utk kedua konfig → beda murni = grove
      ...(server ? { mcpServers: { grove: server } } : {})
    }
  })
  const r = blank()
  for await (const m of q as AsyncIterable<{
    type: string
    message?: { usage?: Record<string, number>; content?: { type: string; name?: string }[] }
  }>) {
    if (m.type === 'assistant') {
      r.turns++
      const u = m.message?.usage
      if (u) {
        r.input += u.input_tokens ?? 0
        r.cacheWr += u.cache_creation_input_tokens ?? 0
        r.cacheRd += u.cache_read_input_tokens ?? 0
        r.output += u.output_tokens ?? 0
      }
      for (const b of m.message?.content ?? []) if (b.type === 'tool_use') r.toolCalls++
    }
    if (m.type === 'result') break
  }
  if (rec) {
    const bk = ['setTitle', 'updateSummary', 'updateTodo', 'reportProgress', 'reportToParent', 'sendMessage']
    r.book = bk.reduce((s, k) => s + (rec.calls[k] ?? 0), 0)
    r.spawns = (rec.calls.spawnWorker ?? 0) + (rec.calls.assignToWorker ?? 0)
  }
  return r
}

const avg = (xs: Res[]): Res => {
  const a = blank()
  for (const x of xs) { a.turns += x.turns; a.toolCalls += x.toolCalls; a.input += x.input; a.cacheWr += x.cacheWr; a.cacheRd += x.cacheRd; a.output += x.output; a.book += x.book; a.spawns += x.spawns }
  const n = xs.length
  return { turns: +(a.turns / n).toFixed(1), toolCalls: +(a.toolCalls / n).toFixed(1), input: Math.round(a.input / n), cacheWr: Math.round(a.cacheWr / n), cacheRd: Math.round(a.cacheRd / n), output: Math.round(a.output / n), book: +(a.book / n).toFixed(1), spawns: +(a.spawns / n).toFixed(1) }
}
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'grove-cmp-'))
  writeFileSync(join(dir, 'bug.js'), 'function add(a, b) { return a - b } // should be a + b\nmodule.exports = { add }\n')
  console.log(`\nModel ${MODEL} · task baca+jawab · ${RUNS} run/konfig · cwd=${dir}\n`)

  const out: Record<string, Res> = {}
  for (const [name, cfg] of [['cmd (=Lite/CLI)', {}], ['gui (Orkestrator)', { grove: true }]] as const) {
    const runs: Res[] = []
    for (let i = 0; i < RUNS; i++) {
      process.stdout.write(`  ${name} run ${i + 1}/${RUNS}… `)
      const r = await runOnce(cfg, dir)
      console.log(`turns=${r.turns} tools=${r.toolCalls} book=${r.book} spawns=${r.spawns} eff=${eff(r)}`)
      runs.push(r)
    }
    out[name] = avg(runs)
  }

  console.log(`\n${pad('konfig', 20)} ${pad('turns', 6)} ${pad('tools', 6)} ${pad('book', 6)} ${pad('spawn', 6)} ${pad('output', 7)} ${pad('eff~', 8)}`)
  console.log('-'.repeat(64))
  for (const k of Object.keys(out)) {
    const r = out[k]
    console.log(`${pad(k, 20)} ${pad(String(r.turns), 6)} ${pad(String(r.toolCalls), 6)} ${pad(String(r.book), 6)} ${pad(String(r.spawns), 6)} ${pad(String(r.output), 7)} ${pad(String(eff(r)), 8)}`)
  }
  const cmd = out['cmd (=Lite/CLI)'], gui = out['gui (Orkestrator)']
  const ratio = eff(cmd) > 0 ? (eff(gui) / eff(cmd)).toFixed(2) : '—'
  console.log(`\nGUI/CMD efektif = ${ratio}×  · Δturns=${(gui.turns - cmd.turns).toFixed(1)}  · Δoutput=${gui.output - cmd.output}`)
  console.log('Target: rasio → mendekati 1.0 & Δturns → 0 (bookkeeping tak menambah giliran).')
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows lock */ }
  process.exit(0)
}

const guard = setTimeout(() => { console.error('TIMEOUT 5m'); process.exit(2) }, 300000)
main().catch((e) => { console.error('ERROR:', e); process.exit(1) }).finally(() => clearTimeout(guard))
