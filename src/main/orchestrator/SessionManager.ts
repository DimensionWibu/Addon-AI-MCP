// Orkestrator: kelola semua Session (banyak pohon), spawn sub-worker, bangun pohon
// untuk UI, dan tegakkan isolasi antar-pohon (implementasi GroveHost).

import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import type {
  Account,
  AccountProvider,
  AccountsState,
  BoardEntry,
  ChatMessage,
  GroveEvent,
  GroveSnapshot,
  ImageAttachment,
  InboxMessage,
  Memory,
  SessionMeta,
  TodoItem,
  TreeNode,
  UsageByAccount,
  UsageDay,
  UsageStats,
  UsageTokens
} from '../../shared/types'
import { OPENROUTER_BASE_URL } from '../../shared/types'
import { Board } from './db'
import { Session } from './Session'
import { cap, CAP_MESSAGE, CAP_PROGRESS, type GroveHost } from './mcpTools'
import { contextPercent, contextWindowFor } from './contextWindows'

const MAX_WORKERS_PER_TREE = 12
const DEFAULT_MODEL: string | undefined = undefined // undefined = ikut default Claude Code
// Tiap wake = SATU giliran root penuh (konteks root dikirim ulang → biaya usage nyata).
// Debounce panjang menggabungkan banyak laporan worker jadi 1 giliran saja (hemat besar).
const ROOT_STATUS_DEBOUNCE_MS = 60_000
const LOOP_INTERVAL_MS = 10 * 60_000 // auto-check "udah sampe mana?" tiap 10 menit (bisa diubah)
const IDLE_CHECK_LIMIT = 3 // auto-check beruntun tanpa perubahan → stop loop (cegah bakar usage)
const LIMIT_COOLDOWN_MS = 30 * 60_000 // akun yang kena limit dianggap "tak tersedia" selama ini
// Ambang BAWAAN: pindah akun SEBELUM kena limit (bukan setelah). Dipakai akun yang tak menyetel
// ambangnya sendiri (Account.switchPct). Nilai efektif per akun → switchPctFor().
export const DEFAULT_SWITCH_PCT = 90
const SWITCH_PCT_MIN = 50 // di bawah ini rotasi jadi terlalu agresif (buang-buang kuota akun)
const SWITCH_PCT_MAX = 99 // 100 = tak pernah memicu; itu sama saja mematikan auto-switch

/** Jaga ambang tetap masuk akal walau UI/IPC mengirim nilai ngawur (NaN, 0, 500, pecahan). */
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULT_SWITCH_PCT
  return Math.min(SWITCH_PCT_MAX, Math.max(SWITCH_PCT_MIN, Math.round(pct)))
}
const DEFAULT_ACCT_KEY = '__default__' // penanda sesi yang memakai login CLI (bukan akun tersimpan)
// COALESCE laporan worker → parent. Pemboros token DOMINAN bukan besar teksnya, melainkan JUMLAH
// GILIRAN: tiap injectAutoTask membuat giliran baru yang menagih ULANG seluruh konteks parent yang
// menumpuk. Dengan N worker, parent bisa dapat N giliran per ronde. Jendela ini menggabungkannya
// jadi SATU giliran berisi ringkasan semua worker yang melapor di dalamnya.
const WORKER_REPORT_COALESCE_MS = 12_000 // jendela gabung (batching, BUKAN debounce geser)
const REPORT_PRIORITY_MS = 800 // flush cepat saat ada worker SELESAI (100%) — tetap menggabung burst
const MAX_BOARD_ROWS = 40 // batas baris read_board agar tak membanjiri konteks pemanggil

/** Satu laporan worker yang menunggu digabung ke parent-nya (hanya yang TERBARU per worker). */
interface PendingWorkerReport {
  workerId: string
  title: string
  line: string // ringkasan 1-baris hasil worker
  filePath: string // file hasil lengkap (boleh kosong)
  percent?: number
  done: boolean // worker sudah tuntas → flush diprioritaskan & tak boleh di-skip
  ts: number
}

// Prompt auto-ping dibangun DINAMIS (lihat rootStatusPrompt/loopCheckPrompt) dengan ringkasan
// board disuntik langsung → root tak perlu memanggil read_board tiap ping (hemat konteks besar).

export class SessionManager implements GroveHost {
  private readonly sessions = new Map<string, Session>()
  private readonly rootStatusTimers = new Map<string, NodeJS.Timeout>() // treeId → debounce timer
  private readonly lastPingSummary = new Map<string, string>() // treeId → board saat ping terakhir (dedupe)
  // rootId → SIGNATURE sub-board saat auto-check terakhir (lihat subBoardSignature). SENGAJA bukan
  // treeBoardSummary: ringkasan itu memuat BARIS ROOT SENDIRI + field volatil (title), sehingga
  // balasan root sendiri (update_summary/set_title/assign_worker) me-reset streak → 3-strike tak
  // pernah tercapai dan loop bisa berjalan TANPA BATAS.
  private readonly lastLoopSummary = new Map<string, string>()
  private readonly loopIdleStreak = new Map<string, number>() // rootId → auto-check beruntun tanpa perubahan
  private readonly loopDonePinged = new Set<string>() // rootId yang sudah dapat SATU ping penutup "semua sub done"
  private readonly limitedAt = new Map<string, number>() // accountKey → kapan terbukti kena limit
  private readonly loopTimers = new Map<string, NodeJS.Timeout>() // rootId → timer auto-check berkala
  private readonly loopEnabled = new Set<string>() // rootId dengan auto-check aktif
  // Buffer coalesce laporan worker → parentId → (workerId → laporan TERBARU worker itu).
  // Map per-worker = DEDUPE otomatis: progres lama ditimpa, hanya yang terakhir yang dikirim.
  private readonly pendingReports = new Map<string, Map<string, PendingWorkerReport>>()
  private readonly reportTimers = new Map<string, NodeJS.Timeout>() // parentId → timer flush
  private readonly lastReportSig = new Map<string, string>() // parentId → isi flush terakhir (anti giliran kosong)
  // Akun yang user PILIH sendiri untuk sebuah sesi (bukan hasil auto-switch). Auto-switch akibat limit
  // bersifat SEMENTARA: begitu akun pilihan bisa dipakai lagi, sesi dikembalikan ke sana
  // (restorePinnedAccounts) supaya billing tidak menetap di akun lain / nyangkut di login default.
  private readonly pinnedAccount = new Map<string, string | null>() // sessionId → accountId pilihan user
  private autoSwitch = false // pindah akun otomatis saat kena limit
  private autoResume = false // saat app dibuka lagi, lanjutkan sesi yang tadinya kerja
  private defaultSwitchPct = DEFAULT_SWITCH_PCT // ambang untuk akun tanpa ambang sendiri
  private defaultAccountId: string | null = null // akun GLOBAL: dipakai pohon yang tak menentukan sendiri
  private defaultModel: string | null = null // model GLOBAL: dipakai sesi yang tak menentukan sendiri (null = default SDK)
  // Akun yang usage-nya terbukti TAK bisa dibaca (403 scope). Dipakai UI untuk jujur bilang
  // "ambang non-aktif" alih-alih memberi kesan proteksi proaktif menyala padahal tidak.
  private readonly usageReadable = new Map<string, boolean>()

  constructor(
    private readonly db: Board,
    private readonly emit: (ev: GroveEvent) => void
  ) {}

  // ---- pembuatan session ---------------------------------------------------

  /** Root baru. `lite` = mode ringan CLI-parity (chat solo tanpa protokol/tool orkestrasi).
   *  Default dari drag-drop folder: lite=false (orkestrator); "+Chat" folderless: lite=true. */
  createRoot(cwd: string, title?: string, lite = false): SessionMeta {
    const id = randomUUID()
    const meta = this.newMeta({
      id,
      treeId: id, // root: treeId = id-nya sendiri
      parentId: null,
      role: 'root',
      title: title || defaultTitle(cwd),
      cwd,
      model: DEFAULT_MODEL,
      lite
    })
    this.db.upsertSession(meta)
    this.registerSession(meta, { emit: true, start: false }) // dormant sampai chat pertama
    return meta
  }

  /**
   * Kunci sesi yang SUDAH ADA ke sebuah folder project (drag-drop folder ke kartu sesi).
   *
   * cwd menentukan IDENTITAS PROJECT di Claude Code (dan karenanya direktori memorinya), tapi cwd
   * sebuah sesi SDK yang sudah berjalan TIDAK bisa diubah di tempat. Karena itu:
   *  - sesi yang BELUM punya sesi SDK → cukup ganti meta.cwd + persist; query pertamanya nanti
   *    langsung lahir dengan cwd baru.
   *  - sesi yang SUDAH punya sesi SDK → pakai resetForNewTask() (mesin yang sudah ada): ia
   *    men-drop sdkSessionId & menghentikan query lama, sehingga query BERIKUTNYA lahir dengan cwd
   *    baru. Konsekuensinya konteks lama dilepas — dan itu memang benar secara semantik: ganti
   *    project = ganti konteks. TIDAK dilakukan diam-diam: ada nota sistem yang jelas di chat.
   *
   * Sub-worker yang SUDAH jalan sengaja TIDAK dipaksa ikut pindah (biar tak memotong kerjanya);
   * sub-worker BARU otomatis mewarisi cwd parent lewat spawnWorker.
   */
  setSessionCwd(sessionId: string, dir: string): SessionMeta {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`Session ${sessionId} tidak ditemukan`)
    // Validasi otoritatif — berlaku untuk semua pemanggil, bukan cuma jalur IPC.
    if (!dir) throw new Error('Path folder kosong')
    if (!existsSync(dir)) throw new Error(`Folder tidak ditemukan: ${dir}`)
    if (!statSync(dir).isDirectory()) throw new Error(`Bukan folder (drop sebuah FOLDER, bukan file): ${dir}`)
    if (s.meta.cwd === dir) return s.meta // sudah terkunci di sana → no-op

    const hadSdkSession = !!s.meta.sdkSessionId
    s.meta.cwd = dir
    s.meta.updatedAt = Date.now()
    this.db.upsertSession(s.meta) // persist → tahan restart

    if (hadSdkSession) {
      // Drop sesi SDK lama supaya query berikutnya memakai cwd baru (resetForNewTask juga
      // meng-upsert meta, jadi cwd baru ikut tersimpan).
      s.resetForNewTask()
      s.systemNote(
        `📁 Folder kerja sesi ini dipindah ke: ${dir}\n` +
          '⚠️ Karena folder project berubah, KONTEKS percakapan sebelumnya dilepas (ganti project = ganti konteks). ' +
          'Pesan berikutnya mulai dari sesi bersih di folder baru.'
      )
    } else {
      s.systemNote(`📁 Folder kerja sesi ini diatur ke: ${dir}`)
    }
    this.emit({ channel: 'session:update', payload: { id: sessionId, cwd: dir } })
    return s.meta
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
      // model: HANYA diisi bila spawn menyebut model eksplisit. Kalau tidak, dibiarkan kosong =
      // "ikut sesi utama" (resolveModel), sama seperti accountId — jadi ganti model di root menular
      // ke worker yang belum menentukan model sendiri, dan worker yang diubah SESUDAHNYA menang.
      model: opts.model
    })
    // SENGAJA TIDAK menyalin accountId/model parent. Dulu keduanya disalin saat spawn, jadi ganti akun
    // atau model di sesi utama TIDAK menular ke worker yang sudah lahir — satu pohon bisa terbelah
    // (billing/model tercecer). Sekarang kosong = "ikut induk", nilai efektif dihitung saat dipakai.
    this.db.upsertSession(meta)
    this.registerSession(meta, { emit: true, start: true, task: opts.task })
    return id
  }

  /**
   * GroveHost.assignToWorker — beri tugas BARU ke worker yang SUDAH ada (reuse).
   * `opts.fresh` DEFAULT TRUE: buang konteks topik sebelumnya (resetForNewTask) sebelum tugas
   * baru → cegah "sub kebawa topik sibling". Set fresh=false HANYA untuk kelanjutan topik yang
   * SAMA (pertahankan konteks). resetForNewTask sekaligus meng-interrupt query lama, jadi worker
   * yang masih running tak meng-interleave dua tugas di satu percakapan.
   * Isolasi: hanya boleh menyuruh session dalam pohon yang sama, dan bukan diri sendiri.
   */
  assignToWorker(callerId: string, workerId: string, task: string, opts?: { fresh?: boolean }): void {
    const caller = this.sessions.get(callerId)
    const worker = this.sessions.get(workerId)
    if (!worker) throw new Error(`Worker ${workerId} tidak ditemukan`)
    if (workerId === callerId) throw new Error('Tidak bisa assign tugas ke diri sendiri')
    if (!caller || worker.meta.treeId !== caller.meta.treeId) {
      throw new Error(`Worker ${workerId} bukan di pohon kamu (isolasi antar-pohon)`)
    }
    const fresh = opts?.fresh !== false // default: konteks BERSIH untuk tugas baru independen
    if (fresh) worker.resetForNewTask() // drop transkrip topik lama + hentikan query lama (anti-interleave)
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
    // Sesi yang statusnya masih 'running' = tadi sedang kerja saat app ditutup.
    // (Status legacy 'waiting' sudah dipetakan ke 'idle' oleh normalizeStatus saat baris dibaca —
    //  ia memang tak pernah di-set kode mana pun, jadi tak ada kerja nyata yang hilang di sini.)
    const wasWorking = this.db
      .getAllSessions()
      .filter((m) => m.status === 'running')
      .map((m) => m.id)
    this.db.normalizeStaleStatuses()
    this.autoSwitch = this.db.getSetting('autoSwitch') === '1'
    this.autoResume = this.db.getSetting('autoResume') === '1'
    const savedPct = Number(this.db.getSetting('defaultSwitchPct'))
    this.defaultSwitchPct = Number.isFinite(savedPct) && savedPct > 0 ? clampPct(savedPct) : DEFAULT_SWITCH_PCT
    this.defaultAccountId = this.db.getSetting('defaultAccountId') || null
    this.defaultModel = this.db.getSetting('defaultModel') || null
    // Pin akun pilihan user TAHAN RESTART: tanpa ini restorePinnedAccounts() kehilangan target dan
    // sesi yang tadi sempat di-auto-switch (mis. ke akun login utama) nyangkut di sana selamanya.
    for (const p of this.db.getAllSessionPins()) this.pinnedAccount.set(p.sessionId, p.accountId)
    for (const meta of this.db.getAllSessions()) {
      if (this.sessions.has(meta.id)) continue
      this.registerSession(meta, { emit: false, start: false })
    }
    // Reconnect: bila diaktifkan, lanjutkan sesi-sesi yang tadi kerja (resume konteks + dorong lanjut).
    if (this.autoResume) for (const id of wasWorking) this.sessions.get(id)?.autoResume()
  }

  // ---- akun (multi-account) -------------------------------------------------

  /** Daftar akun + status keterbacaan usage (ditempel di sini, bukan disimpan di DB: ini fakta runtime). */
  private accountsWithStatus(): Account[] {
    return this.db.getAccounts().map((a) => ({ ...a, usageReadable: this.usageReadable.get(a.id) }))
  }

  private emitAccounts(): void {
    this.emit({ channel: 'accounts:update', payload: this.listAccounts() })
  }

  listAccounts(): AccountsState {
    return {
      accounts: this.accountsWithStatus(),
      autoSwitch: this.autoSwitch,
      autoResume: this.autoResume,
      defaultSwitchPct: this.defaultSwitchPct,
      defaultAccountId: this.accountExists(this.defaultAccountId) ? this.defaultAccountId : null,
      defaultModel: this.defaultModel
    }
  }

  addAccount(
    label: string,
    token: string,
    plan?: number,
    switchPct?: number,
    provider?: AccountProvider,
    model?: string,
    baseUrl?: string
  ): Account {
    const id = randomUUID()
    const now = Date.now()
    const clean = label.trim() || 'Akun'
    const pct = switchPct == null ? undefined : clampPct(switchPct)
    const prov: AccountProvider =
      provider === 'openrouter' ? 'openrouter' : provider === 'custom' ? 'custom' : 'claude'
    // openrouter & custom sama-sama "Anthropic Skin" → keduanya memaksa model akun sendiri.
    const skin = prov === 'openrouter' || prov === 'custom'
    const orModel = skin ? model?.trim() || undefined : undefined
    // base URL hanya untuk 'custom' (proxy sendiri). openrouter pakai konstanta tetap.
    const url = prov === 'custom' ? baseUrl?.trim() || undefined : undefined
    this.db.addAccount(id, clean, token.trim(), now, plan, pct, prov, orModel, url)
    this.emitAccounts()
    return { id, label: clean, plan, switchPct: pct, provider: prov, model: orModel, baseUrl: url, createdAt: now }
  }

  deleteAccount(id: string): void {
    this.db.deleteAccount(id)
    this.usageReadable.delete(id)
    this.emitAccounts()
  }

  /** Ambang khusus akun ini; null → kembali ikut default global. */
  setAccountSwitchPct(id: string, pct: number | null): void {
    this.db.setAccountSwitchPct(id, pct == null ? null : clampPct(pct))
    this.emitAccounts()
  }

  setDefaultSwitchPct(pct: number): void {
    this.defaultSwitchPct = clampPct(pct)
    this.db.setSetting('defaultSwitchPct', String(this.defaultSwitchPct))
    this.emitAccounts()
  }

  /** Ambang EFEKTIF sebuah akun: punya sendiri → itu; kalau tidak → default global. */
  switchPctFor(accountId: string | null): number {
    if (!accountId) return this.defaultSwitchPct
    const a = this.db.getAccounts().find((x) => x.id === accountId)
    return a?.switchPct ?? this.defaultSwitchPct
  }

  /**
   * Dicatat oleh watchdog usage: apakah persentase akun ini benar-benar terbaca.
   * PENTING untuk kejujuran UI — token `claude setup-token` membalas 403 (tanpa scope user:profile),
   * jadi ambang akun itu TIDAK PERNAH bisa memicu apa pun dan user berhak tahu.
   */
  noteUsageReadable(accountId: string, readable: boolean): void {
    if (this.usageReadable.get(accountId) === readable) return // tak berubah → jangan spam event
    this.usageReadable.set(accountId, readable)
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

  // GroveHost.getAccountToken — TIDAK ada fallback ke login CLI: tanpa accountId = tanpa token.
  getAccountToken(accountId?: string): string | null {
    return accountId ? this.db.getAccountToken(accountId) : null
  }

  /** Akun itu masih ada di DB? Dipakai agar id yatim (akun terhapus) tak dianggap pilihan sah. */
  private accountExists(id: string | null): id is string {
    return id != null && this.db.getAccounts().some((a) => a.id === id)
  }

  /**
   * AKUN EFEKTIF sebuah sesi — dihitung saat dipakai, BUKAN disalin saat sesi dibuat.
   * Rantainya: akun sesi ini → akun sesi UTAMA (root pohon) → akun GLOBAL.
   *
   * Konsekuensi yang memang diinginkan: mengganti akun di sesi utama langsung berlaku ke seluruh
   * sub-sesi pohon itu (yang tak menentukan akun sendiri), tanpa perlu menyentuh satu per satu.
   * Id akun yang sudah dihapus diabaikan di tiap tingkat supaya tak "menyumbat" rantai — kalau
   * tidak, sesi bisa mati total padahal akun global masih sehat.
   */
  resolveAccountId(sessionId: string): string | null {
    const s = this.sessions.get(sessionId)
    if (!s) return this.accountExists(this.defaultAccountId) ? this.defaultAccountId : null
    if (this.accountExists(s.meta.accountId ?? null)) return s.meta.accountId as string
    // treeId = id sesi utama pohon ini (root: treeId = id-nya sendiri).
    const root = this.sessions.get(s.meta.treeId)
    if (root && root.meta.id !== s.meta.id && this.accountExists(root.meta.accountId ?? null)) {
      return root.meta.accountId as string
    }
    return this.accountExists(this.defaultAccountId) ? this.defaultAccountId : null
  }

  /** GroveHost.getSessionToken — token akun EFEKTIF sesi ini (lihat resolveAccountId). */
  getSessionToken(sessionId: string): string | null {
    const id = this.resolveAccountId(sessionId)
    return id ? this.db.getAccountToken(id) : null
  }

  /** Akun EFEKTIF sesi ini sebagai objek (untuk tahu provider/model), atau null. */
  private effectiveAccount(sessionId: string): Account | null {
    const id = this.resolveAccountId(sessionId)
    return id ? (this.db.getAccounts().find((a) => a.id === id) ?? null) : null
  }

  /**
   * GroveHost.getSessionLaunch — semua yang dibutuhkan query untuk sesi ini: token + env provider
   * (Claude vs OpenRouter) + model efektif. null = tak ada akun → sesi tak boleh jalan.
   * Env provider dibangun DI SINI supaya Session tak perlu tahu detail tiap provider.
   */
  getSessionLaunch(sessionId: string): { env: Record<string, string>; model?: string } | null {
    const acc = this.effectiveAccount(sessionId)
    if (!acc) return null
    const token = this.db.getAccountToken(acc.id)
    if (!token) return null
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    if (acc.provider === 'openrouter' || acc.provider === 'custom') {
      // "Anthropic Skin": Claude Code kirim format Anthropic, endpoint yang menerjemahkan.
      // openrouter → base URL tetap; custom → base URL milik akun (proxy sendiri, mis. Gemini).
      env.ANTHROPIC_BASE_URL = acc.provider === 'custom' ? acc.baseUrl || OPENROUTER_BASE_URL : OPENROUTER_BASE_URL
      env.ANTHROPIC_AUTH_TOKEN = token
      delete env.ANTHROPIC_API_KEY // AUTH_TOKEN yang jadi bearer; API_KEY bisa bentrok
      delete env.CLAUDE_CODE_OAUTH_TOKEN // jangan sampai malah dipakai token Claude
    } else {
      // Claude: token OAuth langganan. ANTHROPIC_* dibuang supaya tak mengalahkan token ini.
      env.CLAUDE_CODE_OAUTH_TOKEN = token
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
      delete env.ANTHROPIC_BASE_URL
    }
    return { env, model: this.resolveModel(sessionId) }
  }

  /**
   * MODEL EFEKTIF sebuah sesi — persis pola resolveAccountId: model sesi → model sesi UTAMA → model
   * GLOBAL → undefined (biar SDK pakai default-nya). Dihitung saat dipakai, jadi ganti model di sesi
   * utama otomatis menular ke sub-sesi yang tak menentukan model sendiri. Sub yang modelnya diubah
   * SESUDAH itu (meta.model terisi) menang atas warisan.
   */
  resolveModel(sessionId: string): string | undefined {
    // Akun OpenRouter memaksa MODEL-nya sendiri: alias Claude (opus/sonnet/haiku) tak sah di sana,
    // jadi model akun (id OpenRouter) menang mutlak. Kecuali sesi/rootnya sengaja diisi id ber-"/"
    // (juga id OpenRouter) → hormati sebagai override sadar.
    const acc = this.effectiveAccount(sessionId)
    // Akun 'custom' (proxy): nama model ditentukan proxy, tak ada daftar/alias di Grove → pakai
    // model akun apa adanya untuk seluruh pohon (buat varian model = buat akun lain ke proxy sama).
    if (acc?.provider === 'custom') return acc.model || undefined
    if (acc?.provider === 'openrouter') {
      const s = this.sessions.get(sessionId)
      const own = s?.meta.model
      if (own && own.includes('/')) return own
      const root = s ? this.sessions.get(s.meta.treeId) : undefined
      if (root && root.meta.id !== s?.meta.id && root.meta.model?.includes('/')) return root.meta.model
      return acc.model || undefined
    }
    const s = this.sessions.get(sessionId)
    if (!s) return this.defaultModel ?? undefined
    if (s.meta.model) return s.meta.model
    const root = this.sessions.get(s.meta.treeId)
    if (root && root.meta.id !== s.meta.id && root.meta.model) return root.meta.model
    return this.defaultModel ?? undefined
  }

  /** GroveHost.getSessionModel — model EFEKTIF sesi ini untuk di-inject ke query. */
  getSessionModel(sessionId: string): string | undefined {
    return this.resolveModel(sessionId)
  }

  /** Model global: dipakai semua sesi yang tak menentukan model sendiri. null = default SDK. */
  setDefaultModel(model: string | null): void {
    const clean = model?.trim() || null
    // Sama seperti setDefaultAccount: hanya restart sesi yang model EFEKTIF-nya benar-benar berubah.
    const before = new Map([...this.sessions.keys()].map((id) => [id, this.resolveModel(id)]))
    this.defaultModel = clean
    this.db.setSetting('defaultModel', clean ?? '')
    for (const [id, prev] of before) {
      const s = this.sessions.get(id)
      if (s && this.resolveModel(id) !== prev) {
        s.meta.ctxWindow = contextWindowFor(this.resolveModel(id))
        s.restartQuery()
      }
    }
    this.emitAccounts()
  }

  /** Set model sebuah sesi (null = kembali mewarisi). Sub-sesi yang menumpang ikut berubah. */
  setSessionModel(sessionId: string, model: string | null): void {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`Session ${sessionId} tidak ditemukan`)
    const clean = model?.trim() || undefined
    const before = new Map([...this.sessions.keys()].map((id) => [id, this.resolveModel(id)]))
    s.meta.model = clean
    s.meta.updatedAt = Date.now()
    this.db.upsertSession(s.meta)
    for (const [id, prev] of before) {
      const sess = this.sessions.get(id)
      if (sess && this.resolveModel(id) !== prev) {
        // ctxWindow ikut model (mis. varian [1m] = 1 juta) → % konteks tetap benar.
        sess.meta.ctxWindow = contextWindowFor(this.resolveModel(id))
        this.emit({
          channel: 'session:update',
          payload: { id, model: sess.meta.model, ctxPercent: contextPercent(sess.meta.ctxInput, sess.meta.ctxWindow) }
        })
        sess.restartQuery()
      }
    }
  }

  /** Akun global: dipakai semua pohon yang tak menentukan akun sendiri. null = tidak ada. */
  setDefaultAccount(accountId: string | null): void {
    // Rekam akun EFEKTIF tiap sesi SEBELUM berubah, lalu banding sesudahnya. Tanpa perbandingan ini
    // kita akan meng-interrupt query sesi yang akun efektifnya sebenarnya tak berubah (punya akun
    // sendiri / ikut root yang eksplisit) — kerja terhenti sia-sia.
    const before = new Map([...this.sessions.keys()].map((id) => [id, this.resolveAccountId(id)]))
    this.defaultAccountId = accountId
    this.db.setSetting('defaultAccountId', accountId ?? '')
    for (const [id, prev] of before) {
      if (this.resolveAccountId(id) !== prev) this.sessions.get(id)?.restartQuery()
    }
    this.emitAccounts()
  }

  /**
   * GroveHost.onAccountMissing — sesi berhenti karena tak punya token. Bukan alasan mematikan app:
   * kirim event supaya UI memunculkan banner "belum ada akun yang dipakai" sambil tetap bisa dipakai
   * (kelola akun, baca riwayat, pilih akun untuk sesi ini).
   */
  onAccountMissing(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    this.emit({
      channel: 'auth:missing',
      payload: {
        sessionId,
        sessionTitle: s?.meta.title ?? sessionId,
        tokenMissing: Boolean(s?.meta.accountId),
        hasAccounts: this.db.getAccounts().length > 0
      }
    })
  }

  /**
   * GroveHost.recordUsage — catat pemakaian token satu respons API ke bucket jam+akun di DB.
   * accountId = akun EFEKTIF sesi (resolveAccountId); '__none__' bila tak terpetakan (jaga-jaga).
   */
  recordUsage(sessionId: string, u: { input: number; cacheRead: number; cacheCreation: number; output: number }): void {
    if (u.input <= 0 && u.cacheRead <= 0 && u.cacheCreation <= 0 && u.output <= 0) return
    const accId = this.resolveAccountId(sessionId)
    const provider = accId ? (this.db.getAccounts().find((a) => a.id === accId)?.provider ?? 'claude') : null
    const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000
    this.db.addUsage(hourStart, accId ?? '__none__', provider, u.input, u.cacheRead, u.cacheCreation, u.output)
  }

  /**
   * Riwayat pemakaian token PC ini: jendela jam/hari/minggu + breakdown harian + per akun, dihitung
   * dari bucket jam (TZ LOKAL, pakai new Date main-process). todayVsAvg membantu vonis boros/normal.
   */
  getUsageStats(): UsageStats {
    const now = Date.now()
    const DAY = 86_400_000
    const rows = this.db.getUsageRows(now - 15 * DAY) // cukup untuk minggu + tren 14 hari
    const labels = new Map(this.db.getAccounts().map((a) => [a.id, a.label]))
    const providers = new Map(this.db.getAccounts().map((a) => [a.id, a.provider ?? 'claude']))

    const blank = (): { input: number; cacheRead: number; cacheCreation: number; output: number; calls: number } => ({
      input: 0, cacheRead: 0, cacheCreation: 0, output: 0, calls: 0
    })
    const add = (acc: ReturnType<typeof blank>, r: (typeof rows)[number]): void => {
      acc.input += r.input; acc.cacheRead += r.cacheRead; acc.cacheCreation += r.cacheCreation
      acc.output += r.output; acc.calls += r.calls
    }
    const seal = (a: ReturnType<typeof blank>): UsageTokens => ({
      ...a, total: a.input + a.cacheRead + a.cacheCreation + a.output
    })

    const hourStartOfNow = Math.floor(now / 3_600_000) * 3_600_000
    const hour = blank(), day = blank(), week = blank()
    // Hari LOKAL: kunci = tanggal lokal (YYYY-MM-DD via offset), agar batas hari sesuai zona user.
    const localDayStart = (ts: number): number => {
      const d = new Date(ts)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    const byDay = new Map<number, ReturnType<typeof blank>>()
    const byAcct = new Map<string, ReturnType<typeof blank>>()

    for (const r of rows) {
      if (r.hourStart >= hourStartOfNow) add(hour, r)
      if (r.hourStart >= now - DAY) add(day, r)
      if (r.hourStart >= now - 7 * DAY) {
        add(week, r)
        const a = byAcct.get(r.accountId) ?? blank()
        add(a, r); byAcct.set(r.accountId, a)
      }
      const dk = localDayStart(r.hourStart)
      const dd = byDay.get(dk) ?? blank()
      add(dd, r); byDay.set(dk, dd)
    }

    const fmtDay = (ts: number): string => {
      const d = new Date(ts)
      const days = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']
      return `${days[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`
    }
    const daily: UsageDay[] = [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dayStart, t]) => ({ label: fmtDay(dayStart), dayStart, tokens: seal(t) }))

    const byAccount: UsageByAccount[] = [...byAcct.entries()]
      .map(([id, t]) => ({
        accountId: id,
        label: labels.get(id) ?? (id === '__none__' ? 'Tanpa akun' : 'Akun terhapus'),
        provider: (providers.get(id) ?? 'claude') as AccountProvider,
        week: seal(t)
      }))
      .sort((a, b) => b.week.total - a.week.total)

    // Boros/normal: total HARI INI (lokal) dibanding rata-rata harian 7 hari SEBELUM hari ini.
    const todayStart = localDayStart(now)
    const todayTotal = seal(byDay.get(todayStart) ?? blank()).total
    let priorSum = 0, priorDays = 0
    for (const [dk, t] of byDay) {
      if (dk < todayStart && dk >= todayStart - 7 * DAY) { priorSum += seal(t).total; priorDays++ }
    }
    const avg = priorDays ? priorSum / priorDays : 0
    const todayVsAvg = avg > 0 ? todayTotal / avg : null

    return {
      hour: seal(hour),
      day: seal(day),
      week: seal(week),
      allTime: seal({ ...this.db.getUsageAllTime() }),
      daily,
      byAccount,
      todayVsAvg
    }
  }

  /**
   * Akun yang dipakai sebuah sesi + tokennya — untuk fetch usage per-akun.
   * HANYA dipanggil di main-process; `token` TIDAK BOLEH ikut dikirim ke renderer.
   * Akun yang sudah dihapus dari DB → token null (bukan jatuh ke login utama), supaya
   * UI menampilkan "tidak diketahui", bukan angka akun lain.
   */
  getSessionAccountInfo(sessionId: string | null): { id: string | null; label: string; token: string | null } {
    // Akun EFEKTIF (bukan hanya yang tertulis di sesi) → header usage menampilkan akun yang BENAR-BENAR
    // dipakai, termasuk saat sesi menumpang akun sesi utama atau akun global.
    const accountId = sessionId ? this.resolveAccountId(sessionId) : null
    if (!accountId) return { id: null, label: 'Belum ada akun', token: null }
    const label = this.db.getAccounts().find((a) => a.id === accountId)?.label
    return { id: accountId, label: label ?? 'Akun terhapus', token: this.db.getAccountToken(accountId) }
  }

  /**
   * Catat pin (akun PILIHAN user) ke memori DAN DB sekaligus → tahan restart. Dipakai saat user
   * memilih akun dari UI, dan saat auto-switch pertama kali "mengabadikan" akun yang sedang dipakai
   * sebagai pilihan user (sesi lama / akun warisan parent yang belum punya pin).
   */
  private rememberPin(sessionId: string, accountId: string | null): void {
    this.pinnedAccount.set(sessionId, accountId)
    this.db.setSessionPin(sessionId, accountId)
  }

  /**
   * Set akun sebuah session (null = login default); berlaku pada start/resume berikutnya.
   * `opts.auto` = perpindahan OTOMATIS (limit/kuota) → JANGAN menimpa pilihan user; pilihan user
   * (opts.auto tak diisi = dari UI) dicatat sebagai pin supaya bisa dikembalikan nanti.
   */
  setSessionAccount(sessionId: string, accountId: string | null, opts?: { auto?: boolean }): void {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`Session ${sessionId} tidak ditemukan`)
    if (!opts?.auto) this.rememberPin(sessionId, accountId ?? null) // pilihan eksplisit user → persist
    // Sama seperti setDefaultAccount: mengubah akun sesi UTAMA ikut mengubah akun efektif seluruh
    // sub-sesi yang menumpang padanya, jadi mereka pun harus di-restart-kan — tapi HANYA yang
    // benar-benar berubah.
    const before = new Map([...this.sessions.keys()].map((id) => [id, this.resolveAccountId(id)]))
    s.meta.accountId = accountId ?? undefined
    s.meta.updatedAt = Date.now()
    this.db.upsertSession(s.meta)
    this.emit({ channel: 'session:update', payload: { id: sessionId, accountId: s.meta.accountId } })
    for (const [id, prev] of before) {
      if (this.resolveAccountId(id) !== prev) this.sessions.get(id)?.restartQuery()
    }
  }

  /**
   * GroveHost.onLimitHit — dipanggil saat sebuah sesi kena limit pemakaian.
   * Bila auto-switch aktif & ada ≥2 akun: pindah ke akun berikutnya lalu LANJUTKAN otomatis
   * (resume konteks + inject "lanjutkan"). Guard anti-loop: bila sudah keliling semua akun
   * tanpa turn sukses, berhenti. Bila tak bisa switch, beri pesan jelas ke user.
   */
  /** Tandai sebuah akun (atau login default) sedang kena limit — dipakai bersama semua sesi. */
  markAccountLimited(accountKey: string): void {
    this.limitedAt.set(accountKey, Date.now())
  }

  /** Akun dianggap tak tersedia selama cooldown setelah terbukti kena limit. */
  isAccountLimited(accountKey: string): boolean {
    const t = this.limitedAt.get(accountKey)
    return t != null && Date.now() - t < LIMIT_COOLDOWN_MS
  }

  /**
   * Akun yang BELUM diketahui kena limit (bukan akun yang sedang dipakai). Di antara kandidat,
   * pilih yang paketnya TERBESAR = paling mungkin masih punya kuota — bukan sekadar yang paling
   * lama dibuat (urutan pembuatan gampang jatuh ke akun login utama).
   */
  pickAvailableAccount(currentKey: string): Account | undefined {
    return this.db
      .getAccounts()
      .filter((a) => a.id !== currentKey && !this.isAccountLimited(a.id))
      .sort((x, y) => (y.plan ?? 1) - (x.plan ?? 1))[0]
  }

  /**
   * Cadangan saat SEMUA akun sudah menembus ambang: pilih yang paketnya TERBESAR (mis. Max 20x
   * sebelum Max 5x) supaya kerja tetap jalan, bukan terkunci menunggu semua turun di bawah ambang.
   * Akun tanpa info paket dianggap 1.
   */
  pickLargestPlanAccount(currentKey: string): Account | undefined {
    return this.db
      .getAccounts()
      .filter((a) => a.id !== currentKey)
      .sort((x, y) => (y.plan ?? 1) - (x.plan ?? 1))[0]
  }

  /** Akun tujuan pindah: yang belum limit; kalau semua limit → yang paketnya terbesar. */
  private pickSwitchTarget(currentKey: string): { acct: Account; fallback: boolean } | undefined {
    const free = this.pickAvailableAccount(currentKey)
    if (free) return { acct: free, fallback: false }
    const big = this.pickLargestPlanAccount(currentKey)
    return big ? { acct: big, fallback: true } : undefined
  }

  /**
   * Kuota sebuah akun menembus ambang (mis. 90%) → PINDAHKAN sesi-sesinya SEBELUM kena limit,
   * bukan menunggu error. Sesi yang sedang jalan langsung didorong melanjutkan di akun baru.
   * Berlaku untuk SEMUA akun yang usage-nya terbaca — termasuk akun `setup-token`, yang kuotanya
   * dibaca lewat header rate-limit Messages API saat endpoint /oauth/usage menolak (lihat usage.ts).
   * Mengembalikan jumlah sesi yang dipindah.
   */
  onUsageHigh(accountId: string | null, pct: number): number {
    if (!this.autoSwitch) return 0
    // Ambang ditegakkan DI SINI (bukan hanya di pemanggil) supaya satu-satunya sumber kebenaran
    // soal "berapa persen dianggap tinggi" adalah setelan akun — pemanggil boleh saja memanggil
    // dengan persentase apa pun tanpa risiko memindah sesi sebelum waktunya.
    const threshold = this.switchPctFor(accountId)
    if (pct < threshold) return 0
    const key = accountId ?? DEFAULT_ACCT_KEY
    if (this.isAccountLimited(key)) return 0 // sudah ditandai → jangan pindah berulang
    const target = this.pickSwitchTarget(key)
    if (!target) return 0
    const next = target.acct
    // Bandingkan akun EFEKTIF: sub-sesi yang menumpang akun sesi utama / akun global juga ikut
    // dipindah. Sebelumnya perbandingan memakai meta.accountId mentah, jadi sub-sesi yang tak
    // menyimpan accountId sendiri LUPUT dari pemindahan dan tetap membakar akun yang hampir habis.
    const targets = [...this.sessions.values()].filter((s) => this.resolveAccountId(s.meta.id) === accountId)
    if (!targets.length) return 0
    this.markAccountLimited(key) // anggap tak tersedia selama cooldown
    for (const s of targets) {
      const wasRunning = s.meta.status === 'running'
      // Catat akun SAAT INI sebagai pilihan user bila belum tercatat (sesi lama / akun warisan parent)
      // → perpindahan ini SEMENTARA dan bisa dikembalikan oleh restorePinnedAccounts().
      if (!this.pinnedAccount.has(s.meta.id)) this.rememberPin(s.meta.id, s.meta.accountId ?? null)
      this.setSessionAccount(s.meta.id, next.id, { auto: true }) // auto → JANGAN timpa pin user
      s.systemNote(
        target.fallback
          ? `🔀 Semua akun sudah menembus ambangnya → SEMENTARA pindah ke paket TERBESAR "${next.label}"${next.plan ? ` (Max ${next.plan}x)` : ''} agar kerja tetap jalan (billing turn berikutnya ke akun ini).`
          : `🔀 Kuota akun ${Math.round(pct)}% (ambang ${threshold}%) → SEMENTARA pindah ke "${next.label}" (billing turn berikutnya ke akun ini).`
      )
      if (wasRunning) {
        s.injectAutoTask(
          `[GROVE] Akun dipindah ke "${next.label}" karena kuota hampir habis. Lanjutkan pekerjaan sebelumnya dari titik terakhir, jangan mengulang dari awal.`
        )
      }
    }
    return targets.length
  }

  onLimitHit(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return

    // Sesi ber-akun OPENROUTER / CUSTOM (proxy): "limit" yang terdeteksi hampir selalu upstream
    // provider penuh / rate-limit ("ResourceExhausted", Gemini 429 RESOURCE_EXHAUSTED) — TRANSIENT &
    // tak ada hubungannya dgn kuota akun Claude. JANGAN rotasi ke akun Claude (billing nyasar + tak
    // menolong). Beri pesan jujur: tunggu/coba lagi.
    const prov = this.effectiveAccount(sessionId)?.provider
    if (prov === 'openrouter' || prov === 'custom') {
      s.systemNote(
        prov === 'custom'
          ? '⚠️ Endpoint proxy-mu membalas limit/penuh (mis. Gemini free-tier 429 RESOURCE_EXHAUSTED — batas per-menit/per-hari). Ini rate-limit provider, BUKAN kuota Claude. Tunggu sebentar lalu kirim lagi; kalau sering, kurangi jumlah worker atau pakai model yang limitnya lebih longgar.'
          : '⚠️ Model OpenRouter gratis sedang penuh di sisi provider (mis. NVIDIA "ResourceExhausted") — ini sementara, BUKAN kuota akunmu. Kirim lagi untuk coba ulang, atau klik-kanan kartu sesi → pilih model OpenRouter lain (mis. Ultra vs Super).'
      )
      s.markLimited()
      return
    }

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

    // Akun yang barusan dipakai TERBUKTI kena limit → catat, supaya sesi ini (dan sesi lain)
    // tidak mencoba akun itu lagi selama cooldown. Lalu pilih akun yang BELUM kena limit —
    // langsung ke akun yang benar-benar bisa dipakai, bukan rotasi buta.
    const curKey = s.meta.accountId ?? DEFAULT_ACCT_KEY
    this.markAccountLimited(curKey)
    const next = this.pickSwitchTarget(curKey)?.acct
    if (!next) {
      s.systemNote(`🚫 Semua akun sedang kena limit. Coba lagi setelah limitnya reset.`)
      s.markLimited()
      return
    }
    // Catat akun SAAT INI sebagai pilihan user bila belum tercatat → perpindahan ini SEMENTARA.
    if (!this.pinnedAccount.has(sessionId)) this.rememberPin(sessionId, s.meta.accountId ?? null)
    const pinned = this.pinnedAccount.get(sessionId) ?? null
    const pinnedLabel = pinned ? (accts.find((a) => a.id === pinned)?.label ?? pinned) : 'Default'
    this.setSessionAccount(sessionId, next.id, { auto: true }) // auto → pin user TETAP tercatat
    s.systemNote(
      `🔀 Akun "${pinnedLabel}" kena limit → SEMENTARA pindah ke "${next.label}" (billing turn berikutnya ke akun ini). Akan dikembalikan ke "${pinnedLabel}" begitu limitnya reset.`
    )
    s.injectAutoTask(
      `[GROVE] Akun sebelumnya kena limit, sudah dipindah otomatis ke akun "${next.label}". Lanjutkan pekerjaan sebelumnya tepat dari titik terakhir tanpa mengulang dari awal.`
    )
  }

  /**
   * Kembalikan sesi ke akun PILIHAN user setelah sempat di-auto-switch karena limit/kuota, begitu
   * akun itu tak lagi ditandai limit. Tanpa ini sesi MENETAP di akun pengganti (sering = akun login
   * utama) → billing pindah diam-diam / "kebagi". Dipanggil berkala dari tick usage (5 menit).
   * Sesi yang sedang `running` dilewati agar turn berjalan tak terpotong — dicoba lagi tick berikutnya.
   * Mengembalikan jumlah sesi yang dipulihkan.
   */
  restorePinnedAccounts(): number {
    // Pin HANYA bermakna sebagai "target kembali setelah AUTO-SWITCH". Kalau auto-switch mati, tak
    // pernah ada perpindahan otomatis untuk dikembalikan — dan menjalankan restore di sini justru
    // MEMINDAHKAN sesi sendiri (ke pin lama yang tersimpan di DB) padahal user mematikan auto-switch.
    // Itu bug "auto-switch off tapi akun pindah sendiri". Jadi: off → jangan sentuh apa pun.
    if (!this.autoSwitch) return 0
    if (!this.pinnedAccount.size) return 0
    const accts = this.db.getAccounts()
    let restored = 0
    for (const [sessionId, pinned] of this.pinnedAccount) {
      const s = this.sessions.get(sessionId)
      if (!s) continue
      if ((s.meta.accountId ?? null) === pinned) continue // sudah di akun pilihan user
      if (s.meta.status === 'running') continue // jangan potong turn yang sedang jalan
      if (this.isAccountLimited(pinned ?? DEFAULT_ACCT_KEY)) continue // akun pilihan masih kena limit
      if (pinned && !accts.some((a) => a.id === pinned)) continue // akun pilihan sudah dihapus
      this.setSessionAccount(sessionId, pinned, { auto: true }) // auto → pin TIDAK berubah
      const label = pinned ? (accts.find((a) => a.id === pinned)?.label ?? pinned) : 'Default'
      s.systemNote(`↩️ Limit sudah reset — sesi dikembalikan ke akun pilihanmu "${label}".`)
      restored++
    }
    return restored
  }

  private newMeta(p: {
    id: string
    treeId: string
    parentId: string | null
    role: SessionMeta['role']
    title: string
    cwd: string
    model?: string
    lite?: boolean
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
      lite: p.lite || undefined,
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
    // Tugas baru ke root → (re)nyalakan thread auto-check "udah sampe mana?". Root LITE tak punya
    // worker (tool spawn tak dimuat) → loop mustahil berguna, jangan pasang timernya sama sekali.
    if (s.meta.role === 'root' && !s.meta.lite) this.enableLoop(id)
  }

  /** Ubah mode ringan (lite) sebuah root. Berlaku di giliran berikutnya: bila query sedang jalan,
   *  di-restart (resume) agar opsi baru (server/append) terpasang; bila dorman, start() berikutnya
   *  sudah membaca meta.lite yang baru. */
  setLite(id: string, lite: boolean): void {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`Session ${id} tidak ditemukan`)
    const next = lite || undefined
    if (s.meta.lite === next) return
    s.meta.lite = next
    s.meta.updatedAt = Date.now()
    this.db.upsertSession(s.meta)
    if (lite) this.stopLoop(id) // ke lite → matikan auto-check bila sempat menyala
    this.emit({ channel: 'session:update', payload: { id, lite: !!next } })
    s.restartQuery() // no-op bila dorman; kalau jalan → resume dgn opsi baru pada pesan berikutnya
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
    this.loopIdleStreak.delete(rootId) // tugas baru → rantai "tanpa perubahan" direset
    this.lastLoopSummary.delete(rootId)
    this.loopDonePinged.delete(rootId) // tugas baru → ping penutup boleh dikirim lagi nanti
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
   * Tiap interval: dorong root cek worker HANYA bila perlu. Biaya satu tick BUKAN teks ping (~200-450
   * token) melainkan GILIRAN root-nya (seluruh transkrip root dibaca ulang: ~7rb token @ctx35% window
   * 200k, ~35rb @1M) → yang harus ditekan adalah JUMLAH giliran, bukan ukuran teks.
   *
   * Tick DILEWATI (tanpa giliran) bila: root sedang running, belum ada worker, semua worker masih
   * running, ATAU sudah tak ada info baru (lihat aturan streak di bawah).
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
    // BEDAKAN dgn hati-hati: 'done' = benar-benar tuntas (markDone / report_to_parent 100%).
    // 'idle'/'error' = tak jalan TAPI belum tuntas = MANDEK — justru inilah yang auto-check ada untuk
    // mengejarnya, jadi TIDAK boleh disamakan dengan selesai. (Dulu `status !== 'running'` menyatukan
    // keduanya, sehingga tree yang seluruh workernya SUDAH SELESAI tetap dipingg berkali-kali.)
    const stalled = subs.filter((s) => s.meta.status !== 'running' && s.meta.status !== 'done')
    const allDone = subs.length > 0 && subs.every((s) => s.meta.status === 'done')
    if (!allDone) this.loopDonePinged.delete(rootId) // keadaan berubah → ping penutup boleh lagi nanti
    // Layak ditanya kalau ada worker MANDEK, atau tree baru saja tuntas (butuh 1 ping penutup).
    const worthAsking = subs.length > 0 && (stalled.length > 0 || allDone)
    if (root.meta.status !== 'running' && worthAsking) {
      // Signature dari baris SUB saja (status+percent+progress) — stabil terhadap aksi root sendiri,
      // sehingga hitungan 3-strike deterministik dan loop PASTI berhenti.
      const sig = this.subBoardSignature(rootId)
      const unchanged = this.lastLoopSummary.get(rootId) === sig
      const streak = unchanged ? (this.loopIdleStreak.get(rootId) ?? 0) + 1 : 0
      this.loopIdleStreak.set(rootId, streak)
      this.lastLoopSummary.set(rootId, sig)
      if (streak >= IDLE_CHECK_LIMIT) {
        root.systemNote(
          `⏹ Auto-check dihentikan: ${IDLE_CHECK_LIMIT}× berturut tak ada perubahan (kemungkinan sudah selesai). Nyala lagi otomatis saat kamu kirim tugas baru.`
        )
        this.stopLoop(rootId)
        return
      }
      if (allDone) {
        // Tree TUNTAS → cukup SATU ping penutup (ajak sintesis akhir + task_done). Tick berikutnya
        // diam; streak tetap naik sehingga loop berhenti sendiri lewat cabang IDLE_CHECK_LIMIT.
        if (!this.loopDonePinged.has(rootId)) {
          this.loopDonePinged.add(rootId)
          root.autoCheck(this.loopCheckPrompt(rootId))
        }
      } else if (streak <= 1) {
        // Ping PERTAMA (streak 0) + SATU pengulangan (streak 1). Pengulangan itu WAJIB: worker yang
        // MANDEK justru TIDAK mengubah board, jadi kalau semua tick unchanged di-skip, kasus mandek
        // tak akan pernah terkejar. Mulai streak ≥2 board tetap sama & root sudah 2× diberi tahu →
        // giliran tambahan murni redundan (payload byte-identik) → dilewati.
        root.autoCheck(this.loopCheckPrompt(rootId))
      }
    }
    this.scheduleLoop(rootId) // ulangi sampai task_done / dimatikan manual
  }

  /**
   * Signature perubahan board untuk deteksi "tak ada info baru". SENGAJA hanya baris SUB dan hanya
   * field stabil (status + percent + progress), diurutkan deterministik (metaSnapshot() = urut
   * createdAt) dan dikunci per id. Baris ROOT & `title` DIKECUALIKAN: kalau ikut, balasan root atas
   * ping (update_summary / set_title / assign_worker) mengubah signature → streak reset → auto-stop
   * 3-strike tak pernah tercapai → loop berjalan tanpa batas (biaya tak terbatas).
   */
  private subBoardSignature(rootId: string): string {
    const boardMap = new Map(this.db.getAllBoard().map((b) => [b.sessionId, b]))
    return this.metaSnapshot()
      .filter((m) => m.treeId === rootId && m.role === 'sub')
      .map((m) => {
        const b = boardMap.get(m.id)
        return `${m.id}|${m.status}|${b?.percent ?? ''}|${b?.progress ?? ''}`
      })
      .join('\n')
  }

  /** Toggle dari UI. */
  setLoop(rootId: string, enabled: boolean): void {
    if (enabled) this.enableLoop(rootId)
    else this.stopLoop(rootId)
  }

  /** GroveHost.taskDone — root menandai seluruh tugas selesai → hentikan loop + status 'done'. */
  taskDone(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.meta.role !== 'root') return
    this.stopLoop(sessionId)
    s.markDone() // tuntas → dot hijau (sesi TIDAK ditutup; tugas baru mengembalikannya ke running)
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
      this.loopIdleStreak.delete(sid) // state auto-check milik sesi ini → jangan tinggalkan sisa
      this.lastLoopSummary.delete(sid)
      this.loopDonePinged.delete(sid)
      this.pinnedAccount.delete(sid) // baris DB-nya dibersihkan db.deleteSession (session_pins)
      const rt = this.reportTimers.get(sid) // buffer coalesce milik sesi ini (sbg parent) → bersihkan
      if (rt) clearTimeout(rt)
      this.reportTimers.delete(sid)
      this.pendingReports.delete(sid)
      this.lastReportSig.delete(sid)
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
    // Worker sudah melapor TUNTAS sendiri → tandai, agar auto-report di akhir turn tidak dobel.
    if (opts.percent != null && opts.percent >= 100) {
      from.markFinalReported()
      from.markDone() // sub 100% → status 'done' (diterapkan saat turn-nya berakhir)
      // INVARIAN: laporan "worker SELESAI" tak boleh tertahan sampai akhir jendela coalesce —
      // alur "semua worker selesai → root menyintesis" harus tetap jalan tepat waktu.
      this.flushParentReportsSoon(parentId)
    }
    this.scheduleRootStatus(from.meta.treeId) // treeId = id root pohon INI → hanya membangunkan root sendiri
  }

  /**
   * Safety-net: begitu satu turn worker selesai, bangunkan root untuk merangkum ke user.
   * `outcome` hanya diisi Session bila turn berakhir WAJAR dan worker belum melapor final →
   * runtime yang melapor, jadi hasil kerja tak pernah lagi nyangkut di transcript worker.
   */
  notifyTurnEnd(sessionId: string, outcome?: { finalText: string }): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.meta.role !== 'sub') return // hanya sub-worker; root menyelesaikan turn ≠ pemicu
    if (outcome) {
      this.autoReportFinal(s, outcome.finalText)
      // ANTI DOBEL-GILIRAN ROOT: autoReportFinal→queueParentReport SUDAH membangunkan parent. Kalau
      // parent = root (worker anak-LANGSUNG), scheduleRootStatus di bawah jadi giliran root KEDUA yang
      // isinya tumpang-tindih dgn laporan gabungan → dua giliran ~74K utk SATU penutupan worker (biang
      // "banyak langkah kerja"). Lewati utk anak-langsung root; worker lebih dalam tetap pakai ping
      // board supaya root dapat ringkasan cepat tanpa menunggu kaskade laporan naik level-per-level.
      if (s.meta.parentId === s.meta.treeId) return
    }
    this.scheduleRootStatus(s.meta.treeId)
  }

  /**
   * HANDOFF otomatis "worker menutup turn" → hasilnya AUTO-ATTACH ke sesi parent.
   * Dulu hanya menulis ke tabel messages (jarang dibaca model). Sekarang, tiap turn worker
   * berakhir wajar: (a) SIMPAN hasil LENGKAP ke file di userData/results, dan (b) INJECT ringkasan
   * ringkas + path file itu ke KONTEKS parent (injectAutoTask) supaya model parent benar-benar
   * melihatnya — bukan sekadar nyangkut di board/messages. Board tetap pakai percent lama (kita
   * hanya tahu turn-nya berakhir, bukan tugas tuntas). Kaskade aman: notifyTurnEnd early-return
   * untuk role !== 'sub', jadi rantai berhenti di root (root tak pernah men-trigger autoReportFinal).
   */
  private autoReportFinal(from: Session, finalText: string): void {
    const parentId = from.meta.parentId
    if (!parentId) return // tanpa parent (root) → no-op, cegah wake diri sendiri
    // ISOLASI: sama seperti reportToParent — laporan tak boleh nyasar ke pohon lain.
    const parent = this.sessions.get(parentId)
    if (!parent || parent.meta.treeId !== from.meta.treeId) return
    const full = (finalText ?? '').trim()
    const oneLine = full.replace(/\s+/g, ' ').trim()
    // HORMATI CAP: board pakai batas progress (200) — sama dgn yg ditegakkan mcpTools.
    this.db.setProgress(
      from.meta.id,
      cap(oneLine || '(menutup turn tanpa teks jawaban)', CAP_PROGRESS),
      Date.now()
    ) // percent sengaja dibiarkan apa adanya (undefined = kolom percent tak diubah)
    this.emitBoard(from.meta.id)

    // Simpan hasil LENGKAP worker ke file → parent bisa membaca detail penuh via Read.
    let filePath = ''
    try {
      const dir = join(app.getPath('userData'), 'results')
      mkdirSync(dir, { recursive: true })
      filePath = join(dir, `${sanitizeFileName(from.meta.title)}-${from.meta.id}.md`)
      const header = `# ${from.meta.title}\n\n- worker id: ${from.meta.id}\n- selesai: ${new Date().toISOString()}\n`
      writeFileSync(filePath, `${header}\n${full || '(tidak ada teks jawaban)'}\n`, 'utf8')
    } catch (e) {
      console.error(`[autoReportFinal] gagal menulis hasil worker ${from.meta.id}:`, e)
      filePath = ''
    }

    // Jejak UI: tetap tulis ke tabel messages (panel pesan) — sama seperti sebelumnya.
    this.sendMessage(
      from.meta.id,
      parentId,
      cap(
        `[auto] Worker "${from.meta.title}" menutup turn-nya. Jawaban terakhirnya:\n${oneLine || '(tidak ada teks jawaban)'}`,
        CAP_MESSAGE
      )
    )

    // Hasil tetap di-attach ke KONTEKS parent, TAPI lewat buffer coalesce — JANGAN injectAutoTask
    // langsung. injectAutoTask = SATU giliran parent per worker, dan tiap giliran menagih ULANG
    // seluruh konteks parent yang menumpuk → itulah pengali biaya terbesar. Di-flush jadi satu
    // giliran gabungan (lihat queueParentReport/flushParentReports).
    const snippet = full.length > 700 ? full.slice(0, 700) + '…' : full
    this.queueParentReport(parentId, {
      workerId: from.meta.id,
      title: from.meta.title,
      line: snippet || '(tidak ada teks jawaban)',
      filePath,
      percent: this.db.getBoardEntry(from.meta.id)?.percent,
      done: from.meta.status === 'done',
      ts: Date.now()
    })
  }

  /**
   * Masukkan laporan worker ke buffer parent-nya. Penjadwalan bersifat BATCHING (jendela tetap):
   * timer TIDAK digeser tiap laporan baru — kalau digeser, aliran laporan terus-menerus bisa menunda
   * flush selamanya (starvation). Laporan berikutnya cukup menumpuk di buffer; hanya laporan
   * PRIORITAS (worker tuntas) yang boleh MEMPERCEPAT timer. Jadi buffer SELALU ter-flush ≤ 1 jendela.
   */
  private queueParentReport(parentId: string, entry: PendingWorkerReport): void {
    let buf = this.pendingReports.get(parentId)
    if (!buf) {
      buf = new Map()
      this.pendingReports.set(parentId, buf)
    }
    buf.set(entry.workerId, entry) // DEDUPE: simpan hanya laporan TERBARU per worker
    if (entry.done) {
      this.flushParentReportsSoon(parentId) // worker tuntas → jangan ditahan sampai akhir jendela
      return
    }
    if (this.reportTimers.has(parentId)) return // jendela sudah berjalan → cukup menumpuk
    this.reportTimers.set(
      parentId,
      setTimeout(() => this.flushParentReports(parentId), WORKER_REPORT_COALESCE_MS)
    )
  }

  /** Percepat flush buffer parent — dipakai saat worker melapor 100%/tuntas (jangan tertahan). */
  private flushParentReportsSoon(parentId: string): void {
    const buf = this.pendingReports.get(parentId)
    if (!buf || !buf.size) return
    const prev = this.reportTimers.get(parentId)
    if (prev) clearTimeout(prev)
    this.reportTimers.set(parentId, setTimeout(() => this.flushParentReports(parentId), REPORT_PRIORITY_MS))
  }

  /**
   * Kirim SATU auto-task gabungan berisi laporan semua worker yang menumpuk pada jendela ini.
   * - Parent sedang `running` → JANGAN suntik di tengah giliran; jadwalkan ulang (laporan TIDAK dibuang).
   * - Tak ada perubahan materiil sejak flush terakhir → lewati agar tak membuat giliran kosong,
   *   KECUALI ada worker yang TUNTAS (laporan "selesai" tak boleh hilang/ditunda selamanya).
   */
  private flushParentReports(parentId: string): void {
    this.reportTimers.delete(parentId)
    const buf = this.pendingReports.get(parentId)
    if (!buf || !buf.size) return
    const parent = this.sessions.get(parentId)
    if (!parent) {
      this.pendingReports.delete(parentId) // parent sudah tak ada → buang buffer
      return
    }
    if (parent.meta.status === 'running') {
      // Tunggu giliran parent selesai; coba lagi nanti (pola sama dgn scheduleRootStatus).
      this.reportTimers.set(
        parentId,
        setTimeout(() => this.flushParentReports(parentId), WORKER_REPORT_COALESCE_MS)
      )
      return
    }
    const items = [...buf.values()].sort((a, b) => a.ts - b.ts)
    const anyDone = items.some((i) => i.done)
    const sig = items.map((i) => `${i.workerId}|${i.percent ?? ''}|${i.line}`).join('\n')
    buf.clear()
    if (!anyDone && this.lastReportSig.get(parentId) === sig) return // tak ada info baru → hemat 1 giliran
    this.lastReportSig.set(parentId, sig)
    parent.injectAutoTask(this.buildCombinedReport(items))
  }

  /** Susun satu auto-task gabungan dari beberapa laporan worker. */
  private buildCombinedReport(items: PendingWorkerReport[]): string {
    const head =
      items.length === 1
        ? '[GROVE] Worker melapor.'
        : `[GROVE] ${items.length} worker melapor (digabung jadi SATU giliran agar hemat konteks).`
    const body = items
      .map((i) => {
        const pct = i.percent != null ? ` (${i.percent}%)` : ''
        const file = i.filePath ? `\n  Hasil lengkap: ${i.filePath}` : ''
        return `• "${i.title}"${pct}${i.done ? ' — SELESAI' : ''}: ${i.line}${file}`
      })
      .join('\n')
    return `${head}\n${body}\n\nBeri user SATU baris update singkat. Kalau SEMUA worker sudah selesai, baca file hasil yang relevan (pakai Read) lalu beri sintesis akhir.`
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
      lines.push(`- [${m.role}] ${m.title} (${m.status}${pct})${prog}`.slice(0, 220)) // 1 baris/sesi
    }
    const out = lines.join('\n') || '(belum ada laporan)'
    // Batas total: ringkasan ini disuntik ke SETIAP ping → jangan biarkan tumbuh tak terbatas.
    return out.length > 2000 ? out.slice(0, 2000) + '\n… (dipotong)' : out
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
        if (!root || root.meta.role !== 'root') return
        // HEMAT USAGE tanpa MENGHILANGKAN laporan:
        // - root sedang jalan → JANGAN dibuang (dulu bug: laporan worker lenyap selamanya).
        //   Jadwalkan ulang saja; nanti saat root idle, ping-nya menyusul.
        // - board tak berubah sejak ping terakhir → memang tak ada info baru → lewati.
        if (root.meta.status === 'running') {
          this.scheduleRootStatus(treeId) // coba lagi nanti, jangan hilang
          return
        }
        const summary = this.treeBoardSummary(treeId)
        if (this.lastPingSummary.get(treeId) === summary) return
        this.lastPingSummary.set(treeId, summary)
        root.injectAutoTask(this.rootStatusPrompt(treeId))
      }, ROOT_STATUS_DEBOUNCE_MS)
    )
  }

  private emitBoard(sessionId: string): void {
    const entry = this.db.getBoardEntry(sessionId)
    if (entry) this.emit({ channel: 'board:update', payload: entry })
  }

  /**
   * Read-only board. GATE (hemat konteks + cegah bocor lintas-project):
   * - scope 'all' HANYA untuk pemanggil ROOT. Sub yang meminta 'all' DITURUNKAN ke 'tree'
   *   (turunkan cakupan diam-diam, bukan error keras) — sub tak perlu tahu isi project lain.
   * - Entri dari tree ASING selalu RINGKAS untuk SIAPA PUN (termasuk root): title/role/status/percent
   *   saja, TANPA summary/todo/progress. Dulu root menerima board PENUH semua tree (≈34 KB ≈ ~9.000
   *   token dalam satu panggilan) — itu membanjiri konteks sekaligus membocorkan detail project lain.
   * - Jumlah baris dibatasi MAX_BOARD_ROWS; tree SENDIRI diprioritaskan sebelum pemotongan.
   */
  readBoard(
    sessionId: string,
    scope: 'tree' | 'all'
  ): (BoardEntry & { title: string; treeId: string; role: string; status: string })[] {
    const caller = this.sessions.get(sessionId)
    const callerTree = caller?.meta.treeId
    const callerIsSub = caller?.meta.role === 'sub'
    const callerIsRoot = caller?.meta.role === 'root'
    const effScope: 'tree' | 'all' = scope === 'all' && callerIsRoot ? 'all' : 'tree'
    const metaById = new Map(this.metaSnapshot().map((m) => [m.id, m]))
    const rows = this.db
      .getAllBoard()
      .filter((b) => {
        const m = metaById.get(b.sessionId)
        if (!m) return false
        return effScope === 'all' ? true : m.treeId === callerTree
      })
      .map((b) => {
        const m = metaById.get(b.sessionId)!
        const base = { ...b, title: m.title, treeId: m.treeId, role: m.role, status: m.status }
        // Tree ASING → RINGKAS untuk semua pemanggil (root sekalipun). Detail project lain tak ikut.
        if (m.treeId !== callerTree) {
          return { ...base, summary: '(tree lain — ringkas: status saja)', todo: [], progress: '' }
        }
        // Caller = worker: sesi LAIN sepohon cuma untuk AWARENESS. Sembunyikan summary/todo/progress
        // verbatim milik sibling (framing tegas) supaya worker tak "mengadopsi" topik sesi lain
        // sebagai tugasnya. Entri worker SENDIRI tetap penuh; caller root tetap dapat board penuh.
        if (callerIsSub && b.sessionId !== sessionId) {
          return { ...base, summary: '(sesi lain — awareness saja, BUKAN tugasmu)', todo: [], progress: '' }
        }
        return base
      })
    // Tree SENDIRI didahulukan agar tak terpotong oleh cap (sort stabil → urutan dalam grup tetap).
    rows.sort((a, b) => Number(b.treeId === callerTree) - Number(a.treeId === callerTree))
    return rows.slice(0, MAX_BOARD_ROWS)
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
    // Tandai read PER-PENERIMA (sessionId) untuk SEMUA yg dikembalikan — jangan pakai flag global
    // m.read, agar broadcast yg sudah dibaca sibling lain tetap tercatat read utk sesi INI.
    this.db.markReadFor(sessionId, msgs.map((m) => m.id))
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

/** Judul worker → nama file aman lintas-OS: karakter non [A-Za-z0-9-_] jadi '-', dipangkas. */
function sanitizeFileName(title: string): string {
  const s = (title || 'worker').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80)
  return s.replace(/^-+|-+$/g, '') || 'worker'
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
