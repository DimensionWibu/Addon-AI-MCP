// Satu Session = satu query() SDK berumur panjang (streaming input multi-turn).
// Bertanggung jawab: kirim pesan user, streaming output ke UI, hitung token/context,
// simpan riwayat chat, update status di DB.

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ChatMessage,
  GroveEvent,
  ImageAttachment,
  SessionMeta,
  SessionRole,
  SessionStatus
} from '../../shared/types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Board } from './db'
import { buildGroveServer, type GroveHost } from './mcpTools'
import { contextPercent, contextWindowFor } from './contextWindows'

/**
 * Path claude.exe untuk app TERPAKET. Di dalam paket, SDK menunjuk binary yang berada
 * DI DALAM app.asar — file di arsip asar tak bisa dieksekusi ("exists but failed to launch").
 * electron-builder sudah menyalinnya ke app.asar.unpacked (lihat asarUnpack di package.json),
 * jadi arahkan SDK ke salinan nyata itu. Di dev path ini tak ada → undefined → SDK pakai default.
 */
function packagedClaudeExecutable(): string | undefined {
  const rp = process.resourcesPath
  if (!rp) return undefined
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const p = join(
    rp,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    bin
  )
  return existsSync(p) ? p : undefined
}
const CLAUDE_EXE = packagedClaudeExecutable()

// Bagian prompt yang SAMA untuk root & sub: cara melapor ke papan tulis + koordinasi.
const GROVE_COMMON = `
--- GROVE MULTI-AGENT PROTOCOL ---
You run inside "Grove", a multi-agent orchestrator GUI. Keep the dashboard live and coordinate through the shared board:
- EARLY (once you understand the request) call mcp__grove__set_title with a concise 3-6 word title for this session.
- mcp__grove__update_summary — a 1-3 sentence summary of your goal + current result. Call it early.
- mcp__grove__update_todo — maintain your task checklist.
- mcp__grove__report_progress — one sentence on what you are doing RIGHT NOW; call it whenever you switch activity.
- mcp__grove__read_board — read-only awareness of what sessions are doing (scope "tree" = your tree only; "all" = every tree, read-only — you must NEVER act on another tree's task).
- mcp__grove__send_message — leave a coordination note; ISOLATED to your OWN tree only (you cannot message another root/UTAMA or its workers). It is only a note, not a task.
- mcp__grove__list_workers — list the sessions in YOUR tree.
ISOLATION: every action you take (messages, progress reports, spawning, assigning) stays inside YOUR OWN tree; you can never send work or notes into another root/UTAMA tree or its sub-workers.
BE BRIEF — IT COSTS REAL CONTEXT: whatever you write into the board or a message is re-read by other sessions and re-sent every turn. Summaries ≤3 sentences, progress = one line, messages = conclusions only (no full reports, diffs, file dumps, or code listings; write those to a file and mention the path instead). Long text is hard-truncated anyway, so writing it only wastes your output tokens.
`.trim()

// Root (UTAMA) = orchestrator. Tugasnya MENDISTRIBUSI, bukan mengeksekusi sendiri.
const GROVE_ROOT = `
YOUR ROLE: you are the ROOT orchestrator of this tree (shown as "UTAMA" in the UI). Your job is to COORDINATE and DISTRIBUTE the work — NOT to do the heavy lifting yourself.
- Decompose the user's request into self-contained sub-tasks and DELEGATE each one to a sub-worker. Do NOT personally read many files, run the deep analysis, or write the large fixes — hand that to workers. Stay light so you can distribute, monitor, and synthesize.
- REUSE workers before creating new ones. FIRST call mcp__grove__list_workers. If a worker is idle, give it the next task with mcp__grove__assign_worker (it keeps its full prior context and is cheaper). Only call mcp__grove__spawn_worker when there is no suitable idle worker, or you genuinely need more parallelism at once.
- Each task you hand off must be clear and self-contained; you may share full context with your own workers.
- After delegating, monitor with mcp__grove__read_board / mcp__grove__read_messages, then synthesize the workers' results into the final answer for the user.
- PROGRESS TO THE USER: workers report their percent as they go, and you will be AUTO-PINGED with a "[GROVE AUTO]" message whenever they report. That ping ALREADY CONTAINS the current board summary — do NOT call read_board (it would flood your context). Just send the USER one short line from that summary. When all workers reach 100%, send the final synthesized answer instead. Keep updates brief; do not repeat unchanged status.
- PERIODIC AUTO-CHECK: roughly every few minutes you also get a "[GROVE AUTO-CHECK]" ping (like the user asking "udah sampe mana?"), which ALSO already includes the board summary — do NOT call read_board. From that summary: if any worker is idle but its task is NOT finished, push it to continue (list_workers for its id → assign_worker) so nobody stalls; give the user a brief status. When the ENTIRE task is complete, call mcp__grove__task_done to stop the periodic checks (they auto-resume on a new task).
- Only exception: a trivial one-off question you can just answer directly — no workers needed.
`.trim()

// Sub = pekerja. Kerjakan tugasnya sampai tuntas; boleh terima tugas baru lagi (konteks tersimpan).
const GROVE_SUB = `
YOUR ROLE: you are a SUB-WORKER. Focus on completing the specific task you were assigned, thoroughly and directly, then report the result.
- Do the work yourself. Only spawn your OWN sub-workers with mcp__grove__spawn_worker if your task is itself genuinely parallelizable; otherwise just do it.
- REPORT PROGRESS UP so the user can see how far along you are: call mcp__grove__report_to_parent with a one-line status AND a rough percent at meaningful milestones (roughly every 25%) and again with percent 100 when you finish. Keep mcp__grove__report_progress (with percent) updated too for the live board.
- When finished, put the outcome in mcp__grove__update_summary. You may be handed a NEW task later on this same session — your prior context is kept, so build on it.
`.trim()

function groveAppend(role: SessionRole): string {
  return `${GROVE_COMMON}\n\n${role === 'root' ? GROVE_ROOT : GROVE_SUB}`
}

/** Potong string 1-baris agar rapi di daftar chat. */
function short(v: unknown, max = 140): string {
  if (v == null) return ''
  const t = (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/**
 * Ringkas satu tool_use jadi baris informatif untuk chat, mis:
 *   → Read src/main/orchestrator/Session.ts
 *   → Grep "spawnWorker" (*.ts)
 *   → grove:report_progress Membaca prefs engine…
 * Supaya user tahu persis session lagi ngapain, bukan cuma nama tool.
 */
function summarizeTool(name = 'tool', input?: Record<string, unknown>): string {
  const i = input ?? {}
  const label = name.startsWith('mcp__grove__') ? `grove:${name.slice('mcp__grove__'.length)}` : name
  let detail = ''
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      detail = short(i.file_path ?? i.path ?? i.notebook_path)
      break
    case 'Grep':
      detail = short(i.pattern) + (i.glob ? ` (${short(i.glob, 40)})` : i.path ? ` in ${short(i.path, 60)}` : '')
      break
    case 'Glob':
      detail = short(i.pattern) + (i.path ? ` in ${short(i.path, 60)}` : '')
      break
    case 'Bash':
      detail = short(i.command, 160)
      break
    case 'Task':
    case 'Agent':
      detail = short(i.description ?? i.subagent_type)
      break
    case 'WebFetch':
    case 'WebSearch':
      detail = short(i.url ?? i.query)
      break
    default:
      if (name.startsWith('mcp__grove__')) {
        // Untuk tool Grove, tampilkan field paling informatif (progress/summary/title/…).
        detail = short(
          i.progress ?? i.summary ?? i.title ?? i.task ?? i.body ?? i.worker_id ?? i.scope ?? ''
        )
      } else {
        detail = short(i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.query ?? i.description ?? '')
      }
  }
  return detail ? `→ ${label} ${detail}` : `→ ${label}`
}

/** Potong string panjang dengan penanda. */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} char dipotong)` : s
}

/** Input tool lengkap, dirapikan untuk panel expand (string multi-baris tetap apa adanya). */
function formatToolInput(input?: Record<string, unknown>): string {
  const entries = Object.entries(input ?? {})
  if (!entries.length) return '(tanpa argumen)'
  return entries
    .map(([k, v]) => {
      if (typeof v === 'string') return v.includes('\n') ? `${k}:\n${clip(v, 6000)}` : `${k}: ${clip(v, 2000)}`
      return `${k}: ${clip(JSON.stringify(v), 2000)}`
    })
    .join('\n')
}

/** Ambil teks dari content tool_result (string, array blok teks/gambar, atau objek). */
function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        const o = c as { type?: string; text?: string }
        if (o?.type === 'text') return o.text ?? ''
        if (o?.type === 'image') return '[image]'
        return JSON.stringify(c)
      })
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

const AUTO_COMPACT_HIGH = 88 // ctx% ambang ATAS: picu auto-compact (cegah freeze saat konteks nyaris penuh)
const AUTO_COMPACT_LOW = 70 // ctx% ambang BAWAH: baru boleh mempersenjatai ulang auto-compact (hysteresis anti-thrash)

/** Apakah error menandakan batas pemakaian/rate-limit (pemicu auto-switch akun). */
function isLimitError(raw: string): boolean {
  return /rate_limit|429|usage|quota|exceed|limit reached|out of/i.test(raw)
}

/**
 * Pemberitahuan limit langganan yang datang sebagai TEKS asisten, mis:
 *   "You've hit your session limit · resets 4:20pm (Asia/Jakarta)"
 *   "You've reached your weekly limit"
 * Pola sengaja SPESIFIK (bukan sekadar kata "limit") agar tidak salah-picu saat model
 * kebetulan membahas kata limit dalam jawabannya.
 */
function isLimitNotice(text: string): boolean {
  return /(hit|reached|exceeded)\s+your\s+[\w\s-]*limit|(session|weekly|usage|5-hour|five-hour)\s+limit\b[^\n]{0,40}\bresets?\b|limit\s*·\s*resets/i.test(
    text
  )
}

/** Apakah pesan menandakan blokir keamanan API Claude (pemicu recycle sesi). */
function isApiBlock(raw: string): boolean {
  return /safety measures that flagged|flagged this message for a|Cyber Verification Program|cybersecurity topic/i.test(
    raw
  )
}

/** Ubah error/subtype mentah jadi pesan ramah + apakah masih bisa dilanjut. */
function friendlyError(raw: string): string {
  const s = raw.toLowerCase()
  if (s.includes('rate_limit') || s.includes('429'))
    return 'Kena rate limit. Tunggu sebentar, lalu kirim pesan lagi.'
  if (s.includes('overloaded') || s.includes('529'))
    return 'Server Claude sedang overload. Coba kirim lagi sebentar lagi.'
  if (s.includes('roles must alternate'))
    return 'Urutan pesan sempat tak sinkron. Kirim pesan lagi — akan disusun ulang & lanjut.'
  if (s.includes('authentication') || s.includes('401'))
    return 'Autentikasi bermasalah. Pastikan Claude Code masih login (jalankan `claude` sekali).'
  if (s.includes('permission') || s.includes('403'))
    return 'Akses ditolak (model/fitur tidak tersedia untuk akunmu). Coba ganti model.'
  if (s.includes('refus'))
    return 'Claude menolak permintaan ini (kebijakan konten). Ubah/rephrase lalu kirim lagi.'
  if (s.includes('max_turns')) return 'Turn mencapai batas maksimum langkah.'
  if (s.includes('budget')) return 'Batas biaya turn tercapai.'
  if (s.includes('invalid_request')) return 'Request tidak valid. Kirim pesan lagi.'
  return `Error: ${raw}`
}

/** Antrian async untuk streaming input: user mengetik → dorong ke query yang sedang jalan. */
class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private resolvers: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false

  push(content: string | unknown[]): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: content as never },
      parent_tool_use_id: null
    }
    const r = this.resolvers.shift()
    if (r) r({ value: msg, done: false })
    else this.queue.push(msg)
  }

  close(): void {
    this.closed = true
    let r
    while ((r = this.resolvers.shift())) r({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.queue.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.resolvers.push(resolve))
      }
    }
  }
}

export class Session {
  readonly meta: SessionMeta
  private readonly inbox = new AsyncMessageQueue()
  private readonly history: ChatMessage[] = []
  private q: ReturnType<typeof query> | null = null
  private stopped = false
  private started = false
  private tokensTotal = 0 // token output kumulatif (ala counter CLI)
  private toolRows = new Map<string, { rowId: number; input: string }>() // tool_use_id → baris + input
  private pendingCompactSeed: string | null = null // ringkasan compact, dieksekusi saat turn selesai
  private reseedText: string | null = null // disisipkan ke pesan berikutnya setelah konteks dipadatkan
  private lastUserPrompt = '' // prompt terakhir (untuk diulang saat recycle akibat blokir API)
  private apiRetries = 0 // berapa kali recycle akibat blokir API (maks 3)
  private apiStopped = false // dihentikan API Claude setelah 3× → judul merah
  private apiBlockPending = false // blokir API terdeteksi → recycle di akhir turn
  private limitHitPending = false // limit pemakaian terdeteksi → auto-switch akun di akhir turn
  private limitStreak = 0 // pindah akun beruntun akibat limit tanpa turn sukses (guard anti-loop)
  private compactArmed = true // auto-compact hanya menyala bila konteks NYATA pernah turun < LOW (hysteresis anti-thrash)
  private compactStreak = 0 // compact beruntun tanpa turn yang berakhir < LOW (guard anti-freeze; lihat limitStreak)
  private compactWarned = false // peringatan "konteks tetap penuh" sudah dikirim untuk streak ini (anti-spam)
  // --- jaminan runtime "worker selesai → parent tahu" (lihat host.notifyTurnEnd) ---
  private lastAssistantText = '' // teks asisten TERAKHIR pada turn berjalan = hasil kerja worker
  private finalReportSent = false // worker SUDAH lapor final (report_to_parent 100%) untuk turn ini → jangan dobel
  private interrupting = false // turn dihentikan PAKSA (Stop All/compact/ganti akun) → bukan "selesai wajar"

  constructor(
    meta: SessionMeta,
    private readonly db: Board,
    private readonly host: GroveHost,
    private readonly emit: (ev: GroveEvent) => void
  ) {
    this.meta = meta
  }

  getHistory(): ChatMessage[] {
    return this.history
  }

  /** Mulai query berumur panjang (lazy). Bila meta.sdkSessionId ada → resume (lanjut konteks). */
  start(initialTask?: string): void {
    if (this.started) {
      if (initialTask) this.sendUserMessage(initialTask)
      return
    }
    this.started = true
    const server = buildGroveServer(this.meta.id, this.host)
    const token = this.host.getAccountToken(this.meta.accountId) // akun per-session (opsional)
    this.q = query({
      prompt: this.inbox,
      options: {
        model: this.meta.model,
        cwd: this.meta.cwd,
        includePartialMessages: true,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: groveAppend(this.meta.role) },
        mcpServers: { grove: server },
        // Token akun → CLI subprocess pakai akun itu. Wajib spread process.env (opsi env MENGGANTInya).
        ...(token ? { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } as Record<string, string> } : {}),
        ...(CLAUDE_EXE ? { pathToClaudeCodeExecutable: CLAUDE_EXE } : {}), // paket: pakai binary unpacked
        resume: this.meta.sdkSessionId // lanjut konteks bila session dimuat ulang dari DB
      }
    })
    if (initialTask) this.sendUserMessage(initialTask)
    void this.consume()
  }

  /** Tandai untuk compact: konteks dipadatkan saat turn berjalan selesai (dari tool save_compaction). */
  scheduleCompact(summary: string): void {
    this.pendingCompactSeed = summary
  }

  private doCompact(): void {
    const summary = this.pendingCompactSeed
    this.pendingCompactSeed = null
    if (summary) this.compactWith(summary)
  }

  /**
   * Padatkan konteks LANGSUNG (tanpa giliran model): lepas sesi SDK lama (drop resume),
   * turunkan ctx% ke 0, dan siapkan ringkasan untuk disisipkan ke pesan berikutnya.
   * Menghentikan turn yang sedang jalan (mis. macet karena konteks penuh) → membebaskan sesi.
   * Dipakai tombol Compact (ringkasan dari board) & tool save_compaction (ringkasan model).
   */
  compactWith(summary: string): void {
    if (!summary) return
    this.interrupting = true // turn dipotong paksa → jangan dianggap "worker selesai"
    this.reseedText = summary
    this.meta.sdkSessionId = undefined // start berikutnya FRESH (tanpa resume) → konteks lama dilepas
    this.resetCtx() // ctx% turun ke 0 seketika
    this.compactArmed = false // jangan auto-compact lagi sampai konteks NYATA turun < LOW (anti-thrash)
    this.compactStreak++ // hitung compact beruntun → guard anti-freeze bila konteks tetap penuh
    this.db.upsertSession(this.meta)
    this.started = false
    const q = this.q
    this.q = null
    try {
      void q?.interrupt?.()
    } catch {
      /* abaikan */
    }
    this.record({
      role: 'system',
      text: '⟲ Konteks dipadatkan (compact). Ringkasan tugas disimpan ke Memori — pesan berikutnya melanjutkan dari ringkasan.',
      ts: Date.now()
    })
    this.setStatus('idle')
    this.emitActivity('idle')
  }

  /** Sisipkan ringkasan memori (sekali) di depan teks setelah compact, agar konteks nyambung. */
  private withReseed(text: string): string {
    if (!this.reseedText) return text
    const seed = this.reseedText
    this.reseedText = null
    return `[MEMORI TERKOMPAK — ringkasan konteks sebelumnya]\n${seed}\n\n---\n${text}`
  }

  /**
   * Awal satu giliran baru → reset pelacak laporan-final. Dipanggil di SETIAP jalur yang
   * mendorong pekerjaan baru (pesan user, tugas dari orkestrator, auto-check, resume).
   */
  private beginTurn(): void {
    this.lastAssistantText = ''
    this.finalReportSent = false
    this.interrupting = false
  }

  /** Dipanggil host saat worker memanggil report_to_parent dgn percent 100 → auto-report jangan dobel. */
  markFinalReported(): void {
    this.finalReportSent = true
  }

  /** Kirim pesan user (opsional dengan gambar); start otomatis bila dormant. */
  sendUserMessage(text: string, images?: ImageAttachment[]): void {
    this.beginTurn()
    this.lastUserPrompt = text // prompt user SEBELUM kena flag → diulang saat recycle
    this.apiRetries = 0 // prompt baru → reset hitungan recycle
    this.limitStreak = 0 // prompt user baru → reset rantai pindah-akun akibat limit
    this.setApiStopped(false)
    text = this.withReseed(text)
    if (!this.started) this.start()
    const dataUrls = (images ?? []).map((im) => `data:${im.mediaType};base64,${im.data}`)
    this.record({ role: 'user', text, ts: Date.now(), images: dataUrls.length ? dataUrls : undefined })
    this.setStatus('running')
    this.emitActivity('berpikir…')
    if (images?.length) {
      const content: unknown[] = []
      if (text) content.push({ type: 'text', text })
      for (const im of images) {
        content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })
      }
      this.inbox.push(content)
    } else {
      this.inbox.push(text)
    }
  }

  /**
   * Inject instruksi otomatis (mis. permintaan rangkuman progres dari worker) ke query.
   * Masuk konteks SDK sebagai giliran user, TAPI tidak direkam ke chat/DB agar UI tetap bersih —
   * yang tampil ke user cukup BALASAN root-nya. Start bila dormant (resume, konteks nyambung).
   */
  injectAutoTask(text: string): void {
    if (this.stopped) return
    this.beginTurn()
    text = this.withReseed(text)
    if (!this.started) this.start()
    this.setStatus('running')
    this.emitActivity('menyusun update progres…')
    this.inbox.push(text)
  }

  /** Auto-check berkala: tampilkan nota "udah sampe mana?" (biar terlihat) lalu inject promptnya. */
  autoCheck(prompt: string): void {
    if (this.stopped) return
    this.record({ role: 'system', text: '🔁 Auto-check berkala: "udah sampe mana?"', ts: Date.now() })
    this.injectAutoTask(prompt)
  }

  /** Saat app dibuka lagi: sesi yang tadinya kerja → resume konteks & dorong lanjut. */
  autoResume(): void {
    if (this.stopped || this.started) return
    this.record({ role: 'system', text: '▶ Melanjutkan sesi yang terputus saat aplikasi ditutup…', ts: Date.now() })
    // Sertakan ringkasan tugas dari board: kalau sesi ini fresh (tanpa resume), dia tetap tahu
    // harus melanjutkan apa — bukan sekadar disuruh "lanjutkan" tanpa konteks.
    const b = this.db.getBoardEntry(this.meta.id)
    const ctx: string[] = []
    if (b?.summary) ctx.push(`Tujuan & kondisi terakhir: ${b.summary}`)
    if (b?.progress) ctx.push(`Terakhir dikerjakan: ${b.progress}`)
    if (b?.todo?.length) ctx.push(`Checklist: ${b.todo.map((t) => `${t.done ? '✓' : '○'} ${t.text}`).join('; ')}`)
    const seed = ctx.length ? `\n\n${ctx.join('\n')}` : ''
    this.injectAutoTask(
      `Lanjutkan pekerjaan sebelumnya yang terputus saat aplikasi ditutup. Mulai dari titik terakhir, jangan mengulang dari awal.${seed}`
    )
  }

  private emitActivity(activity: string): void {
    this.emit({ channel: 'session:activity', payload: { id: this.meta.id, activity } })
  }

  /** Simpan ke riwayat in-memory + DB + kirim ke UI. Kembalikan rowid DB. (Gambar tak dipersist.) */
  private record(m: ChatMessage): number {
    this.history.push(m)
    const dbText = m.text || (m.images?.length ? '🖼️ [gambar]' : '')
    const rowId = this.db.addChatMessage(this.meta.id, m.role, dbText, m.ts, m.detail)
    this.emit({ channel: 'chat:message', payload: { id: this.meta.id, message: m } })
    return rowId
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.interrupting = true // ditutup paksa → bukan "turn selesai wajar"
    this.inbox.close()
    try {
      await this.q?.interrupt?.()
    } catch {
      /* abaikan */
    }
    this.setStatus('done')
  }

  private setStatus(status: SessionStatus): void {
    if (this.meta.status === status) return
    this.meta.status = status
    this.meta.updatedAt = Date.now()
    this.db.upsertSession(this.meta)
    this.emit({ channel: 'session:update', payload: { id: this.meta.id, status } })
  }

  private async consume(): Promise<void> {
    if (!this.q) return
    try {
      for await (const msg of this.q) {
        this.handle(msg as Record<string, unknown> & { type: string })
      }
    } catch (e) {
      const raw = String(e)
      if (isApiBlock(raw)) this.apiBlockPending = true
      else if (isLimitError(raw)) this.limitHitPending = true // limit via exception → auto-switch
      // Jangan cetak error generik kalau kita sengaja interupsi (recycle blokir API / switch limit).
      else if (!this.stopped) {
        console.error(`[Session ${this.meta.id}] error:`, e)
        this.record({
          role: 'system',
          text: `⚠️ ${friendlyError(raw)}  (session tetap bisa dilanjut — kirim pesan lagi)`,
          ts: Date.now()
        })
        this.setStatus('error')
      }
    } finally {
      // Query mati (error/blokir/selesai). Bila bukan karena stop manual, izinkan
      // restart: pesan berikutnya akan start() ulang dengan resume → konteks nyambung.
      if (!this.stopped) {
        this.started = false
        this.q = null
        if (this.meta.status === 'running') this.setStatus('idle')
      }
      // Setelah state di-reset: bila kena limit, minta orkestrator auto-switch akun (bila aktif).
      if (this.limitHitPending && !this.stopped) {
        this.limitHitPending = false
        this.host.onLimitHit(this.meta.id)
      }
      // Bila terdeteksi blokir API → recycle (reset konteks + ulang tugas terakhir).
      if (this.apiBlockPending && !this.stopped) {
        this.apiBlockPending = false
        this.handleApiBlock()
      }
    }
  }

  /**
   * Ganti akun berlaku efektif: token dibaca saat start(). Kalau session sedang jalan,
   * hentikan query lama (konteks/sdkSessionId dipertahankan) → pesan berikutnya resume
   * dengan token akun baru. Kalau sudah dormant, tak perlu apa-apa (start berikutnya sudah pakai baru).
   */
  applyAccountChange(): void {
    if (!this.started) return
    this.interrupting = true // turn dipotong paksa demi ganti akun → bukan "worker selesai"
    this.started = false
    const q = this.q
    this.q = null
    try {
      void q?.interrupt?.()
    } catch {
      /* abaikan */
    }
    this.setStatus('idle')
    this.emitActivity('idle')
  }

  /** Blokir API terdeteksi → hentikan turn agar consume().finally menjalankan recycle. */
  private flagApiBlock(): void {
    if (this.apiStopped || this.apiBlockPending) return
    this.apiBlockPending = true
    try {
      void this.q?.interrupt?.()
    } catch {
      /* abaikan */
    }
  }

  /**
   * Limit pemakaian terdeteksi (dari error field pesan assistant / result / exception).
   * Hentikan turn → consume().finally memanggil host.onLimitHit (auto-switch akun + lanjut).
   */
  private flagLimitHit(): void {
    if (this.limitHitPending || this.apiBlockPending) return
    this.limitHitPending = true
    try {
      void this.q?.interrupt?.()
    } catch {
      /* abaikan */
    }
  }

  /** Catat satu baris system ke chat (dipakai orkestrator: memberi tahu switch akun / limit). */
  systemNote(text: string): void {
    this.record({ role: 'system', text, ts: Date.now() })
  }

  /** Tandai sesi berhenti karena limit (tak bisa/berhenti auto-switch) → status error. */
  markLimited(): void {
    this.setStatus('error')
    this.emitActivity('kena limit')
  }

  /** Naikkan & kembalikan hitungan pindah-akun beruntun akibat limit (guard anti-loop). */
  bumpLimitStreak(): number {
    return ++this.limitStreak
  }

  private setApiStopped(v: boolean): void {
    if (this.apiStopped === v) return
    this.apiStopped = v
    this.emit({ channel: 'session:update', payload: { id: this.meta.id, apiStopped: v } })
  }

  /** Reset hitungan konteks ke 0 (setelah konteks dibuang) → badge ctx% langsung turun. */
  private resetCtx(): void {
    this.meta.ctxInput = 0
    this.meta.ctxOutput = 0
    // ctxInput=0 dipakai logika ambang; UI diberi penanda "pending" agar badge TIDAK memajang 0% palsu —
    // isi window nyata baru diketahui saat turn berikutnya melapor usage (lihat applyUsage → ctxPending:false).
    this.emit({
      channel: 'session:update',
      payload: { id: this.meta.id, ctxInput: 0, ctxOutput: 0, ctxPercent: 0, ctxPending: true }
    })
  }

  /**
   * Recycle akibat blokir API: reset konteks Claude (buang riwayat yang ke-flag) TAPI seed
   * ringkasan tugas (dari board: summary/progress/todo) + prompt terakhir → lanjut langsung.
   * Setelah 3× masih diblokir → stop + tandai judul merah.
   */
  private handleApiBlock(): void {
    if (this.apiStopped) return
    if (this.apiRetries >= 3) {
      this.record({
        role: 'system',
        text: '⛔ Sesi dihentikan oleh API Claude (diblokir 3× berturut). Rephrase prompt lalu kirim manual untuk mencoba lagi.',
        ts: Date.now()
      })
      this.setApiStopped(true)
      this.setStatus('error')
      this.emitActivity('diblokir API')
      return
    }
    this.apiRetries++
    // Ringkasan tugas dari board sesi ini → agar sesi fresh tetap tahu konteksnya.
    const board = this.db.getBoardEntry(this.meta.id)
    const ctx: string[] = []
    if (board?.summary) ctx.push(`Tujuan & hasil sejauh ini: ${board.summary}`)
    if (board?.progress) ctx.push(`Terakhir dikerjakan: ${board.progress}`)
    if (board?.todo?.length) {
      ctx.push(`Checklist: ${board.todo.map((t) => `${t.done ? '✓' : '○'} ${t.text}`).join('; ')}`)
    }
    const seed = ctx.length
      ? `[Konteks direset karena blokir keamanan API — ringkasan tugasmu agar bisa langsung lanjut:]\n${ctx.join('\n')}\n\n`
      : ''
    this.record({
      role: 'system',
      text: `⟲ Konteks direset — recycle #${this.apiRetries}/3 (blokir API). Lanjut dari ringkasan tugas.`,
      ts: Date.now()
    })
    this.meta.sdkSessionId = undefined // fresh SDK session (tanpa resume → riwayat lama dilepas)
    this.resetCtx() // ctx% turun ke 0 seketika → bukti reset jalan
    this.db.upsertSession(this.meta)
    const prompt = `${seed}Lanjutkan pekerjaan.${this.lastUserPrompt ? ` Instruksi terakhir dari user: ${this.lastUserPrompt}` : ''}`
    this.start() // fresh (started sudah false dari finally)
    this.setStatus('running')
    this.emitActivity(`recycle #${this.apiRetries}…`)
    this.inbox.push(prompt)
  }

  /** Interupsi turn yang sedang berjalan TANPA menutup session (masih bisa lanjut chat). */
  async interruptTurn(): Promise<void> {
    try {
      await this.q?.interrupt?.()
    } catch {
      /* abaikan */
    }
    this.setStatus('idle')
    this.emitActivity('idle')
  }

  private handle(msg: Record<string, unknown> & { type: string }): void {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const sid = msg.session_id as string
          const model = msg.model as string | undefined
          let changed = false
          if (sid && this.meta.sdkSessionId !== sid) {
            this.meta.sdkSessionId = sid
            changed = true
          }
          // Model aktual baru diketahui saat init → set ctxWindow yang benar (mis. [1m] = 1jt).
          if (model && this.meta.model !== model) {
            this.meta.model = model
            this.meta.ctxWindow = contextWindowFor(model)
            changed = true
            // Verifikasi (sekali/model): pastikan model 1M tak salah dideteksi sbagai 200k.
            console.log(`[Session ${this.meta.id}] model="${model}" → ctxWindow=${this.meta.ctxWindow}`)
          }
          if (changed) {
            this.meta.updatedAt = Date.now()
            this.db.upsertSession(this.meta)
            this.emit({
              channel: 'session:update',
              payload: {
                id: this.meta.id,
                sdkSessionId: this.meta.sdkSessionId,
                model: this.meta.model,
                ctxWindow: this.meta.ctxWindow,
                ctxPercent: contextPercent(this.meta.ctxInput, this.meta.ctxWindow)
              }
            })
          }
          this.setStatus('running')
        }
        break
      }
      case 'stream_event': {
        const ev = (
          msg as {
            event?: {
              type?: string
              delta?: { type?: string; text?: string }
              content_block?: { type?: string; name?: string }
            }
          }
        ).event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          this.emit({ channel: 'chat:delta', payload: { id: this.meta.id, delta: ev.delta.text } })
        } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          this.emitActivity(`🔧 ${ev.content_block.name ?? 'tool'}`)
        }
        break
      }
      case 'assistant': {
        // Limit langganan (5-jam/7-hari) datang sebagai field `error:'rate_limit'` di wrapper,
        // BUKAN exception — deteksi di sini agar auto-switch akun ikut kepicu.
        const wrapErr = (msg as { error?: string }).error
        if (wrapErr && isLimitError(wrapErr)) this.flagLimitHit()
        const message = (msg as { message?: { content?: unknown[]; usage?: Record<string, number> } }).message
        this.applyUsage(message?.usage)
        for (const block of (message?.content ?? []) as {
          type: string
          id?: string
          text?: string
          name?: string
          input?: Record<string, unknown>
        }[]) {
          if (block.type === 'text' && block.text?.trim()) {
            this.record({ role: 'assistant', text: block.text, ts: Date.now() })
            if (isApiBlock(block.text)) this.flagApiBlock() // API blokir pesan → recycle di akhir turn
            // Limit langganan sering datang sebagai TEKS ("You've hit your session limit · resets …"),
            // bukan exception/field error → deteksi di sini agar auto-switch akun ikut kepicu.
            else if (isLimitNotice(block.text)) this.flagLimitHit()
          } else if (block.type === 'tool_use') {
            const input = formatToolInput(block.input)
            const rowId = this.record({
              role: 'tool',
              text: summarizeTool(block.name, block.input),
              ts: Date.now(),
              detail: input,
              toolUseId: block.id
            })
            if (block.id) this.toolRows.set(block.id, { rowId, input })
          }
        }
        break
      }
      case 'user': {
        // Pesan 'user' dari SDK membawa hasil tool (tool_result) → tempelkan ke baris tool-nya.
        const content = (msg as { message?: { content?: unknown } }).message?.content
        if (!Array.isArray(content)) break // content string biasa (bukan tool_result) → abaikan
        for (const b of content as {
          type?: string
          tool_use_id?: string
          content?: unknown
          is_error?: boolean
        }[]) {
          if (b.type !== 'tool_result' || !b.tool_use_id) continue
          const rec = this.toolRows.get(b.tool_use_id)
          if (!rec) continue
          const out = clip(extractResultText(b.content), 6000)
          const merged = `${rec.input}\n\n--- OUTPUT${b.is_error ? ' (error)' : ''} ---\n${out}`
          this.db.updateChatDetail(rec.rowId, merged)
          this.emit({ channel: 'chat:detail', payload: { id: this.meta.id, toolUseId: b.tool_use_id, detail: merged } })
          this.toolRows.delete(b.tool_use_id)
        }
        break
      }
      case 'result': {
        const r = msg as { subtype?: string; errors?: unknown[]; stop_reason?: string }
        const subtype = r.subtype
        if (isApiBlock(JSON.stringify(msg))) this.flagApiBlock() // blokir API terselip di result
        // Limit bisa muncul sbg result error (errors[]/stop_reason). JANGAN stringify seluruh msg
        // untuk isLimitError — field "usage"/"modelUsage" akan false-positive; cek yang spesifik saja.
        if (subtype && subtype !== 'success') {
          const hit =
            (Array.isArray(r.errors) && r.errors.some((x) => isLimitError(String(x)))) ||
            (r.stop_reason ? isLimitError(r.stop_reason) : false)
          if (hit) this.flagLimitHit()
        }
        if (subtype === 'success') this.limitStreak = 0 // turn sukses → rantai limit direset
        if (subtype && subtype !== 'success' && !this.apiBlockPending && !this.limitHitPending) {
          this.record({
            role: 'system',
            text: `⚠️ ${friendlyError(subtype)}  (session tetap bisa dilanjut — kirim pesan lagi)`,
            ts: Date.now()
          })
        }
        this.setStatus('idle') // menunggu input berikutnya
        this.emitActivity('idle')
        // Turn selesai → beri tahu orkestrator (root akan dibangunkan untuk lapor ke user).
        this.host.notifyTurnEnd(this.meta.id)
        // Bila ada permintaan compact tertunda, padatkan konteks sekarang (turn sudah selesai).
        if (this.pendingCompactSeed) this.doCompact()
        else {
          const pct = contextPercent(this.meta.ctxInput, this.meta.ctxWindow)
          if (pct < AUTO_COMPACT_LOW) {
            // Turn berakhir lega → reset guard futility (compact sebelumnya benar memberi headroom).
            this.compactStreak = 0
            this.compactWarned = false
          } else if (this.compactArmed && pct >= AUTO_COMPACT_HIGH) {
            if (this.compactStreak >= 2) {
              // Compact berulang tak menurunkan konteks → jangan loop; peringatkan SEKALI (anti-freeze + anti-spam).
              if (!this.compactWarned) {
                this.record({
                  role: 'system',
                  text: '⚠️ Konteks tetap penuh setelah compact berulang; ringkasan/tugas mungkin terlalu besar — pertimbangkan pecah tugas atau Compact manual.',
                  ts: Date.now()
                })
                this.compactWarned = true
              }
            } else {
              // Auto-compact: konteks mendekati penuh → minta orkestrator padatkan (cegah freeze).
              this.host.notifyHighContext(this.meta.id)
            }
          }
        }
        break
      }
      default:
        break
    }
  }

  private applyUsage(usage?: Record<string, number>): void {
    if (!usage) return
    const ctxInput =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    const ctxOutput = usage.output_tokens ?? 0
    if (ctxInput <= 0 && ctxOutput <= 0) return
    this.meta.ctxInput = ctxInput
    this.meta.ctxOutput = ctxOutput
    this.tokensTotal += ctxOutput
    this.meta.updatedAt = Date.now()
    this.db.upsertSession(this.meta)
    this.emit({
      channel: 'session:update',
      payload: {
        id: this.meta.id,
        ctxInput,
        ctxOutput,
        ctxPercent: contextPercent(ctxInput, this.meta.ctxWindow),
        tokensTotal: this.tokensTotal,
        ctxPending: false // ada pengukuran nyata → badge keluar dari mode pending
      }
    })
    // Hysteresis: begitu konteks NYATA turun < LOW, persenjatai ulang auto-compact (boleh memicu lagi nanti).
    if (contextPercent(ctxInput, this.meta.ctxWindow) < AUTO_COMPACT_LOW) this.compactArmed = true
  }
}
