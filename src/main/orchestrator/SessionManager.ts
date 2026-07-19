// Orkestrator: kelola semua Session (banyak pohon), spawn sub-worker, bangun pohon
// untuk UI, dan tegakkan isolasi antar-pohon (implementasi GroveHost).

import { randomUUID } from 'node:crypto'
import type {
  Account,
  BoardEntry,
  ChatMessage,
  GroveEvent,
  GroveSnapshot,
  ImageAttachment,
  InboxMessage,
  Memory,
  SessionMeta,
  TodoItem,
  TreeNode
} from '../../shared/types'
import { Board } from './db'
import { Session } from './Session'
import type { GroveHost } from './mcpTools'
import { contextPercent, contextWindowFor } from './contextWindows'

const MAX_WORKERS_PER_TREE = 12
const DEFAULT_MODEL: string | undefined = undefined // undefined = ikut default Claude Code
const ROOT_STATUS_DEBOUNCE_MS = 3000 // gabung beberapa laporan worker jadi 1 giliran root
const LOOP_INTERVAL_MS = 10 * 60_000 // auto-check "udah sampe mana?" tiap 10 menit (bisa diubah)

// Prompt auto-ping dibangun DINAMIS (lihat rootStatusPrompt/loopCheckPrompt) dengan ringkasan
// board disuntik langsung → root tak perlu memanggil read_board tiap ping (hemat konteks besar).

export class SessionManager implements GroveHost {
  private readonly sessions = new Map<string, Session>()
  private readonly rootStatusTimers = new Map<string, NodeJS.Timeout>() // treeId → debounce timer
  private readonly loopTimers = new Map<string, NodeJS.Timeout>() // rootId → timer auto-check berkala
  private readonly loopEnabled = new Set<string>() // rootId dengan auto-check aktif
  private autoSwitch = false // pindah akun otomatis saat kena limit
  private autoResume = false // saat app dibuka lagi, lanjutkan sesi yang tadinya kerja

  constructor(
    private readonly db: Board,
    private readonly emit: (ev: GroveEvent) => void
  ) {}

  // ---- pembuatan session ---------------------------------------------------

  /** Root baru dari drag-drop folder. Belum ada tugas — menunggu chat pertama user. */
  createRoot(cwd: string, title?: string): SessionMeta {
    const id = randomUUID()
    const meta = this.newMeta({
      id,
      treeId: id, // root: treeId = id-nya sendiri
      parentId: null,
      role: 'root',
      title: title || defaultTitle(cwd),
      cwd,
      model: DEFAULT_MODEL
    })
    this.db.upsertSession(meta)
    this.registerSession(meta, { emit: true, start: false }) // dormant sampai chat pertama
    return meta
  }

  /** GroveHost.spawnWorker — dipanggil oleh tool spawn_worker milik sebuah session. */
  async spawnWorker(parentId: string, opts: { title: string; task: string; model?: string }): Promise<string> {
    const parent = this.sessions.get(parentId)
    if (!parent) throw new Error(`Parent session ${parentId} tidak ditemukan`)

    const treeId = parent.meta.treeId
    const count = [...this.sessions.values()].filter((s) => s.meta.treeId === treeId).length
    if (count >= MAX_WORKERS_PER_TREE) {
      throw new Error(`Batas ${MAX_WORKERS_PER_TREE} worker per pohon tercapai`)
    }

    const id = randomUUID()
    const meta = this.newMeta({
      id,
      treeId,
      parentId,
      role: 'sub',
      title: opts.title,
      cwd: parent.meta.cwd, // worker default kerja di folder yang sama
      model: opts.model ?? parent.meta.model
    })
    meta.accountId = parent.meta.accountId // worker pakai akun yang sama dgn parent
    this.db.upsertSession(meta)
    this.registerSession(meta, { emit: true, start: true, task: opts.task })
    return id
  }

  /**
   * GroveHost.assignToWorker — beri tugas BARU ke worker yang SUDAH ada (reuse).
   * Tugas didorong ke inbox worker → worker resume dgn konteks utuh (start() lazy).
   * Isolasi: hanya boleh menyuruh session dalam pohon yang sama, dan bukan diri sendiri.
   */
  assignToWorker(callerId: string, workerId: string, task: string): void {
    const caller = this.sessions.get(callerId)
    const worker = this.sessions.get(workerId)
    if (!worker) throw new Error(`Worker ${workerId} tidak ditemukan`)
    if (workerId === callerId) throw new Error('Tidak bisa assign tugas ke diri sendiri')
    if (!caller || worker.meta.treeId !== caller.meta.treeId) {
      throw new Error(`Worker ${workerId} bukan di pohon kamu (isolasi antar-pohon)`)
    }
    worker.sendUserMessage(task)
  }

  private registerSession(
    meta: SessionMeta,
    opts: { emit?: boolean; start?: boolean; task?: string } = {}
  ): Session {
    const session = new Session(meta, this.db, this, this.emit)
    this.sessions.set(meta.id, session)
    if (opts.emit) {
      this.emit({
        channel: 'session:new',
        payload: { ...meta, ctxPercent: contextPercent(meta.ctxInput, meta.ctxWindow) }
      })
    }
    if (opts.start) session.start(opts.task)
    return session
  }

  /** Muat ulang session dari DB saat startup (dormant; resume saat di-chat lagi). */
  loadFromDisk(): void {
    // Sesi yang statusnya masih 'running'/'waiting' = tadi sedang kerja saat app ditutup.
    const wasWorking = this.db
      .getAllSessions()
      .filter((m) => m.status === 'running' || m.status === 'waiting')
      .map((m) => m.id)
    this.db.normalizeStaleStatuses()
    this.autoSwitch = this.db.getSetting('autoSwitch') === '1'
    this.autoResume = this.db.getSetting('autoResume') === '1'
    for (const meta of this.db.getAllSessions()) {
      if (this.sessions.has(meta.id)) continue
      this.registerSession(meta, { emit: false, start: false })
    }
    // Reconnect: bila diaktifkan, lanjutkan sesi-sesi yang tadi kerja (resume konteks + dorong lanjut).
    if (this.autoResume) for (const id of wasWorking) this.sessions.get(id)?.autoResume()
  }

  // ---- akun (multi-account) -------------------------------------------------

  private emitAccounts(): void {
    this.emit({
      channel: 'accounts:update',
      payload: { accounts: this.db.getAccounts(), autoSwitch: this.autoSwitch, autoResume: this.autoResume }
    })
  }

  listAccounts(): { accounts: Account[]; autoSwitch: boolean; autoResume: boolean } {
    return { accounts: this.db.getAccounts(), autoSwitch: this.autoSwitch, autoResume: this.autoResume }
  }

  addAccount(label: string, token: string): Account {
    const id = randomUUID()
    const now = Date.now()
    this.db.addAccount(id, label.trim() || 'Akun', token.trim(), now)
    this.emitAccounts()
    return { id, label: label.trim() || 'Akun', createdAt: now }
  }

  deleteAccount(id: string): void {
    this.db.deleteAccount(id)
    this.emitAccounts()
  }

  setAutoSwitch(on: boolean): void {
    this.autoSwitch = on
    this.db.setSetting('autoSwitch', on ? '1' : '0')
    this.emitAccounts()
  }

  setAutoResume(on: boolean): void {
    this.autoResume = on
    this.db.setSetting('autoResume', on ? '1' : '0')
    this.emitAccounts()
  }

  // GroveHost.getAccountToken
  getAccountToken(accountId?: string): string | null {
    return accountId ? this.db.getAccountToken(accountId) : null
  }

  /** Set akun sebuah session (null = login default); berlaku pada start/resume berikutnya. */
  setSessionAccount(sessionId: string, accountId: string | null): void {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`Session ${sessionId} tidak ditemukan`)
    s.meta.accountId = accountId ?? undefined
    s.meta.updatedAt = Date.now()
    this.db.upsertSession(s.meta)
    this.emit({ channel: 'session:update', payload: { id: sessionId, accountId: s.meta.accountId } })
    s.applyAccountChange() // kalau sedang jalan → henti; pesan berikutnya resume dgn token baru
  }

  /**
   * GroveHost.onLimitHit — dipanggil saat sebuah sesi kena limit pemakaian.
   * Bila auto-switch aktif & ada ≥2 akun: pindah ke akun berikutnya lalu LANJUTKAN otomatis
   * (resume konteks + inject "lanjutkan"). Guard anti-loop: bila sudah keliling semua akun
   * tanpa turn sukses, berhenti. Bila tak bisa switch, beri pesan jelas ke user.
   */
  onLimitHit(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const accts = this.db.getAccounts()

    // Tak bisa rotasi → berhenti dgn pesan yang menjelaskan cara mengaktifkan auto-lanjut.
    if (!this.autoSwitch || accts.length < 2) {
      s.systemNote(
        !this.autoSwitch
          ? '🚫 Kena limit pemakaian. Aktifkan "Auto-switch akun" di tab Akun agar otomatis pindah akun & lanjut. Kirim pesan lagi untuk coba lagi nanti.'
          : '🚫 Kena limit pemakaian. Tambah akun kedua di tab Akun agar bisa auto-switch & lanjut otomatis. Kirim pesan lagi untuk coba lagi nanti.'
      )
      s.markLimited()
      return
    }

    // Guard anti-loop: kalau sudah pindah sebanyak jumlah akun tanpa turn sukses → semua kena limit.
    if (s.bumpLimitStreak() > accts.length) {
      s.systemNote(`🚫 Semua ${accts.length} akun kena limit. Auto-switch dihentikan — coba lagi setelah limit reset.`)
      s.markLimited()
      return
    }

    const curIdx = accts.findIndex((a) => a.id === s.meta.accountId)
    const next = accts[(curIdx + 1) % accts.length]
    if (!next || next.id === s.meta.accountId) {
      s.markLimited()
      return
    }
    this.setSessionAccount(sessionId, next.id)
    s.systemNote(`🔀 Akun kena limit → pindah ke "${next.label}", melanjutkan otomatis…`)
    s.injectAutoTask(
      `[GROVE] Akun sebelumnya kena limit, sudah dipindah otomatis ke akun "${next.label}". Lanjutkan pekerjaan sebelumnya tepat dari titik terakhir tanpa mengulang dari awal.`
    )
  }

  private newMeta(p: {
    id: string
    treeId: string
    parentId: string | null
    role: SessionMeta['role']
    title: string
    cwd: string
    model?: string
  }): SessionMeta {
    const now = Date.now()
    return {
      id: p.id,
      treeId: p.treeId,
      parentId: p.parentId,
      role: p.role,
      title: p.title,
      cwd: p.cwd,
      model: p.model,
      status: 'idle',
      ctxInput: 0,
      ctxOutput: 0,
      ctxWindow: contextWindowFor(p.model),
      createdAt: now,
      updatedAt: now
    }
  }

  // ---- aksi dari UI --------------------------------------------------------

  sendChat(id: string, text: string, images?: ImageAttachment[]): void {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`Session ${id} tidak ditemukan`)
    // Auto-title dari pesan pertama bila judul masih default "Chat baru".
    if (s.meta.title === 'Chat baru' && text.trim()) this.setTitle(id, deriveTitle(text))
    s.sendUserMessage(text, images)
    // Tugas baru ke root → (re)nyalakan thread auto-check "udah sampe mana?".
    if (s.meta.role === 'root') this.enableLoop(id)
  }

  async stopSession(id: string): Promise<void> {
    await this.sessions.get(id)?.stop()
  }

  async interruptSession(id: string): Promise<void> {
    await this.sessions.get(id)?.interruptTurn()
  }

  /**
   * Reorder manual dari drag di sidebar. `orderedIds` = urutan baru anggota SATU grup
   * (role + parent sama). Ditegakkan: semua id harus segrup — tak bisa memindah lintas
   * level role atau lintas parent (mencegah reparent tak sengaja).
   */
  reorderSessions(orderedIds: string[]): void {
    if (orderedIds.length < 2) return
    const metas = orderedIds.map((id) => this.sessions.get(id)?.meta)
    if (metas.some((m) => !m)) throw new Error('Reorder: ada session yang tidak ditemukan')
    const first = metas[0]!
    const sameGroup = metas.every(
      (m) => m!.role === first.role && (m!.parentId ?? null) === (first.parentId ?? null)
    )
    if (!sameGroup) throw new Error('Reorder: hanya boleh dalam grup role+parent yang sama')
    const now = Date.now()
    orderedIds.forEach((id, i) => {
      const m = this.sessions.get(id)!.meta
      m.orderIndex = i
      m.updatedAt = now
      this.db.setOrderIndex(id, i, now)
      this.emit({ channel: 'session:update', payload: { id, orderIndex: i } })
    })
  }

  /**
   * Compact (tombol UTAMA): Grove SENDIRI menyusun ringkasan dari laporan board sub & sub-sub,
   * lalu LANGSUNG padatkan konteks root (compactWith) — TANPA giliran model. Jadi selalu berhasil
   * walau konteks penuh/macet, dan sekaligus membebaskan sesi yang lagi stuck.
   */
  compactSession(rootId: string): void {
    const root = this.sessions.get(rootId)
    if (!root) throw new Error('Session tidak ditemukan')
    if (root.meta.role !== 'root') throw new Error('Compact hanya untuk session UTAMA (root)')
    const treeId = root.meta.treeId
    const boardMap = new Map(this.db.getAllBoard().map((b) => [b.sessionId, b]))
    const lines: string[] = []
    for (const m of this.metaSnapshot()) {
      if (m.treeId !== treeId) continue
      const b = boardMap.get(m.id)
      lines.push(`- [${m.role}] ${m.title} (${m.status}${b?.percent != null ? `, ${b.percent}%` : ''})`)
      if (b?.summary) lines.push(`    ringkasan: ${b.summary}`)
      if (b?.progress) lines.push(`    progres: ${b.progress}`)
      if (b?.todo?.length) lines.push(`    todo: ${b.todo.map((t) => `${t.done ? '✓' : '○'} ${t.text}`).join('; ')}`)
    }
    const summary = `Ringkasan tugas pohon ini (dari laporan worker, hasil compact):\n${lines.join('\n') || '(belum ada laporan board)'}`
    const mem = this.db.addMemory(treeId, rootId, summary, Date.now())
    this.emit({ channel: 'memory:new', payload: mem })
    root.compactWith(summary) // reset konteks seketika + seed ringkasan untuk pesan berikutnya
  }

  /** GroveHost.notifyHighContext — ctx% ≥ ambang → auto-compact sesi ini (root=pohon, sub=diri). */
  notifyHighContext(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (s.meta.role === 'root') {
      this.compactSession(sessionId) // ringkasan dari seluruh board pohon
      return
    }
    // Sub: ringkasan dari board sub sendiri.
    const b = this.db.getBoardEntry(sessionId)
    const parts = [`Tugas: ${s.meta.title}`]
    if (b?.summary) parts.push(`Ringkasan: ${b.summary}`)
    if (b?.progress) parts.push(`Progres terakhir: ${b.progress}`)
    if (b?.todo?.length) parts.push(`Todo: ${b.todo.map((t) => `${t.done ? '✓' : '○'} ${t.text}`).join('; ')}`)
    const summary = `Ringkasan tugasmu (auto-compact karena konteks nyaris penuh):\n${parts.join('\n')}`
    const mem = this.db.addMemory(s.meta.treeId, sessionId, summary, Date.now())
    this.emit({ channel: 'memory:new', payload: mem })
    s.compactWith(summary)
  }

  /** GroveHost.saveCompaction — dipanggil tool save_compaction: simpan memori + padatkan konteks. */
  saveCompaction(sessionId: string, summary: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const mem = this.db.addMemory(s.meta.treeId, sessionId, summary, Date.now())
    this.emit({ channel: 'memory:new', payload: mem })
    s.scheduleCompact(summary) // konteks dipadatkan saat turn ini selesai
  }

  // ---- auto-check berkala (thread loop "udah sampe mana?") -------------------

  private enableLoop(rootId: string): void {
    const root = this.sessions.get(rootId)
    if (!root || root.meta.role !== 'root') return
    const wasOff = !this.loopEnabled.has(rootId)
    this.loopEnabled.add(rootId)
    this.scheduleLoop(rootId)
    if (wasOff) this.emit({ channel: 'session:update', payload: { id: rootId, loopActive: true } })
  }

  private stopLoop(rootId: string): void {
    this.clearLoopTimer(rootId)
    if (this.loopEnabled.delete(rootId)) {
      this.emit({ channel: 'session:update', payload: { id: rootId, loopActive: false } })
    }
  }

  private clearLoopTimer(rootId: string): void {
    const t = this.loopTimers.get(rootId)
    if (t) clearTimeout(t)
    this.loopTimers.delete(rootId)
  }

  private scheduleLoop(rootId: string): void {
    this.clearLoopTimer(rootId)
    this.loopTimers.set(rootId, setTimeout(() => this.runLoopCheck(rootId), LOOP_INTERVAL_MS))
  }

  /**
   * Tiap interval: dorong root untuk cek worker HANYA bila perlu — hemat konteks.
   * Skip kalau: root sedang running, belum ada worker, atau SEMUA worker masih running
   * (beneran lagi kerja → tak perlu ditanya). Cuma tanya kalau ada worker yg tak sedang jalan
   * (mangkrak/selesai) supaya bisa didorong lanjut / dilaporkan.
   */
  private runLoopCheck(rootId: string): void {
    this.loopTimers.delete(rootId)
    if (!this.loopEnabled.has(rootId)) return
    const root = this.sessions.get(rootId)
    if (!root || root.meta.role !== 'root') {
      this.stopLoop(rootId)
      return
    }
    const subs = [...this.sessions.values()].filter((s) => s.meta.treeId === rootId && s.meta.role === 'sub')
    const anyStalled = subs.some((s) => s.meta.status !== 'running') // ada worker yg tak sedang kerja
    if (root.meta.status !== 'running' && subs.length > 0 && anyStalled) {
      root.autoCheck(this.loopCheckPrompt(rootId))
    }
    this.scheduleLoop(rootId) // ulangi sampai task_done / dimatikan manual
  }

  /** Toggle dari UI. */
  setLoop(rootId: string, enabled: boolean): void {
    if (enabled) this.enableLoop(rootId)
    else this.stopLoop(rootId)
  }

  /** GroveHost.taskDone — root menandai seluruh tugas selesai → hentikan loop. */
  taskDone(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.meta.role !== 'root') return
    this.stopLoop(sessionId)
  }

  /** Stop All: interupsi turn SEMUA session (jadi idle) tanpa menutup — masih bisa dilanjut. */
  async stopAll(): Promise<number> {
    const running = [...this.sessions.values()].filter((s) => s.meta.status === 'running')
    await Promise.all(running.map((s) => s.interruptTurn().catch(() => {})))
    return running.length
  }

  /** Hapus session + seluruh sub-tree-nya (stop yang jalan, hapus dari DB). */
  async deleteSession(id: string): Promise<string[]> {
    const all = this.metaSnapshot()
    const toDelete: string[] = []
    const collect = (pid: string): void => {
      toDelete.push(pid)
      for (const m of all) if (m.parentId === pid) collect(m.id)
    }
    collect(id)
    for (const sid of toDelete) {
      await this.sessions.get(sid)?.stop()
      this.clearLoopTimer(sid)
      this.loopEnabled.delete(sid)
      this.sessions.delete(sid)
      this.db.deleteSession(sid)
    }
    this.emit({ channel: 'session:removed', payload: { ids: toDelete } })
    return toDelete
  }

  getChat(id: string): ChatMessage[] {
    return this.db.getChatMessages(id) // dari DB → tetap ada setelah restart
  }

  // GroveHost.setTitle
  setTitle(sessionId: string, title: string): void {
    const clean = title.trim().slice(0, 60) || 'Chat'
    const s = this.sessions.get(sessionId)
    if (s) {
      s.meta.title = clean
      s.meta.updatedAt = Date.now()
    }
    this.db.setTitle(sessionId, clean, Date.now())
    this.emit({ channel: 'session:update', payload: { id: sessionId, title: clean } })
  }

  // ---- GroveHost: papan tulis ----------------------------------------------

  updateSummary(sessionId: string, summary: string): void {
    this.db.setSummary(sessionId, summary, Date.now())
    this.emitBoard(sessionId)
  }
  updateTodo(sessionId: string, items: TodoItem[]): void {
    this.db.setTodo(sessionId, items, Date.now())
    this.emitBoard(sessionId)
  }
  reportProgress(sessionId: string, progress: string, percent?: number): void {
    this.db.setProgress(sessionId, progress, Date.now(), percent)
    this.emitBoard(sessionId)
  }

  /** Worker → root: update board (+persen), nota ke parent, lalu bangunkan root (debounce). */
  reportToParent(fromId: string, opts: { status: string; percent?: number }): void {
    const from = this.sessions.get(fromId)
    if (!from) return
    this.db.setProgress(fromId, opts.status, Date.now(), opts.percent)
    this.emitBoard(fromId)
    const parentId = from.meta.parentId
    if (!parentId) return // root tak punya parent → cukup update board (cegah wake diri sendiri)
    // ISOLASI: parent WAJIB di pohon yang sama. parentId selalu di-set sepohon saat spawn,
    // guard ini defensif agar laporan tak pernah bisa nyasar ke pohon (UTAMA) lain.
    const parent = this.sessions.get(parentId)
    if (!parent || parent.meta.treeId !== from.meta.treeId) return
    const pct = opts.percent == null ? '' : `${Math.max(0, Math.min(100, Math.round(opts.percent)))}% · `
    this.sendMessage(fromId, parentId, `[progress] ${pct}${opts.status}`)
    this.scheduleRootStatus(from.meta.treeId) // treeId = id root pohon INI → hanya membangunkan root sendiri
  }

  /** Safety-net: begitu satu turn worker selesai, bangunkan root untuk merangkum ke user. */
  notifyTurnEnd(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.meta.role !== 'sub') return // hanya sub-worker; root menyelesaikan turn ≠ pemicu
    this.scheduleRootStatus(s.meta.treeId)
  }

  /** Ringkasan board 1-baris/sesi untuk pohon ini — disuntik ke ping (ganti read_board = hemat konteks). */
  private treeBoardSummary(treeId: string): string {
    const boardMap = new Map(this.db.getAllBoard().map((b) => [b.sessionId, b]))
    const lines: string[] = []
    for (const m of this.metaSnapshot()) {
      if (m.treeId !== treeId) continue
      const b = boardMap.get(m.id)
      const pct = b?.percent != null ? `, ${b.percent}%` : ''
      const prog = b?.progress ? ` — ${b.progress}` : b?.summary ? ` — ${b.summary}` : ''
      lines.push(`- [${m.role}] ${m.title} (${m.status}${pct})${prog}`)
    }
    return lines.join('\n') || '(belum ada laporan)'
  }

  private rootStatusPrompt(treeId: string): string {
    return `[GROVE AUTO] Worker melapor progres. Ringkasan board pohonmu (JANGAN panggil read_board — ini sudah lengkap):\n${this.treeBoardSummary(treeId)}\n\nBeri user SATU baris update singkat dari ringkasan ini. Kalau semua worker sudah selesai, beri sintesis akhir.`
  }

  private loopCheckPrompt(treeId: string): string {
    return `[GROVE AUTO-CHECK] Udah sampai mana? Ringkasan board pohonmu (JANGAN panggil read_board — sudah lengkap):\n${this.treeBoardSummary(treeId)}\n\nDari ringkasan itu: kalau ADA worker idle yang tugasnya BELUM selesai, dorong lanjut (mcp__grove__list_workers untuk id → mcp__grove__assign_worker). Beri user update singkat. Kalau SEMUA selesai, panggil mcp__grove__task_done.`
  }

  /** Debounce: banyak laporan worker berdekatan → satu kali bangunkan root. */
  private scheduleRootStatus(treeId: string): void {
    if (!this.sessions.has(treeId)) return // root sudah tak ada
    const prev = this.rootStatusTimers.get(treeId)
    if (prev) clearTimeout(prev)
    this.rootStatusTimers.set(
      treeId,
      setTimeout(() => {
        this.rootStatusTimers.delete(treeId)
        const root = this.sessions.get(treeId)
        if (root && root.meta.role === 'root') root.injectAutoTask(this.rootStatusPrompt(treeId))
      }, ROOT_STATUS_DEBOUNCE_MS)
    )
  }

  private emitBoard(sessionId: string): void {
    const entry = this.db.getBoardEntry(sessionId)
    if (entry) this.emit({ channel: 'board:update', payload: entry })
  }

  /** Read-only, boleh lintas pohon (scope 'all') atau hanya pohon caller ('tree'). */
  readBoard(
    sessionId: string,
    scope: 'tree' | 'all'
  ): (BoardEntry & { title: string; treeId: string; role: string; status: string })[] {
    const caller = this.sessions.get(sessionId)
    const callerTree = caller?.meta.treeId
    const metaById = new Map(this.metaSnapshot().map((m) => [m.id, m]))
    return this.db
      .getAllBoard()
      .filter((b) => {
        const m = metaById.get(b.sessionId)
        if (!m) return false
        return scope === 'all' ? true : m.treeId === callerTree
      })
      .map((b) => {
        const m = metaById.get(b.sessionId)!
        return { ...b, title: m.title, treeId: m.treeId, role: m.role, status: m.status }
      })
  }

  sendMessage(fromId: string, to: string | null, body: string): void {
    const fromTree = this.sessions.get(fromId)?.meta.treeId
    // ISOLASI: pesan ke target spesifik hanya boleh ke session SEPOHON (tak boleh nyasar ke pohon lain).
    if (to) {
      const target = this.sessions.get(to)
      if (!target || target.meta.treeId !== fromTree) {
        throw new Error('Isolasi: hanya bisa kirim pesan ke session dalam pohon yang sama')
      }
    }
    const msg = this.db.addMessage(fromId, to, body, Date.now())
    this.emit({ channel: 'message:new', payload: msg })
  }

  readMessages(sessionId: string, unreadOnly: boolean): InboxMessage[] {
    // ISOLASI: hanya tampilkan pesan dari pengirim SEPOHON (broadcast pun tak lintas-pohon).
    const myTree = this.sessions.get(sessionId)?.meta.treeId
    const treeOf = new Map(this.metaSnapshot().map((m) => [m.id, m.treeId]))
    const msgs = this.db
      .getMessagesFor(sessionId, unreadOnly)
      .filter((m) => treeOf.get(m.from) === myTree)
    this.db.markRead(msgs.filter((m) => !m.read).map((m) => m.id))
    return msgs
  }

  /** Hanya session dalam pohon caller (isolasi). */
  listWorkers(sessionId: string): { id: string; title: string; role: string; status: string }[] {
    const tree = this.sessions.get(sessionId)?.meta.treeId
    return this.metaSnapshot()
      .filter((m) => m.treeId === tree)
      .map((m) => ({ id: m.id, title: m.title, role: m.role, status: m.status }))
  }

  // ---- snapshot untuk UI ---------------------------------------------------

  private metaSnapshot(): SessionMeta[] {
    // Pakai meta in-memory (paling mutakhir); fallback ke DB untuk yang tak ada di map.
    const live = new Map([...this.sessions.values()].map((s) => [s.meta.id, s.meta]))
    for (const m of this.db.getAllSessions()) if (!live.has(m.id)) live.set(m.id, m)
    return [...live.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  getSnapshot(): GroveSnapshot {
    const metas = this.metaSnapshot()
    const boardMap = new Map(this.db.getAllBoard().map((b) => [b.sessionId, b]))
    const nodeById = new Map<string, TreeNode>()
    for (const m of metas) {
      nodeById.set(m.id, {
        ...m,
        ctxPercent: contextPercent(m.ctxInput, m.ctxWindow),
        board: boardMap.get(m.id),
        loopActive: this.loopEnabled.has(m.id),
        children: []
      })
    }
    const roots: TreeNode[] = []
    for (const node of nodeById.values()) {
      if (node.parentId && nodeById.has(node.parentId)) {
        nodeById.get(node.parentId)!.children.push(node)
      } else {
        roots.push(node)
      }
    }
    return {
      trees: roots,
      board: [...boardMap.values()],
      messages: this.db.getAllMessages(),
      memories: this.db.getAllMemories()
    }
  }
}

function defaultTitle(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

/** Judul sementara dari pesan pertama (dipakai sampai agent set_title yang lebih rapi). */
function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0].trim()
  const words = firstLine.split(/\s+/).slice(0, 6).join(' ')
  return (words.length > 48 ? words.slice(0, 48) + '…' : words) || 'Chat'
}
