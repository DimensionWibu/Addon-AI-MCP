// Harness TASK-KOMPLEKS (skala dinaikkan): uji GATE delegasi + biaya NYATA orkestrasi, pada TOKEN
// akun tertentu (default ZoraCorp) — bukan login CLI ambient. 6 file kecil independen → "menggoda"
// dibagi 1-worker-per-file; padahal 1 konteks sanggup baca semua → delegasi = boros.
//   cmd = 1 query polos (preset)                → baseline CLI
//   gui = root orkestrator; spawn_worker BENAR2 jalan (query nested SUB), hasilnya di-plumb balik
//         via read_board/list_workers, biayanya dijumlah ke total pohon.
// Ukur: giliran root, jumlah spawn/worker, total token efektif pohon vs cmd.
// Model argv[2] (haiku|sonnet|opus). N argv[3]. Akun argv[4] label (default ZoraCorp).
// Jalankan: npx tsx test/complex-task.ts opus 1 ZoraCorp
import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildGroveServer, type GroveHost } from '../src/main/orchestrator/mcpTools'
import { groveAppend } from '../src/main/orchestrator/prompts'
import { Board } from '../src/main/orchestrator/db'
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODEL_ARG = (process.argv[2] || 'haiku').toLowerCase()
const MODEL = MODEL_ARG === 'opus' ? 'claude-opus-4-8' : MODEL_ARG === 'sonnet' ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001'
const RUNS = Math.max(1, Number(process.argv[3]) || 1)
const ACCOUNT = process.argv[4] || 'ZoraCorp'
const TASK =
  'Six files in the current directory (parser.js, cache.js, api.js, auth.js, logger.js, config.js) each contain exactly one bug. Analyze ALL six: for each, one sentence on what it does + the bug. Then two sentences on how they fit together as a system. Then stop.'

let AUTH_ENV: Record<string, string> = { ...(process.env as Record<string, string>) }
// Ambil token akun dari grove.sqlite. GAGAL (DB/akun tak ada) → JANGAN mati: jatuh ke login CLI
// ambient supaya harness tetap jalan di mesin lain.
async function loadToken(label: string): Promise<void> {
  const src = join(process.env.APPDATA || '', 'Grove', 'grove.sqlite')
  const dst = join(tmpdir(), 'grove-tok-copy.sqlite')
  let b: Board
  try {
    copyFileSync(src, dst) // salin → tak bentrok dgn Grove yang mungkin jalan (kita hanya baca, no flush)
    b = new Board(dst)
    await b.init()
  } catch {
    console.log(`Auth: grove.sqlite tak terbaca → pakai login CLI ambient`)
    return
  }
  const acc = b.getAccounts().find((a) => a.label.toLowerCase() === label.toLowerCase())
  const tok = acc ? b.getAccountToken(acc.id) : null
  if (!acc || !tok) {
    console.log(`Auth: akun "${label}" tak ada/tanpa token (ada: ${b.getAccounts().map((a) => a.label).join(', ') || '-'}) → pakai login CLI ambient`)
    return
  }
  // Mirror getSessionLaunch (akun claude): token OAuth langganan, buang ANTHROPIC_* agar tak menang.
  AUTH_ENV = { ...(process.env as Record<string, string>), CLAUDE_CODE_OAUTH_TOKEN: tok }
  delete AUTH_ENV.ANTHROPIC_API_KEY
  delete AUTH_ENV.ANTHROPIC_AUTH_TOKEN
  delete AUTH_ENV.ANTHROPIC_BASE_URL
  console.log(`Auth: akun "${acc.label}" (token …${tok.slice(-6)}, plan ${acc.plan ?? '-'})`)
}

interface Res { turns: number; input: number; cacheWr: number; cacheRd: number; output: number }
const blank = (): Res => ({ turns: 0, input: 0, cacheWr: 0, cacheRd: 0, output: 0 })
const add = (a: Res, b: Res): void => { a.turns += b.turns; a.input += b.input; a.cacheWr += b.cacheWr; a.cacheRd += b.cacheRd; a.output += b.output }
const eff = (r: Res): number => Math.round(r.input + 1.25 * r.cacheWr + 0.1 * r.cacheRd + 5 * r.output)

async function runQuery(prompt: string, cfg: { role?: 'root' | 'sub'; host?: GroveHost }, cwd: string): Promise<{ res: Res; text: string }> {
  const server = cfg.host ? buildGroveServer('measure', cfg.host) : null
  const q = query({
    prompt,
    options: {
      model: MODEL,
      cwd,
      env: AUTH_ENV,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true, ...(cfg.role ? { append: groveAppend(cfg.role) } : {}) },
      settingSources: ['user', 'project', 'local'],
      ...(server ? { mcpServers: { grove: server } } : {})
    }
  })
  const res = blank()
  let text = ''
  for await (const m of q as AsyncIterable<{ type: string; message?: { usage?: Record<string, number>; content?: { type: string; text?: string }[] } }>) {
    if (m.type === 'assistant') {
      res.turns++
      const u = m.message?.usage
      if (u) { res.input += u.input_tokens ?? 0; res.cacheWr += u.cache_creation_input_tokens ?? 0; res.cacheRd += u.cache_read_input_tokens ?? 0; res.output += u.output_tokens ?? 0 }
      for (const b of m.message?.content ?? []) if (b.type === 'text' && b.text) text = b.text
    }
    if (m.type === 'result') break
  }
  return { res, text }
}

// Host root: spawn_worker → jalankan worker NYATA (query nested SUB, host-nya TAK boleh spawn), jumlah
// biayanya, simpan hasil → read_board/list_workers memaparkannya balik agar root bisa sintesa & selesai.
function orchestratorHost(cwd: string, tree: Res, counters: { spawns: number; workers: number }): GroveHost {
  const workers: { id: string; title: string; summary: string }[] = []
  const workerHost = new Proxy({}, { get: (_t, q2: string) => async () => (q2 === 'spawnWorker' ? 'refused (max depth)' : ['readBoard', 'listWorkers', 'readMessages'].includes(q2) ? [] : undefined) }) as unknown as GroveHost
  const runW = async (task: string, title: string): Promise<string> => {
    counters.spawns++; counters.workers++
    const id = `w${counters.workers}`
    const { res, text } = await runQuery(task, { role: 'sub', host: workerHost }, cwd)
    add(tree, res)
    workers.push({ id, title, summary: text.slice(0, 400) })
    return id
  }
  return new Proxy({}, {
    get: (_t, p: string) => async (...a: unknown[]) => {
      if (p === 'spawnWorker') { const o = a[1] as { title: string; task: string }; return runW(o.task, o.title) }
      if (p === 'assignToWorker') { const task = a[2] as string; await runW(task, 'assigned'); return undefined }
      if (p === 'readBoard') return workers.map((w) => ({ sessionId: w.id, summary: w.summary, todo: [], progress: 'done', percent: 100, updatedAt: Date.now(), title: w.title, treeId: 'measure', role: 'sub', status: 'idle' }))
      if (p === 'listWorkers') return workers.map((w) => ({ id: w.id, title: w.title, role: 'sub', status: 'idle' }))
      if (p === 'readMessages') return []
      return undefined
    }
  }) as unknown as GroveHost
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))

async function main(): Promise<void> {
  await loadToken(ACCOUNT)
  const dir = mkdtempSync(join(tmpdir(), 'grove-cx-'))
  const F: Record<string, string> = {
    'parser.js': 'function parse(s){ return s.split(",") } // bug: tak trim spasi tiap elemen\nmodule.exports={parse}\n',
    'cache.js': 'const m={}; const get=k=>m[k]; const set=(k,v)=>{m[k]=v}\n// bug: tak ada eviction / batas ukuran → memory leak\nmodule.exports={get,set}\n',
    'api.js': 'const {parse}=require("./parser"); const {get,set}=require("./cache")\nfunction handle(q){ if(get(q)) return get(q); const r=parse(q); set(q,r); return r }\n// bug: key cache = query mentah, tak dinormalisasi\nmodule.exports={handle}\n',
    'auth.js': 'function check(tok){ return tok == "secret" } // bug: == longgar + secret hardcoded\nmodule.exports={check}\n',
    'logger.js': 'function log(x){ console.log(new Date()+" "+x) } // bug: new Date() argless nondeterministik utk test\nmodule.exports={log}\n',
    'config.js': 'let cfg=null; function load(){ if(!cfg) cfg=require("./settings.json"); return cfg } // bug: settings.json tak ada → throw\nmodule.exports={load}\n'
  }
  for (const [name, body] of Object.entries(F)) writeFileSync(join(dir, name), body)
  console.log(`Model ${MODEL} · task 6-file (menggoda delegasi) · ${RUNS} run/konfig · cwd=${dir}\n`)

  const acc = { cmd: blank(), gui: blank() }
  const cnt = { spawns: 0, workers: 0 }
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`  cmd run ${i + 1}… `)
    const c = await runQuery(TASK, {}, dir)
    add(acc.cmd, c.res); console.log(`turns=${c.res.turns} eff=${eff(c.res)}`)

    process.stdout.write(`  gui run ${i + 1}… `)
    const tree = blank(); const cc = { spawns: 0, workers: 0 }
    const g = await runQuery(TASK, { role: 'root', host: orchestratorHost(dir, tree, cc) }, dir)
    add(tree, g.res); add(acc.gui, tree); cnt.spawns += cc.spawns; cnt.workers += cc.workers
    console.log(`rootTurns=${g.res.turns} spawns=${cc.spawns} treeEff=${eff(tree)}`)
  }

  const norm = (r: Res): Res => ({ turns: +(r.turns / RUNS).toFixed(1), input: Math.round(r.input / RUNS), cacheWr: Math.round(r.cacheWr / RUNS), cacheRd: Math.round(r.cacheRd / RUNS), output: Math.round(r.output / RUNS) })
  const cmd = norm(acc.cmd), gui = norm(acc.gui)
  console.log(`\n${pad('konfig', 24)} ${pad('turns', 7)} ${pad('output', 7)} ${pad('eff~', 9)}`)
  console.log('-'.repeat(52))
  console.log(`${pad('cmd (CLI, 1 konteks)', 24)} ${pad(String(cmd.turns), 7)} ${pad(String(cmd.output), 7)} ${pad(String(eff(cmd)), 9)}`)
  console.log(`${pad('gui (Orkestrator+worker)', 24)} ${pad(String(gui.turns), 7)} ${pad(String(gui.output), 7)} ${pad(String(eff(gui)), 9)}`)
  const ratio = eff(cmd) > 0 ? (eff(gui) / eff(cmd)).toFixed(2) : '—'
  console.log(`\nspawn rata-rata = ${(cnt.spawns / RUNS).toFixed(1)} · worker = ${(cnt.workers / RUNS).toFixed(1)} · GUI/CMD efektif = ${ratio}×`)
  console.log('Gate BEKERJA → spawn≈0 & rasio≈1. Gate GAGAL → spawn>0 & rasio ≫ 1 (biaya worker lifecycle).')
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows lock */ }
  process.exit(0)
}

const guard = setTimeout(() => { console.error('TIMEOUT 9m'); process.exit(2) }, 540000)
main().catch((e) => { console.error('ERROR:', e); process.exit(1) }).finally(() => clearTimeout(guard))
