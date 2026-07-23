// APAKAH query() YANG DITINGGALKAN MENINGGALKAN PROSES CLI? — eksperimen langsung, bukan tebakan.
//
// Grove menghentikan query lama (compact / ganti akun / reset worker) dengan `interrupt()`. Tapi
// interrupt hanya menghentikan GILIRAN; pada mode streaming-input, subprocess CLI tetap hidup
// menunggu input berikutnya. Kalau benar, tiap compact meninggalkan satu proses ~200MB — persis
// gejala "2 sesi tapi 7 proses Claude Code, RAM 2GB".
//
// Jalankan (butuh token DeepSeek — paling murah; 1 prompt sepele):
//   DEEPSEEK_API_KEY=sk-... npx tsx test/proc-leak.ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skinBaseUrl } from '../src/shared/types'

const KEY = process.env.DEEPSEEK_API_KEY || ''
if (!KEY) {
  console.error('Set DEEPSEEK_API_KEY dulu (token akun DeepSeek dari Grove).')
  process.exit(2)
}

/**
 * Jumlah proses TURUNAN dari proses tes ini (rekursif). Menghitung "semua proses bernama claude" di
 * mesin ini keliru — Grove milik user juga sedang jalan dan angkanya ikut terhitung.
 */
function childProcs(): { count: number; names: string[] } {
  try {
    const ps = `powershell -NoProfile -Command "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; $out=@(); $frontier=@(${process.pid}); while ($frontier.Count -gt 0) { $next=@(); foreach ($p in $frontier) { foreach ($c in $all) { if ($c.ParentProcessId -eq $p) { $out += $c; $next += $c.ProcessId } } }; $frontier=$next }; $out | ForEach-Object { $_.Name } | Sort-Object"`
    const out = execSync(ps, { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    return { count: out.length, names: out }
  } catch {
    return { count: -1, names: [] }
  }
}
const claudeProcs = (): number => childProcs().count

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Antrian input streaming minimal (meniru AsyncMessageQueue milik Session). */
class Inbox {
  private q: unknown[] = []
  private resolvers: ((r: IteratorResult<unknown>) => void)[] = []
  push(text: string): void {
    const msg = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
    const r = this.resolvers.shift()
    if (r) r({ value: msg, done: false })
    else this.q.push(msg)
  }
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const item = this.q.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        return new Promise((resolve) => this.resolvers.push(resolve))
      }
    }
  }
}

function envDeepseek(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  env.ANTHROPIC_BASE_URL = skinBaseUrl('deepseek')
  env.ANTHROPIC_AUTH_TOKEN = KEY
  env.ANTHROPIC_MODEL = 'deepseek-v4-pro'
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
  env.ANTHROPIC_SMALL_FAST_MODEL = 'deepseek-v4-flash'
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'grove-leak-'))
  const base = claudeProcs()
  console.log(`proses CLI awal: ${base}`)

  const inbox = new Inbox()
  const q = query({
    prompt: inbox as never,
    options: {
      model: 'deepseek-v4-pro',
      cwd,
      permissionMode: 'bypassPermissions',
      systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
      env: envDeepseek()
    }
  })
  inbox.push('Balas satu kata: OK')

  // Konsumsi sampai turn pertama selesai, lalu TINGGALKAN query-nya hidup (persis seperti Session
  // yang query-nya berumur panjang antar-giliran).
  void (async () => {
    try {
      // JANGAN break: `break` memanggil iterator.return() secara implisit → query langsung ditutup,
      // padahal yang ingin diukur justru query yang DIBIARKAN HIDUP antar-giliran (persis Session).
      for await (const m of q) {
        const t = (m as { type?: string; subtype?: string }).type
        if (t === 'result') console.log('  [pesan] result — turn selesai, query dibiarkan parkir')
      }
    } catch (e) {
      console.log(`  [error stream] ${String(e).slice(0, 300)}`)
    }
  })()
  await sleep(20_000)
  const live = childProcs()
  const running = live.count
  console.log(
    `proses anak saat query hidup: ${running} (${running - base > 0 ? '+' + (running - base) : 'tak bertambah'}) → ${live.names.join(', ')}`
  )

  // 1) interrupt() saja — inilah yang Grove lakukan hari ini.
  try {
    await q.interrupt?.()
  } catch {
    /* diabaikan */
  }
  await sleep(6_000)
  const afterInterrupt = claudeProcs()
  console.log(`setelah interrupt():      ${afterInterrupt}  → ${afterInterrupt > base ? '❌ PROSES MASIH HIDUP (bocor)' : '✅ mati'}`)

  // 2) return() — mengakhiri async generator → cleanup SDK.
  try {
    await q.return?.(undefined as never)
  } catch {
    /* diabaikan */
  }
  await sleep(6_000)
  const afterReturn = claudeProcs()
  console.log(`setelah return():         ${afterReturn}  → ${afterReturn > base ? '❌ MASIH HIDUP' : '✅ mati'}`)

  console.log(
    `\nKESIMPULAN JALUR SDK: interrupt ${afterInterrupt > base ? 'TIDAK' : ''} membunuh proses; return ${afterReturn > base ? 'TIDAK' : ''} membunuh proses.`
  )

  // ---- FASE 2: Session SUNGGUHAN — apakah compact meninggalkan proses? ----
  console.log('\n--- FASE 2: Session Grove + compact ---')
  const { Board } = await import('../src/main/orchestrator/db')
  const { Session } = await import('../src/main/orchestrator/Session')
  const board = new Board(join(cwd, 'leak.sqlite'))
  await board.init()
  const now = Date.now()
  const meta = {
    id: 'leak-1',
    treeId: 'leak-1',
    parentId: null,
    role: 'root' as const,
    title: 'Leak',
    cwd,
    status: 'idle' as const,
    ctxInput: 0,
    ctxOutput: 0,
    ctxWindow: 1_000_000,
    createdAt: now,
    updatedAt: now
  }
  board.upsertSession(meta)
  const host = new Proxy(
    {},
    {
      get: (_t, p: string) => {
        if (p === 'getSessionLaunch') return () => ({ env: envDeepseek(), model: 'deepseek-v4-pro' })
        if (p === 'beforeCompact') return () => null
        if (p === 'hasReferences') return () => false
        if (p === 'readBoard' || p === 'listWorkers' || p === 'readMessages') return () => []
        if (p === 'sessionSeesImages') return () => true
        return () => undefined
      }
    }
  ) as never
  const s = new Session(meta, board, host, () => {})
  s.sendUserMessage('Balas satu kata: OK')
  await sleep(25_000)
  const withSession = claudeProcs()
  console.log(`proses anak saat Session hidup: ${withSession} (+${withSession - base})`)
  s.compactWith('ringkasan uji') // inilah aksi yang dulu meninggalkan proses
  await sleep(8_000)
  const afterCompact = claudeProcs()
  const leaked = afterCompact > base
  console.log(
    `setelah compactWith():    ${afterCompact}  → ${leaked ? '❌ MASIH ADA PROSES TERTINGGAL' : '✅ bersih (tak ada proses tertinggal)'}`
  )
  await s.stop()
  await sleep(3_000)
  console.log(`setelah stop():           ${claudeProcs()}`)
  process.exit(leaked ? 1 : 0)
}

void main()
