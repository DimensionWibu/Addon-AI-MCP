// Ukur biaya token PREFIX Grove secara NYATA lewat query() SDK — bukan estimasi.
// Prompt sepele tanpa tool-call → 1 giliran → cache_creation (run dingin) ≈ ukuran prefix cacheable.
// Konfig:
//   bare      = preset claude_code polos                 → ≈ CLI / mode LITE
//   append    = + groveAppend('root')                    → biaya append protokol saja
//   full-root = + append('root') + 13 tool MCP grove     → mode ORKESTRATOR root (sekarang)
//   full-sub  = + append('sub')  + 13 tool               → mode ORKESTRATOR worker
// Tiap konfig dijalankan N kali (default 3): run-1 DINGIN (cache_creation = tulis prefix),
// run-2/3 HANGAT (cache_read = prefix sudah di-cache, ~0.1× harga) → sekaligus membuktikan
// caching. DELTA (konfig − bare) = overhead Grove murni.
// Model: HAIKU — hitungan token prefix identik lintas model Claude (tokenizer sama), jauh lebih murah.
// Jalankan: npx tsx test/token-cost.ts [N]
import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildGroveServer, type GroveHost } from '../src/main/orchestrator/mcpTools'
import { groveAppend } from '../src/main/orchestrator/prompts'

const MODEL = 'claude-haiku-4-5-20251001'
const PROMPT = 'Reply with exactly the single word READY and nothing else. Do not use any tools.'
const RUNS = Math.max(1, Number(process.argv[2]) || 3)

// Host palsu: buildGroveServer hanya menyimpan closure-nya; untuk prompt sepele tool tak pernah
// dipanggil, jadi method stub ini tak pernah dieksekusi.
const stubHost = new Proxy({}, { get: () => () => { throw new Error('stub host: not expected to be called') } }) as unknown as GroveHost

interface Usage { input: number; cacheCreation: number; cacheRead: number; output: number }
const blank = (): Usage => ({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0 })
// "prefix" = semua input yang diproses (fresh + tulis-cache + baca-cache). Yang kita banding.
const prefix = (u: Usage): number => u.input + u.cacheCreation + u.cacheRead

interface Cfg { name: string; append?: string; tools?: boolean }
const CONFIGS: Cfg[] = [
  { name: 'bare (≈CLI/Lite)' },
  { name: 'append(root)', append: groveAppend('root') },
  { name: 'full-root', append: groveAppend('root'), tools: true },
  { name: 'full-sub', append: groveAppend('sub'), tools: true }
]

async function runOnce(cfg: Cfg): Promise<Usage> {
  const server = cfg.tools ? buildGroveServer('measure', stubHost) : null
  const q = query({
    prompt: PROMPT,
    options: {
      model: MODEL,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        excludeDynamicSections: true,
        ...(cfg.append ? { append: cfg.append } : {})
      },
      settingSources: [], // tanpa CLAUDE.md dst → isolasi overhead Grove (konstan lintas konfig, ternetral di delta)
      ...(server ? { mcpServers: { grove: server } } : {})
    }
  })
  const u = blank()
  for await (const m of q as AsyncIterable<{ type: string; message?: { usage?: Record<string, number> } }>) {
    if (m.type === 'assistant' && m.message?.usage) {
      const g = m.message.usage
      u.input += g.input_tokens ?? 0
      u.cacheCreation += g.cache_creation_input_tokens ?? 0
      u.cacheRead += g.cache_read_input_tokens ?? 0
      u.output += g.output_tokens ?? 0
    }
    if (m.type === 'result') break
  }
  return u
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const num = (n: number, w = 7): string => String(n).padStart(w)

async function main(): Promise<void> {
  console.log(`\nModel: ${MODEL} · prompt sepele (no-tool) · ${RUNS} run/konfig\n`)
  console.log(`${pad('konfig', 20)} ${pad('run', 5)} ${pad('input', 8)} ${pad('cacheWr', 8)} ${pad('cacheRd', 8)} ${pad('output', 7)} ${pad('PREFIX', 8)}`)
  console.log('-'.repeat(72))
  const cold = new Map<string, number>() // prefix run-1 (dingin)
  const warm = new Map<string, number>() // prefix rata-rata run-2..N (hangat)
  for (const cfg of CONFIGS) {
    let warmSum = 0
    for (let i = 1; i <= RUNS; i++) {
      const u = await runOnce(cfg)
      const p = prefix(u)
      if (i === 1) cold.set(cfg.name, p)
      else warmSum += p
      const tag = i === 1 ? 'cold' : 'warm'
      console.log(`${pad(cfg.name, 20)} ${pad(`${i} ${tag}`, 5)} ${num(u.input, 8)} ${num(u.cacheCreation, 8)} ${num(u.cacheRead, 8)} ${num(u.output, 7)} ${num(p, 8)}`)
    }
    warm.set(cfg.name, RUNS > 1 ? Math.round(warmSum / (RUNS - 1)) : cold.get(cfg.name)!)
  }

  const bareCold = cold.get('bare (≈CLI/Lite)')!
  const bareWarm = warm.get('bare (≈CLI/Lite)')!
  console.log('\n=== OVERHEAD GROVE vs bare (CLI/Lite) ===')
  console.log(`${pad('konfig', 20)} ${pad('Δcold', 10)} ${pad('Δwarm/turn', 12)}`)
  console.log('-'.repeat(46))
  for (const cfg of CONFIGS) {
    const dc = cold.get(cfg.name)! - bareCold
    const dw = warm.get(cfg.name)! - bareWarm
    console.log(`${pad(cfg.name, 20)} ${pad(`+${dc}`, 10)} ${pad(`+${dw}`, 12)}`)
  }
  console.log(`\nbare prefix: cold=${bareCold} warm=${bareWarm}  (ini lantai CLI/Lite — Grove tak bisa < ini)`)
  console.log('Δcold = biaya sekali per konteks (giliran-1 / tiap worker baru / recycle).')
  console.log('Δwarm/turn = tambahan per giliran BERIKUTNYA (cache-read, ~0.1× harga input).')
  process.exit(0)
}

const guard = setTimeout(() => { console.error('TIMEOUT 4m'); process.exit(2) }, 240000)
main().catch((e) => { console.error('ERROR:', e); process.exit(1) }).finally(() => clearTimeout(guard))
