// UJI NYATA akun provider 'deepseek': jalankan Claude Code SDK (CLI asli, seperti Session.ts) lewat
// endpoint Anthropic RESMI DeepSeek. Bukan mock — butuh API key nyata:
//   DEEPSEEK_API_KEY=sk-... npx tsx test/deepseek-live.ts
// Yang dibuktikan: (1) streaming jalan, (2) tool bawaan Claude Code (Write/Read) dieksekusi,
// (3) tool MCP in-process (jalur yang dipakai orkestrator Grove: spawn_worker dkk) ikut dipanggil.
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL_DEFAULT, skinBaseUrl } from '../src/shared/types'

const KEY = process.env.DEEPSEEK_API_KEY || ''
if (!KEY) {
  console.error('Set DEEPSEEK_API_KEY dulu.')
  process.exit(2)
}
const MODEL = process.env.DEEPSEEK_MODEL || DEEPSEEK_MODEL_DEFAULT

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : `\n        ${extra}`}`)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'grove-ds-live-'))
  // Env DIRAKIT PERSIS seperti SessionManager.getSessionLaunch untuk provider 'deepseek'.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  env.ANTHROPIC_BASE_URL = skinBaseUrl('deepseek')
  env.ANTHROPIC_AUTH_TOKEN = KEY
  env.ANTHROPIC_MODEL = MODEL
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = MODEL
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = MODEL
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = MODEL.replace(/-pro$/, '-flash')
  env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  check('base URL = endpoint anthropic DeepSeek', env.ANTHROPIC_BASE_URL === DEEPSEEK_BASE_URL, env.ANTHROPIC_BASE_URL)

  // Tool MCP in-process — jalur yang sama dipakai Grove untuk 13 tool orkestrasinya.
  let mcpCalled = ''
  const grove = createSdkMcpServer({
    name: 'grove',
    version: '1.0.0',
    tools: [
      tool(
        'report_progress',
        'Laporkan progres pekerjaan ke papan Grove.',
        { progress: z.string(), percent: z.number() },
        async (args) => {
          mcpCalled = `${args.percent}% ${args.progress}`
          return { content: [{ type: 'text' as const, text: 'tercatat di papan' }] }
        }
      )
    ]
  })

  const q = query({
    prompt:
      'Kerjakan dua hal, pakai tool, tanpa bertanya: ' +
      '1) buat file halo.txt di folder kerja berisi persis: halo dari deepseek ' +
      '2) panggil tool mcp__grove__report_progress dengan percent 100 dan progress "file dibuat". ' +
      'Setelah keduanya selesai, jawab singkat SELESAI.',
    options: {
      model: MODEL,
      cwd: dir,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
      settingSources: [],
      mcpServers: { grove },
      env
    }
  })

  let deltas = 0
  const toolsUsed: string[] = []
  let text = ''
  let apiError = ''
  const t0 = Date.now()
  for await (const m of q as AsyncIterable<Record<string, unknown>>) {
    const type = String(m.type)
    if (type === 'stream_event') deltas++
    if (type === 'assistant') {
      const content = (m.message as { content?: Array<Record<string, unknown>> })?.content ?? []
      for (const b of content) {
        if (b.type === 'tool_use') toolsUsed.push(String(b.name))
        if (b.type === 'text') text += String(b.text)
      }
    }
    if (type === 'result') {
      const sub = String(m.subtype ?? '')
      if (sub !== 'success') apiError = `${sub}: ${String(m.result ?? '')}`
      const u = m.usage as Record<string, number> | undefined
      console.log(
        `\n[info] ${Math.round((Date.now() - t0) / 1000)}s · in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} · subtype=${sub}`
      )
      break
    }
  }

  check('tak ada error API', !apiError, apiError)
  check('streaming mengalir (stream_event > 0)', deltas > 0, `deltas=${deltas}`)
  check('tool Claude Code dipanggil', toolsUsed.length > 0, `tools=${toolsUsed.join(',') || '(kosong)'}`)
  const f = join(dir, 'halo.txt')
  check('file halo.txt benar-benar dibuat', existsSync(f))
  if (existsSync(f)) {
    const isi = readFileSync(f, 'utf8').trim()
    check('isi file sesuai perintah', isi.toLowerCase().includes('halo dari deepseek'), isi)
  }
  check('tool MCP grove dipanggil (jalur orkestrator)', !!mcpCalled, mcpCalled || '(tak dipanggil)')
  check('ada teks jawaban', text.trim().length > 0, text.slice(0, 120))
  console.log(`\ntools: ${toolsUsed.join(', ') || '-'}\njawab: ${text.trim().slice(0, 200)}`)

  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* windows lock */
  }
  console.log(failed ? `\n${failed} CHECK GAGAL` : '\nSEMUA CHECK LULUS')
  process.exit(failed ? 1 : 0)
}

void main()
