// BENCHMARK akun DeepSeek di Grove: kecerdasan (reasoning + tool), biaya token, dan efek mode LITE
// vs ORKESTRATOR (MCP grove + protokol multi-agent) — memakai jalur yang SAMA dengan Session.ts.
//   DEEPSEEK_API_KEY=sk-... npx tsx test/deepseek-bench.ts
// Opsional: BENCH_MODELS="deepseek-v4-pro,deepseek-v4-flash"
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildGroveServer, type GroveHost } from '../src/main/orchestrator/mcpTools'
import { groveAppend } from '../src/main/orchestrator/prompts'
import { skinBaseUrl } from '../src/shared/types'

const KEY = process.env.DEEPSEEK_API_KEY || ''
if (!KEY) {
  console.error('Set DEEPSEEK_API_KEY dulu.')
  process.exit(2)
}
const MODELS = (process.env.BENCH_MODELS || 'deepseek-v4-pro,deepseek-v4-flash').split(',').map((s) => s.trim())

/** Host tiruan: tool orkestrasi tak boleh benar-benar mengubah apa pun saat benchmark. */
const stubHost = new Proxy({} as GroveHost, {
  get: (_t, prop) => {
    if (prop === 'readBoard' || prop === 'readMessages' || prop === 'listWorkers') return () => []
    if (prop === 'getSessionToken') return () => KEY
    if (prop === 'getSessionModel') return () => undefined
    if (prop === 'getSessionLaunch') return () => null
    return () => undefined
  }
})

function envFor(model: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  env.ANTHROPIC_BASE_URL = skinBaseUrl('deepseek')
  env.ANTHROPIC_AUTH_TOKEN = KEY
  env.ANTHROPIC_MODEL = model
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model.replace(/-pro$/, '-flash')
  env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

interface Task {
  id: string
  prompt: string
  /** null = tak dinilai benar/salah (hanya diukur biayanya). */
  grade: ((text: string, dir: string) => boolean) | null
  kind: 'reasoning' | 'tool' | 'chat'
}

const TASKS: Task[] = [
  {
    id: 'chat',
    kind: 'chat',
    prompt: 'Jawab dalam SATU kalimat pendek: apa gunanya cache prompt untuk agen coding?',
    grade: null
  },
  {
    id: 'r1-kongruen',
    kind: 'reasoning',
    prompt:
      'Berapa bilangan bulat positif TERKECIL yang bersisa 1 ketika dibagi 2, 3, 4, 5, dan 6, tetapi habis dibagi 7? Jawab dengan angka saja di baris terakhir.',
    grade: (t) => /\b301\b/.test(t)
  },
  {
    id: 'r2-jebakan',
    kind: 'reasoning',
    prompt:
      'Jika 3 mesin membuat 3 widget dalam 3 menit, berapa menit yang dibutuhkan 100 mesin untuk membuat 100 widget? Jawab angka menit saja di baris terakhir.',
    grade: (t) => /(^|\D)3(\s*menit|\D*$)/i.test(t.trim().split('\n').slice(-3).join(' '))
  },
  {
    id: 'r3-bug',
    kind: 'reasoning',
    prompt:
      'Kode ini seharusnya mengembalikan elemen terbesar KEDUA dari array angka berbeda, tapi salah:\n' +
      '```js\nfunction second(a){ let m=-Infinity, s=-Infinity; for(const x of a){ if(x>m){ m=x } else if(x>s){ s=x } } return s }\n```\n' +
      'Untuk input [5,1,9,3] hasilnya salah. Sebutkan NILAI yang dikembalikan kode ini untuk input itu, lalu tulis perbaikannya. Mulai jawaban dengan "HASIL SALAH: <angka>".',
    // Bug: saat x>m, s tak di-update dgn m lama → second([5,1,9,3]) = 3 (bukan 5).
    grade: (t) => /HASIL SALAH:\s*3\b/i.test(t)
  },
  {
    id: 'tool-fib',
    kind: 'tool',
    prompt:
      'Pakai tool, tanpa bertanya: buat file fib.js di folder kerja yang mencetak suku ke-30 deret Fibonacci ' +
      '(fib(1)=1, fib(2)=1), jalankan dengan node, lalu tulis hasilnya ke jawabanmu dengan format "HASIL: <angka>".',
    grade: (t, dir) => /HASIL:\s*832040\b/.test(t) && existsSync(join(dir, 'fib.js'))
  }
]

interface Run {
  model: string
  mode: 'lite' | 'orkestrator'
  task: string
  ok: boolean | null
  sec: number
  input: number
  cacheRead: number
  cacheCreate: number
  output: number
  turns: number
  thinkChars: number
  tools: string[]
  answer: string
}

async function runOne(model: string, mode: 'lite' | 'orkestrator', task: Task): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bench-'))
  const lite = mode === 'lite'
  const t0 = Date.now()
  const q = query({
    prompt: task.prompt,
    options: {
      model,
      cwd: dir,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: lite ? '' : groveAppend('root'),
        excludeDynamicSections: true
      },
      settingSources: [],
      ...(lite ? {} : { mcpServers: { grove: buildGroveServer('bench', stubHost) } }),
      env: envFor(model)
    }
  })
  const r: Run = {
    model,
    mode,
    task: task.id,
    ok: null,
    sec: 0,
    input: 0,
    cacheRead: 0,
    cacheCreate: 0,
    output: 0,
    turns: 0,
    thinkChars: 0,
    tools: [],
    answer: ''
  }
  try {
    for await (const m of q as AsyncIterable<Record<string, unknown>>) {
      const type = String(m.type)
      if (type === 'assistant') {
        const content = (m.message as { content?: Array<Record<string, unknown>> })?.content ?? []
        for (const b of content) {
          if (b.type === 'tool_use') r.tools.push(String(b.name))
          if (b.type === 'text') r.answer += String(b.text)
          if (b.type === 'thinking') r.thinkChars += String(b.thinking ?? '').length
        }
      }
      if (type === 'result') {
        const u = (m.usage ?? {}) as Record<string, number>
        r.input = u.input_tokens ?? 0
        r.cacheRead = u.cache_read_input_tokens ?? 0
        r.cacheCreate = u.cache_creation_input_tokens ?? 0
        r.output = u.output_tokens ?? 0
        r.turns = Number(m.num_turns ?? 0)
        if (String(m.subtype) !== 'success') r.answer += `\n[SUBTYPE ${String(m.subtype)}]`
        break
      }
    }
  } catch (e) {
    r.answer += `\n[ERROR ${String(e)}]`
  }
  r.sec = Math.round(((Date.now() - t0) / 1000) * 10) / 10
  r.ok = task.grade ? task.grade(r.answer, dir) : null
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* windows lock */
  }
  return r
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

async function main(): Promise<void> {
  const runs: Run[] = []
  for (const model of MODELS) {
    for (const task of TASKS) {
      const r = await runOne(model, 'lite', task)
      runs.push(r)
      console.log(
        `${r.model.padEnd(18)} lite        ${r.task.padEnd(12)} ${r.ok === null ? ' -' : r.ok ? 'OK' : 'X '} ${String(r.sec).padStart(5)}s  in=${fmt(
          r.input
        )} cacheR=${fmt(r.cacheRead)} out=${fmt(r.output)} turns=${r.turns} think=${fmt(r.thinkChars)}ch`
      )
    }
    // Overhead mode ORKESTRATOR (MCP grove + protokol) diukur pada tugas yang sama.
    for (const task of TASKS.filter((t) => t.id === 'chat' || t.id === 'tool-fib')) {
      const r = await runOne(model, 'orkestrator', task)
      runs.push(r)
      console.log(
        `${r.model.padEnd(18)} orkestrator ${r.task.padEnd(12)} ${r.ok === null ? ' -' : r.ok ? 'OK' : 'X '} ${String(r.sec).padStart(5)}s  in=${fmt(
          r.input
        )} cacheR=${fmt(r.cacheRead)} out=${fmt(r.output)} turns=${r.turns} think=${fmt(r.thinkChars)}ch`
      )
    }
  }
  console.log('\n=== JSON ===')
  console.log(JSON.stringify(runs, null, 1))
  const graded = runs.filter((r) => r.ok !== null)
  for (const model of MODELS) {
    const g = graded.filter((r) => r.model === model)
    console.log(`\n${model}: benar ${g.filter((r) => r.ok).length}/${g.length}`)
  }
}

void main()
