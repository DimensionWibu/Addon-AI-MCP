// PENJAGA BACA-ULANG SESUDAH COMPACT.
// Bagian 1 (murni): kapan sebuah Read dicegah.
// Bagian 2 (HIDUP, butuh key gateway): membuktikan SDK benar-benar MENGHORMATI keputusan deny dari
// hook PreToolUse — kalau tidak, penjaga ini cuma hiasan.
//   DZAX_API_KEY=... DZAX_BASE_URL=https://shiteru.id/v1 npx tsx test/reread-guard.ts glm-5.2
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldBlockReread } from '../src/main/orchestrator/Session'
import { bridgeBaseUrl, startOpenAiBridge, stopOpenAiBridge } from '../src/main/openaiBridge'

let failed = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || !extra ? '' : `\n   ${extra}`}`)
  if (!cond) failed++
}

const seen = new Set(['E:/proyek/besar.py'])
check('baca ulang PENUH file yang sudah dibaca → dicegah', shouldBlockReread('Read', { file_path: 'E:/proyek/besar.py' }, seen))
check('baca SEBAGIAN (offset) → boleh', !shouldBlockReread('Read', { file_path: 'E:/proyek/besar.py', offset: 100 }, seen))
check('baca SEBAGIAN (limit) → boleh', !shouldBlockReread('Read', { file_path: 'E:/proyek/besar.py', limit: 50 }, seen))
check('file BARU → boleh dibaca penuh', !shouldBlockReread('Read', { file_path: 'E:/proyek/lain.py' }, seen))
check('tool lain (Grep) → tak disentuh', !shouldBlockReread('Grep', { pattern: 'x' }, seen))
check('tanpa file_path → tak disentuh', !shouldBlockReread('Read', {}, seen))

// Jalur uji hidup: gateway (lewat jembatan) ATAU DeepSeek langsung (endpoint Anthropic resminya).
const DS_KEY = process.env.DEEPSEEK_API_KEY
const KEY = DS_KEY || process.env.DZAX_API_KEY
const BASE = DS_KEY ? 'https://api.deepseek.com/anthropic' : process.env.DZAX_BASE_URL
const MODEL = process.argv[2] || (DS_KEY ? 'deepseek-v4-pro' : 'glm-5.2')
if (!KEY || !BASE) {
  console.log('\n(uji hidup dilewati — set DZAX_API_KEY & DZAX_BASE_URL untuk membuktikan SDK menghormati hook)')
  process.exit(failed ? 1 : 0)
}

async function live(): Promise<void> {
  await startOpenAiBridge()
  const dir = mkdtempSync(join(tmpdir(), 'grove-hook-'))
  writeFileSync(join(dir, 'rahasia.txt'), 'ISI RAHASIA: NANAS-99\n', 'utf8')
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  // DeepSeek bicara format Anthropic langsung → tak perlu jembatan.
  env.ANTHROPIC_BASE_URL = DS_KEY ? BASE! : bridgeBaseUrl(BASE!, MODEL, 'hook-test')!
  env.ANTHROPIC_AUTH_TOKEN = KEY!
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) env[k] = MODEL
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN

  let denied = 0
  const q = query({
    prompt: 'Baca file catatan.txt di folder kerja, lalu tulis isinya persis.',
    options: {
      model: MODEL,
      cwd: dir,
      permissionMode: 'bypassPermissions',
      systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
      env,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (raw) => {
                const i = raw as { tool_name?: string }
                if (i.tool_name !== 'Read') return { continue: true }
                denied++
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'deny' as const,
                    permissionDecisionReason: 'UJI: pembacaan berkas sengaja ditolak penjaga; jawab tanpa membacanya.'
                  }
                }
              }
            ]
          }
        ]
      }
    }
  })
  let text = ''
  for await (const m of q as AsyncIterable<Record<string, unknown>>) {
    if (m.type === 'assistant') {
      for (const b of ((m.message as { content?: Array<{ type: string; text?: string }> })?.content ?? [])) {
        if (b.type === 'text' && b.text) text += b.text
      }
    }
    if (m.type === 'result') break
  }
  console.log(`\n   hook Read dipanggil ${denied}x · jawaban: ${JSON.stringify(text.slice(0, 120))}`)
  check('SDK memanggil hook PreToolUse untuk Read', denied > 0)
  check('isi file TIDAK bocor ke jawaban (deny dihormati)', !/NANAS-99/.test(text), text.slice(0, 200))
  stopOpenAiBridge()
}

await live()
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek lulus')
process.exit(failed ? 1 : 0)
