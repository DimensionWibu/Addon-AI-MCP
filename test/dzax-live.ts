// UJI HIDUP gateway DZAX (Belo Store) lewat jembatan Anthropic→OpenAI Grove.
// Jalankan:  DZAX_API_KEY=ctg_... npx tsx test/dzax-live.ts [model]
//
// Yang dibuktikan (pakai jalur yang SAMA dengan Session.ts — SDK + preset claude_code):
//  1. Percakapan biasa: teks mengalir (streaming) dan turn selesai wajar.
//  2. TOOL-CALL: model memakai Read/Glob pada file nyata → inti Grove (semua kerjanya lewat tool).
//  3. Token usage terbaca, jadi panel biaya Grove tidak buta.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bridgeBaseUrl, startOpenAiBridge, stopOpenAiBridge } from '../src/main/openaiBridge'
import { DZAX_BASE_URL_DEFAULT } from '../src/shared/types'

/** Endpoint bisa ditimpa: gateway OpenAI-compatible lain memakai jembatan yang SAMA. */
const BASE = process.env.DZAX_BASE_URL || DZAX_BASE_URL_DEFAULT

const KEY = process.env.DZAX_API_KEY || ''
const MODEL = process.argv[2] || 'gl/glm-5.2'
if (!KEY) {
  console.error('Set DZAX_API_KEY dulu.')
  process.exit(2)
}

let failed = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || !extra ? '' : `\n   ${extra}`}`)
  if (!cond) failed++
}

async function run(prompt: string, cwd: string, label: string): Promise<{ text: string; tools: string[]; usage: Record<string, number> }> {
  const port = await startOpenAiBridge()
  const base = bridgeBaseUrl(BASE, MODEL)
  if (!base) throw new Error('jembatan tak menyala')
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  env.ANTHROPIC_BASE_URL = base
  env.ANTHROPIC_AUTH_TOKEN = KEY
  env.ANTHROPIC_MODEL = MODEL
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = MODEL
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = MODEL
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = MODEL
  env.ANTHROPIC_SMALL_FAST_MODEL = MODEL
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  console.log(`\n[${label}] port jembatan ${port} · model ${MODEL}`)

  const q = query({
    prompt,
    options: {
      model: MODEL,
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
      env
    }
  })
  let text = ''
  const tools: string[] = []
  const usage: Record<string, number> = { input: 0, output: 0 }
  for await (const m of q as AsyncIterable<Record<string, unknown>>) {
    const type = m.type as string
    if (type === 'assistant') {
      const msg = m.message as { content?: Array<{ type: string; text?: string; name?: string }>; usage?: Record<string, number> }
      for (const b of msg?.content ?? []) {
        if (b.type === 'text' && b.text) text += b.text
        if (b.type === 'tool_use' && b.name) tools.push(b.name)
      }
      if (msg?.usage) {
        usage.input = Math.max(usage.input, Number(msg.usage.input_tokens ?? 0))
        usage.output += Number(msg.usage.output_tokens ?? 0)
      }
    } else if (type === 'result') {
      const sub = m.subtype as string
      console.log(`   [result] ${sub}`)
      if (sub !== 'success') console.log(`   [detail] ${JSON.stringify(m).slice(0, 400)}`)
      break
    }
  }
  return { text, tools, usage }
}

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'grove-dzax-'))
  writeFileSync(join(cwd, 'catatan.txt'), 'KODE RAHASIA: MANGGA-4721\nbaris kedua\n', 'utf8')

  // 1. chat biasa
  const a = await run('Balas SATU kata saja: OK', cwd, 'chat')
  console.log(`   teks: ${JSON.stringify(a.text.slice(0, 80))} · token in=${a.usage.input} out=${a.usage.output}`)
  check('1. chat biasa menghasilkan teks', a.text.trim().length > 0)
  check('1b. usage token terbaca', a.usage.input > 0, JSON.stringify(a.usage))

  // 2. tool-call nyata: harus membaca file untuk bisa menjawab
  const b = await run(
    'Di working directory ada file catatan.txt. Baca file itu, lalu balas HANYA kode rahasianya (tanpa kalimat lain).',
    cwd,
    'tool'
  )
  console.log(`   tools: ${b.tools.join(', ') || '(tak ada)'} · teks: ${JSON.stringify(b.text.slice(0, 120))}`)
  check('2. model memakai tool (Read/Glob/Bash)', b.tools.length > 0, b.tools.join(','))
  check('2b. isi file benar-benar terbaca (MANGGA-4721)', /MANGGA-4721/.test(b.text), b.text.slice(0, 200))

  stopOpenAiBridge()
  console.log(failed ? `\n${failed} cek GAGAL` : '\nSEMUA CEK LULUS — akun DZAX bisa dipakai di Grove')
  process.exit(failed ? 1 : 0)
}

void main()
