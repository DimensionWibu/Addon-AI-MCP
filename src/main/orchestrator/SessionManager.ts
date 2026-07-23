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
import {
  DEEPSEEK_MODEL_DEFAULT,
  DZAX_BASE_URL_DEFAULT,
  DZAX_MODEL_SUGGESTIONS,
  modelCandidates,
  deepseekCostUsd,
  isDeepSeekModel,
  providerSeesImages,
  isEffort,
  isSkinProvider,
  skinBaseUrl,
  usesOwnBaseUrl
} from '../../shared/types'
import type { EffortSetting } from '../../shared/types'
import { Board } from './db'
import { Session } from './Session'
import { handoverIsFresh, handoverPath, handoverRel, writeHandover } from './handover'
import { bridgeBaseUrl, setBridgeUsageSink } from '../openaiBridge'
import { cap, CAP_MESSAGE, CAP_PROGRESS, type GroveHost } from './mcpTools'
import { contextPercent, contextWindowFor } from './contextWindows'
import { WAKE, reportSignature, shouldSkipWake } from './wakePolicy'

const MAX_WORKERS_PER_TREE = 12
const DEFAULT_MODEL: string | undefined = undefined // undefined = ikut default Claude Code
// Semua angka tuning jalur-wake ada di ./wakePolicy (WAKE.*) — satu tempat, bisa diuji headless.
// Tiap wake = SATU giliran root penuh (konteks root dikirim ulang → biaya usage nyata).
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
/** Selama ini, akun yang gagal membaca gambar tak dicoba duluan lagi. */
const VISION_FAIL_COOLDOWN_MS = 10 * 60_000

const DEFAULT_ACCT_KEY = '__default__' // penanda sesi yang memakai login CLI (bukan akun tersimpan)
// COALESCE laporan worker → parent. Pemboros token DOMINAN bukan besar teksnya, melainkan JUMLAH
// GILIRAN: tiap injectAutoTask membuat giliran baru yang menagih ULANG seluruh konteks parent yang
// menumpuk. Dengan N worker, parent bisa dapat N giliran per ronde. Jendela ini (WAKE.coalesceMs)
// menggabungkannya jadi SATU giliran berisi ringkasan semua worker yang melapor di dalamnya.
const MAX_BOARD_ROWS = 40 // batas baris read_board agar tak membanjiri konteks pemanggil

/** Satu laporan worker yang menunggu digabung ke parent-nya (hanya yang TERBARU per worker). */
interface PendingWorkerReport {
  workerId: string
  title: string
  line: string // ringkasan 1-baris hasil worker
  filePath: string // file hasil lengkap (boleh kosong)
  percent?: number
  done: boolean // worker sudah tuntas → flush diprioritaskan
  /**
   * Laporan TUNTAS yang datang saat turn worker MASIH JALAN (report_to_parent 100% dipanggil di
   * tengah turn). Hasil PENUH-nya menyusul beberapa detik lagi lewat notifyTurnEnd → kalau di-flush
   * sekarang, root dibangunkan DUA kali untuk satu penutupan worker. Ditahan sampai turn-end
   * (tetap dijaga timer jendela normal, jadi tak mungkin nyangkut kalau turn berakhir tak wajar).
   */
  awaitTurnEnd: boolean
  ts: number
}

// Prompt auto-ping dibangun DINAMIS (lihat rootStatusPrompt/loopCheckPrompt) dengan ringkasan
// board disuntik langsung → root tak perlu memanggil read_board tiap ping (hemat konteks besar).

export class SessionManager implements GroveHost {
  private readonly sessions = new Map<string, Session>()
  private readonly rootStatusTimers = new Map<string, NodeJS.Timeout>() // treeId → debounce timer
  // treeId → SIGNATURE sub-board saat ping board terakhir (dedupe). SENGAJA subBoardSignature,
  // BUKAN treeBoardSummary: ringkasan itu memuat baris ROOT SENDIRI (+ title), jadi balasan root
  // atas ping sebelumnya sudah cukup membuat "board berubah" → dedupe tak pernah kena dan tiap
  // laporan worker berbuah satu giliran root. Lihat catatan sama di lastLoopSummary.
  private readonly lastPingSummary = new Map<string, string>()
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
  private readonly loopCacheWarmMode = new Set<string>() // rootId yang sudah beralih ke mode cache-warm (setelah idle-strike habis)
  // rootId → jumlah ping cache-warm BERUNTUN tanpa aktivitas nyata. Jatahnya pulih saat ada tugas
  // baru (enableLoop) — tanpa ini, sesi yang ditinggalkan menghangatkan konteksnya selamanya.
  private readonly cacheWarmPings = new Map<string, number>()
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
  private defaultEffort: EffortSetting | null = null // tingkat mikir GLOBAL (null = default model)
  // Akun yang usage-nya terbukti TAK bisa dibaca (403 scope). Dipakai UI untuk jujur bilang
  // "ambang non-aktif" alih-alih memberi kesan proteksi proaktif menyala padahal tidak.
  private readonly usageReadable = new Map<string, boolean>()
  // Akun API-key yang kreditnya sudah menembus ambang TAPI tak punya akun se-provider untuk
  // dipindahi → diperingatkan SEKALI (poll 5 menit; tanpa ini nota yang sama muncul terus).
  private readonly creditWarned = new Set<string>()
  /** Akun yang baru saja GAGAL jadi jembatan gambar → jangan dicoba duluan lagi untuk sementara. */
  private readonly visionFailedAt = new Map<string, number>()

  constructor(
    private readonly db: Board,
    private readonly emit: (ev: GroveEvent) => void
  ) {
    // Token NYATA akun gateway dilaporkan langsung oleh jembatan (lihat openaiBridge.setBridgeUsageSink):
    // di jalur itu, angka per-pesan yang sampai lewat CLI adalah campuran taksiran, jadi tak bisa dipakai.
    setBridgeUsageSink((sessionId, u) => {
      if (this.sessions.has(sessionId)) this.recordUsage(sessionId, u)
    })
  }

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
   * Worker baru yang dibuat USER dari GUI (klik 3× kartu sesi) — bukan oleh model.
   *
   * Bedanya dengan spawnWorker: TIDAK diberi tugas & TIDAK di-start, jadi tak ada giliran model
   * (nol token) sampai user benar-benar mengetik. Kartunya langsung muncul sebagai worker idle di
   * bawah kartu yang diklik, siap diisi tugas — persis alur "buka slot dulu, isi kemudian".
   *
   * `lite` diwarisi dari induk supaya satu pohon tetap satu mode: pohon Lite tak diam-diam
   * melahirkan worker berprotokol penuh (yang lebih mahal & tak ada yang mengoordinasi).
   */
  newWorker(parentId: string, title?: string): SessionMeta {
    const parent = this.sessions.get(parentId)
    if (!parent) throw new Error(`Session ${parentId} tidak ditemukan`)
    const treeId = parent.meta.treeId
    const inTree = [...this.sessions.values()].filter((s) => s.meta.treeId === treeId)
    if (inTree.length >= MAX_WORKERS_PER_TREE) {
      throw new Error(`Batas ${MAX_WORKERS_PER_TREE} sesi per pohon tercapai`)
    }
    const id = randomUUID()
    const meta = this.newMeta({
      id,
      treeId,
      parentId,
      role: 'sub',
      // Nomor urut dari jumlah SUB yang ada — cukup untuk membedakan; user bisa ganti judulnya
      // lewat sesi itu sendiri (model memanggil set_title) atau membiarkannya.
      title: title || `Worker ${inTree.filter((s) => s.meta.role === 'sub').length + 1}`,
      cwd: parent.meta.cwd, // worker kerja di folder yang sama dengan induknya
      lite: parent.meta.lite
    })
    // SENGAJA tanpa accountId/model: kosong = "ikut induk" (lihat catatan di spawnWorker).
    this.db.upsertSession(meta)
    this.registerSession(meta, { emit: true, start: false }) // dormant → 0 token sampai diberi tugas
    return meta
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
    const savedEffort = this.db.getSetting('defaultEffort')
    this.defaultEffort = isEffort(savedEffort) ? savedEffort : null
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
      defaultModel: this.defaultModel,
      defaultEffort: this.defaultEffort
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
    // DAFTAR PUTIH provider. WAJIB memuat setiap provider baru — kalau tidak, pilihan user diam-diam
    // jatuh ke 'claude'. Itu bukan teori: akun gateway yang ditambahkan lewat GUI sempat tersimpan
    // sebagai akun Claude (token gateway dikirim ke api.anthropic.com, usage mustahil terbaca) persis
    // karena 'dzax' belum ada di sini, padahal db.ts sudah bisa membacanya.
    const KNOWN: AccountProvider[] = ['openrouter', 'custom', 'cursor', 'deepseek', 'dzax']
    const prov: AccountProvider = provider && KNOWN.includes(provider) ? provider : 'claude'
    // openrouter/custom/cursor/deepseek sama-sama "Anthropic Skin" → semuanya memaksa model akun sendiri.
    // DeepSeek punya daftar model tertutup (pro/flash) → kosong berarti pakai default, bukan "tanpa model"
    // (tanpa model, SDK akan meminta alias claude yang tak dikenal DeepSeek → 400).
    const orModel = isSkinProvider(prov)
      ? model?.trim() || (prov === 'deepseek' ? DEEPSEEK_MODEL_DEFAULT : undefined)
      : undefined
    // base URL untuk provider proxy-sendiri ('custom'/'cursor'). openrouter pakai konstanta tetap.
    const url = usesOwnBaseUrl(prov) || prov === 'dzax' ? baseUrl?.trim() || undefined : undefined
    this.db.addAccount(id, clean, token.trim(), now, plan, pct, prov, orModel, url)
    this.emitAccounts()
    return { id, label: clean, plan, switchPct: pct, provider: prov, model: orModel, baseUrl: url, createdAt: now }
  }

  /**
   * Ubah akun tersimpan (label / token / model / base URL / paket). Field yang tak dikirim TIDAK
   * disentuh — khususnya TOKEN: renderer tak pernah memegangnya, jadi form edit mengirimnya kosong
   * kecuali user memang mengganti. Provider sengaja TIDAK bisa diubah di sini: mengganti jenis akun
   * berarti token, base URL, dan arti model ikut berubah — lebih jujur dibuat akun baru.
   */
  updateAccount(
    id: string,
    patch: { label?: string; token?: string; model?: string; baseUrl?: string; plan?: number | null }
  ): Account {
    const acc = this.db.getAccounts().find((a) => a.id === id)
    if (!acc) throw new Error('Akun tidak ditemukan')
    const label = patch.label?.trim()
    const token = patch.token?.trim()
    const model = patch.model?.trim()
    const baseUrl = patch.baseUrl?.trim()
    const skin = isSkinProvider(acc.provider)
    this.db.updateAccount(id, {
      label: label || undefined,
      token: token || undefined,
      // Model & base URL hanya berlaku untuk provider ber-endpoint sendiri; string kosong = kosongkan.
      model: skin && model !== undefined ? model : undefined,
      baseUrl: (usesOwnBaseUrl(acc.provider) || acc.provider === 'dzax') && baseUrl !== undefined ? baseUrl : undefined,
      plan: patch.plan === undefined ? undefined : patch.plan
    })
    this.emitAccounts()
    return this.db.getAccounts().find((a) => a.id === id)!
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
   * ENV + MODEL untuk sebuah AKUN — SATU tempat untuk semua jalur.
   *
   * Dulu perakitan env ditulis dua kali (jalur sesi & jalur jembatan gambar), dan yang kedua tak ikut
   * diperbarui saat provider gateway ditambahkan: akun gateway diarahkan ke base URL OpenRouter
   * dengan token gateway → "401 Missing Authentication header", lalu Grove mencoba akun berikutnya
   * satu per satu sampai bermenit-menit. Sekarang keduanya memanggil fungsi ini.
   *
   * `preferModel` dipakai jalur sesi (override model per-sesi); tanpa itu dipakai kandidat pertama.
   */
  private accountEnv(
    acc: Account,
    preferModel?: string
  ): { env: Record<string, string>; model?: string } | null {
    const token = this.db.getAccountToken(acc.id)
    if (!token) return null
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    if (acc.provider === 'dzax') {
      const cands = modelCandidates(acc.model)
      const model = (preferModel && cands.includes(preferModel) ? preferModel : cands[0]) || DZAX_MODEL_SUGGESTIONS[0].id
      const bridge = bridgeBaseUrl(acc.baseUrl || DZAX_BASE_URL_DEFAULT, model)
      if (!bridge) return null // jembatan belum menyala → lebih baik gagal terang-terangan
      env.ANTHROPIC_BASE_URL = bridge
      env.ANTHROPIC_AUTH_TOKEN = token
      delete env.ANTHROPIC_API_KEY
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      env.ANTHROPIC_MODEL = model
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
      env.ANTHROPIC_SMALL_FAST_MODEL = model
      return { env, model }
    }
    if (isSkinProvider(acc.provider)) {
      env.ANTHROPIC_BASE_URL = skinBaseUrl(acc.provider, acc.baseUrl)
      env.ANTHROPIC_AUTH_TOKEN = token
      delete env.ANTHROPIC_API_KEY
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      if (acc.provider === 'deepseek') {
        const main = acc.model || DEEPSEEK_MODEL_DEFAULT
        const fast = main.replace(/-pro$/, '-flash')
        env.ANTHROPIC_MODEL = main
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = main
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = main
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = fast
        env.ANTHROPIC_SMALL_FAST_MODEL = fast
      }
      return { env, model: acc.model }
    }
    env.CLAUDE_CODE_OAUTH_TOKEN = token
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.ANTHROPIC_BASE_URL
    return { env }
  }

  /**
   * GroveHost.getSessionLaunch — semua yang dibutuhkan query untuk sesi ini: token + env provider
   * (Claude vs OpenRouter) + model efektif. null = tak ada akun → sesi tak boleh jalan.
   * Env provider dibangun DI SINI supaya Session tak perlu tahu detail tiap provider.
   */
  getSessionLaunch(
    sessionId: string
  ): { env: Record<string, string>; model?: string; effort?: EffortSetting } | null {
    const acc = this.effectiveAccount(sessionId)
    if (!acc) return null
    // Perakitan env ada di accountEnv() — dipakai bersama jalur jembatan gambar supaya keduanya tak
    // pernah lagi berbeda perlakuan untuk provider yang sama.
    const built = this.accountEnv(acc, this.resolveModel(sessionId))
    if (!built) return null
    return {
      env: built.env,
      // Akun gateway/skin memaksa model akun; akun Claude memakai rantai model sesi → utama → global.
      model: built.model ?? this.resolveModel(sessionId),
      effort: this.resolveEffort(sessionId)
    }
  }


  /**
   * GroveHost.nextModelCandidate — pindah ke model cadangan akun (daftar dipisah koma di field model).
   * Model yang barusan dipakai ditandai sebagai "sudah gagal" lewat pin per-sesi, jadi kandidat
   * berikutnya benar-benar berbeda dan tak berputar-putar di model yang sama.
   */
  nextModelCandidate(sessionId: string): string | null {
    const acc = this.effectiveAccount(sessionId)
    const list = modelCandidates(acc?.model)
    if (list.length < 2) return null
    // Model yang SEDANG dipakai: override sesi bila ada, kalau tidak kandidat pertama akun (itulah
    // yang dipakai getSessionLaunch). Tanpa fallback ini, penolakan pertama akan "pindah" ke model
    // yang sama dan berputar di situ.
    const current = this.resolveModel(sessionId) ?? list[0]
    const idx = list.indexOf(current)
    const next = list[idx + 1]
    if (!next) return null
    this.setSessionModel(sessionId, next) // berlaku di start berikutnya
    return next
  }

  /** GroveHost.providerCachesPrompt — gateway OpenAI-compatible tak melaporkan cache sama sekali. */
  providerCachesPrompt(sessionId: string): boolean {
    return this.effectiveAccount(sessionId)?.provider !== 'dzax'
  }

  /** GroveHost.perMessageUsageReliable — lihat kontraknya di mcpTools.ts. */
  perMessageUsageReliable(sessionId: string): boolean {
    return this.effectiveAccount(sessionId)?.provider !== 'dzax'
  }

  /** GroveHost — akun efektif sesi ini bisa melihat gambar? (DeepSeek: tidak, lihat providerSeesImages) */
  sessionSeesImages(sessionId: string): boolean {
    return providerSeesImages(this.effectiveAccount(sessionId)?.provider)
  }

  /**
   * GroveHost.getVisionLaunches — SEMUA akun yang bisa melihat gambar, TERURUT sebagai daftar
   * cadangan untuk jembatan gambar. Session mencobanya satu per satu: kalau yang pertama kena limit
   * atau gangguan koneksi, ia turun ke berikutnya (dulu langsung menyerah — satu akun limit =
   * gambar tak terbaca sama sekali).
   *
   * Urutan: akun GLOBAL dulu (yang biasa dipakai user) → akun dengan kuota TERBACA & masih di bawah
   * ambangnya → sisanya. Akun tanpa token dilewati.
   */
  getVisionLaunches(): Array<{ id: string; env: Record<string, string>; model?: string; label: string }> {
    const accts = this.db.getAccounts().filter((a) => providerSeesImages(a.provider))
    const score = (a: Account): number => {
      // Akun yang BARU SAJA gagal membaca gambar ditaruh paling belakang: mengulanginya lebih dulu
      // hanya membuat user menunggu lagi (tiap percobaan menghabiskan satu giliran + batas waktunya).
      const failedAt = this.visionFailedAt.get(a.id) ?? 0
      if (Date.now() - failedAt < VISION_FAIL_COOLDOWN_MS) return 3
      if (a.id === this.defaultAccountId) return 0
      return a.usageReadable === false ? 2 : 1 // kuota tak terbaca (token bermasalah) → belakang
    }
    return this.accountsWithStatus()
      .filter((a) => accts.some((x) => x.id === a.id))
      .sort((a, b) => score(a) - score(b))
      .map((acc): { id: string; env: Record<string, string>; model?: string; label: string } | null => {
        const built = this.accountEnv(acc)
        return built ? { id: acc.id, env: built.env, model: built.model, label: acc.label } : null
      })
      .filter((x): x is { id: string; env: Record<string, string>; model?: string; label: string } => x !== null)
  }

  /** GroveHost.noteVisionFailure — akun ini baru saja gagal membaca gambar → turunkan prioritasnya. */
  noteVisionFailure(accountId: string): void {
    this.visionFailedAt.set(accountId, Date.now())
  }

  /** Kandidat jembatan gambar TERBAIK (null = tak ada akun yang bisa melihat gambar). */
  getVisionLaunch(): { id: string; env: Record<string, string>; model?: string; label: string } | null {
    return this.getVisionLaunches()[0] ?? null
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
    // Akun 'custom'/'cursor' (proxy): nama model ditentukan proxy, tak ada daftar/alias di Grove → pakai
    // model akun apa adanya untuk seluruh pohon (buat varian model = buat akun lain ke proxy sama).
    if (usesOwnBaseUrl(acc?.provider)) return acc?.model || undefined
    // Akun DeepSeek: daftar modelnya tertutup (pro/flash) → sesi boleh memilih di antara keduanya,
    // tapi alias Claude (opus/sonnet/haiku) yang terwarisi dari global JANGAN dipakai — DeepSeek
    // menolaknya. Warisan non-DeepSeek → jatuh ke model akun.
    if (acc?.provider === 'deepseek') {
      const s = this.sessions.get(sessionId)
      if (isDeepSeekModel(s?.meta.model)) return s!.meta.model
      const root = s ? this.sessions.get(s.meta.treeId) : undefined
      if (root && root.meta.id !== s?.meta.id && isDeepSeekModel(root.meta.model)) return root.meta.model
      return acc.model || DEEPSEEK_MODEL_DEFAULT
    }
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

  /** Model EFEKTIF yang benar-benar dikirim untuk sesi ini (akun gateway: kandidat pertama bila
   *  sesi belum menentukan sendiri). Dipakai UI & jalur pindah-model. */
  effectiveModel(sessionId: string): string | undefined {
    const own = this.resolveModel(sessionId)
    if (own) return own
    const acc = this.effectiveAccount(sessionId)
    return acc?.provider === 'dzax' ? modelCandidates(acc.model)[0] : undefined
  }

  /** GroveHost.getSessionModel — model EFEKTIF sesi ini untuk di-inject ke query. */
  getSessionModel(sessionId: string): string | undefined {
    return this.effectiveModel(sessionId)
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

  /**
   * TINGKAT MIKIR EFEKTIF sebuah sesi — pola yang SAMA dengan resolveModel: sesi → sesi UTAMA →
   * global → undefined (pakai default model). Dihitung saat dipakai, jadi mengubahnya di sesi utama
   * langsung menular ke sub-sesi yang tak menentukan sendiri.
   */
  resolveEffort(sessionId: string): EffortSetting | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return this.defaultEffort ?? undefined
    if (s.meta.effort) return s.meta.effort
    const root = this.sessions.get(s.meta.treeId)
    if (root && root.meta.id !== s.meta.id && root.meta.effort) return root.meta.effort
    return this.defaultEffort ?? undefined
  }

  /** Tingkat mikir global: dipakai semua sesi yang tak menentukan sendiri. null = default model. */
  setDefaultEffort(effort: EffortSetting | null): void {
    const before = new Map([...this.sessions.keys()].map((id) => [id, this.resolveEffort(id)]))
    this.defaultEffort = effort
    this.db.setSetting('defaultEffort', effort ?? '')
    // Hanya restart sesi yang tingkat mikir EFEKTIF-nya benar-benar berubah (param ini dikirim saat
    // query dibuat, jadi perubahan baru berlaku setelah query di-restart).
    for (const [id, prev] of before) {
      const s = this.sessions.get(id)
      if (s && this.resolveEffort(id) !== prev) s.restartQuery()
    }
    this.emitAccounts()
  }

  /** Set tingkat mikir sebuah sesi (null = kembali mewarisi). Sub-sesi yang menumpang ikut berubah. */
  setSessionEffort(sessionId: string, effort: EffortSetting | null): void {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`Session ${sessionId} tidak ditemukan`)
    const before = new Map([...this.sessions.keys()].map((id) => [id, this.resolveEffort(id)]))
    s.meta.effort = effort ?? undefined
    s.meta.updatedAt = Date.now()
    this.db.upsertSession(s.meta)
    for (const [id, prev] of before) {
      const sess = this.sessions.get(id)
      if (sess && this.resolveEffort(id) !== prev) {
        this.emit({ channel: 'session:update', payload: { id, effort: sess.meta.effort } })
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
  getSessionAccountInfo(sessionId: string | null): {
    id: string | null
    label: string
    token: string | null
    provider?: AccountProvider
  } {
    // Akun EFEKTIF (bukan hanya yang tertulis di sesi) → header usage menampilkan akun yang BENAR-BENAR
    // dipakai, termasuk saat sesi menumpang akun sesi utama atau akun global.
    const accountId = sessionId ? this.resolveAccountId(sessionId) : null
    if (!accountId) return { id: null, label: 'Belum ada akun', token: null }
    // provider IKUT dibawa: penentu apakah kuota ditanyakan ke Anthropic (akun Claude) atau ke API
    // provider sendiri (OpenRouter/DeepSeek). Tanpa ini header selalu menembak Anthropic → 401 palsu.
    const acc = this.db.getAccounts().find((a) => a.id === accountId)
    return {
      id: accountId,
      label: acc?.label ?? 'Akun terhapus',
      token: this.db.getAccountToken(accountId),
      provider: acc?.provider
    }
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
  pickAvailableAccount(currentKey: string, sameProvider?: AccountProvider): Account | undefined {
    return this.db
      .getAccounts()
      .filter((a) => a.id !== currentKey && !this.isAccountLimited(a.id))
      .filter((a) => !sameProvider || (a.provider ?? 'claude') === sameProvider)
      .sort((x, y) => (y.plan ?? 1) - (x.plan ?? 1))[0]
  }

  /**
   * Cadangan saat SEMUA akun sudah menembus ambang: pilih yang paketnya TERBESAR (mis. Max 20x
   * sebelum Max 5x) supaya kerja tetap jalan, bukan terkunci menunggu semua turun di bawah ambang.
   * Akun tanpa info paket dianggap 1.
   */
  pickLargestPlanAccount(currentKey: string, sameProvider?: AccountProvider): Account | undefined {
    return this.db
      .getAccounts()
      .filter((a) => a.id !== currentKey)
      .filter((a) => !sameProvider || (a.provider ?? 'claude') === sameProvider)
      .sort((x, y) => (y.plan ?? 1) - (x.plan ?? 1))[0]
  }

  /**
   * Akun tujuan pindah: yang belum limit; kalau semua limit → yang paketnya terbesar.
   * `sameProvider` MENGUNCI tujuan ke provider yang sama — dipakai saat akun sumbernya ber-API-key:
   * memindahkan sesi OpenRouter/DeepSeek ke langganan Claude berarti billing nyasar ke akun yang
   * tak pernah user pilih untuk pekerjaan itu (prinsip yang sama sudah dipegang onLimitHit).
   */
  private pickSwitchTarget(
    currentKey: string,
    sameProvider?: AccountProvider
  ): { acct: Account; fallback: boolean } | undefined {
    const free = this.pickAvailableAccount(currentKey, sameProvider)
    if (free) return { acct: free, fallback: false }
    const big = this.pickLargestPlanAccount(currentKey, sameProvider)
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
    const key = accountId ?? DEFAULT_ACCT_KEY
    if (pct < threshold) {
      this.creditWarned.delete(key) // turun lagi (kredit diisi ulang) → boleh diperingatkan lagi nanti
      return 0
    }
    if (this.isAccountLimited(key)) return 0 // sudah ditandai → jangan pindah berulang
    // Akun API-key hanya boleh dipindahkan ke akun provider yang SAMA (lihat pickSwitchTarget).
    const provider = this.db.getAccounts().find((a) => a.id === accountId)?.provider
    const lockProvider = isSkinProvider(provider) ? provider : undefined
    const target = this.pickSwitchTarget(key, lockProvider)
    // Bandingkan akun EFEKTIF: sub-sesi yang menumpang akun sesi utama / akun global juga ikut
    // dipindah. Sebelumnya perbandingan memakai meta.accountId mentah, jadi sub-sesi yang tak
    // menyimpan accountId sendiri LUPUT dari pemindahan dan tetap membakar akun yang hampir habis.
    const targets = [...this.sessions.values()].filter((s) => this.resolveAccountId(s.meta.id) === accountId)
    if (!targets.length) return 0
    if (!target) {
      // Tak ada tujuan yang sah. Untuk akun API-key ini kejadian normal (cuma punya 1 akun provider
      // itu) → beri tahu SEKALI, jangan diam: user perlu tahu kreditnya mau habis.
      if (lockProvider && !this.creditWarned.has(key)) {
        this.creditWarned.add(key)
        const label = this.db.getAccounts().find((a) => a.id === accountId)?.label ?? 'akun ini'
        for (const s of targets) {
          s.systemNote(
            `⚠️ Kredit/saldo "${label}" sudah ${Math.round(pct)}% terpakai (ambang ${threshold}%) dan tak ada akun ${lockProvider} lain untuk dipindahi. Isi ulang kredit atau pindahkan sesi ini manual — Grove sengaja TIDAK memindahkanmu ke akun Claude agar billing tak nyasar.`
          )
        }
      }
      return 0
    }
    const next = target.acct
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
    if (isSkinProvider(prov)) {
      s.systemNote(
        prov === 'cursor'
          ? '⚠️ Endpoint Cursor-mu membalas limit/penuh (free-tier Cursor punya batas request harian). Ini rate-limit provider, BUKAN kuota Claude. Tunggu sebentar lalu kirim lagi; kalau sering, kurangi jumlah worker atau pakai model Cursor yang limitnya lebih longgar.'
          : prov === 'deepseek'
            ? '⚠️ DeepSeek membalas limit/penuh (rate-limit atau saldo API habis). Ini batas provider DeepSeek, BUKAN kuota Claude. Tunggu sebentar lalu kirim lagi; kalau menetap, cek saldo di platform.deepseek.com atau kurangi jumlah worker paralel.'
          : prov === 'custom'
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

  /**
   * PERKIRAAN BIAYA akun DeepSeek per jendela waktu, dari token yang TERCATAT DI PC INI × harga
   * publik model akun. Ini perkiraan: yang otoritatif tetap saldo di platform (lihat fetchDeepseekBalance),
   * karena promo/harga jam sibuk tak terlihat dari sisi kita.
   */
  deepseekCosts(): Array<{
    accountId: string
    label: string
    model: string
    cost: { hour: number; day: number; week: number; allTime: number }
  }> {
    const accounts = this.db.getAccounts().filter((a) => a.provider === 'deepseek')
    if (!accounts.length) return []
    const now = Date.now()
    const DAY = 86_400_000
    const hourStartOfNow = Math.floor(now / 3_600_000) * 3_600_000
    const rows = this.db.getUsageRows(now - 8 * DAY)
    const allTime = new Map(this.db.getUsageAllTimeByAccount().map((r) => [r.accountId, r]))
    const blank = (): { input: number; cacheRead: number; cacheCreation: number; output: number } => ({
      input: 0, cacheRead: 0, cacheCreation: 0, output: 0
    })
    return accounts.map((a) => {
      const w = { hour: blank(), day: blank(), week: blank() }
      for (const r of rows) {
        if (r.accountId !== a.id) continue
        for (const [key, from] of [
          ['hour', hourStartOfNow],
          ['day', now - DAY],
          ['week', now - 7 * DAY]
        ] as const) {
          if (r.hourStart < from) continue
          const t = w[key]
          t.input += r.input
          t.cacheRead += r.cacheRead
          t.cacheCreation += r.cacheCreation
          t.output += r.output
        }
      }
      const at = allTime.get(a.id) ?? blank()
      const usd = (t: { input: number; cacheRead: number; cacheCreation: number; output: number }): number =>
        deepseekCostUsd(t, a.model) ?? 0
      return {
        accountId: a.id,
        label: a.label,
        model: a.model ?? DEEPSEEK_MODEL_DEFAULT,
        cost: { hour: usd(w.hour), day: usd(w.day), week: usd(w.week), allTime: usd(at) }
      }
    })
  }

  // ---- antrian pesan user (ditahan selama turn berjalan; bisa diedit/dibatalkan) --------------

  listQueued(id: string): Array<{ qid: number; text: string }> {
    return this.sessions.get(id)?.listQueued() ?? []
  }
  editQueued(id: string, qid: number, text: string): boolean {
    const clean = text.trim()
    if (!clean) return false
    return this.sessions.get(id)?.editQueued(qid, clean) ?? false
  }
  cancelQueued(id: string, qid: number): boolean {
    return this.sessions.get(id)?.cancelQueued(qid) ?? false
  }

  // ---- REFERENSI ANTAR-SESI (satu arah: helper → target) ---------------------
  // Dipakai untuk "chat B membantu chat A tanpa sepengetahuan A". Yang DIBAGI hanya papan + ekor
  // chat target (ringkas) dan kanal kirim-pesan; KONTEKS SDK TIDAK PERNAH dibagi — tiap sesi punya
  // percakapan & cache prefix sendiri, termasuk dua sesi yang folder kerjanya sama.

  /** Tautkan: `helperId` boleh membantu `targetId`. Arah balik ditolak agar tak jadi pair-to-pair. */
  linkReference(helperId: string, targetId: string): void {
    if (helperId === targetId) throw new Error('Tidak bisa menautkan sesi ke dirinya sendiri')
    if (!this.sessions.has(helperId)) throw new Error(`Session ${helperId} tidak ditemukan`)
    if (!this.sessions.has(targetId)) throw new Error(`Sesi referensi ${targetId} tidak ditemukan`)
    const refs = this.db.getAllRefs()
    if (refs.some((r) => r.helperId === targetId && r.targetId === helperId)) {
      throw new Error('Ditolak: sesi itu sudah menjadikan sesi ini referensi. Tautan dikunci SATU ARAH.')
    }
    const had = this.db.getRefTargets(helperId).length > 0
    this.db.addRef(helperId, targetId, Date.now())
    const helper = this.sessions.get(helperId)!
    const target = this.sessions.get(targetId)!
    helper.systemNote(
      `🔗 Referensi ditambahkan: "${target.meta.title}" (${targetId.slice(0, 6)}). Kamu bisa membaca papan & ekor chat-nya, ` +
        'dan mengirim bantuan ke sana lewat tool ref_*. Sesi itu TIDAK tahu bantuan datang darimu, dan tak punya akses balik.'
    )
    // Tool ref_* hanya dipasang saat sesi PUNYA tautan → giliran berikutnya harus memakai server baru.
    if (!had) helper.restartQuery()
  }

  unlinkReference(helperId: string, targetId: string): void {
    this.db.removeRef(helperId, targetId)
    const helper = this.sessions.get(helperId)
    if (helper) {
      helper.systemNote(`🔗 Referensi dilepas: ${targetId.slice(0, 6)}`)
      if (!this.db.getRefTargets(helperId).length) helper.restartQuery() // tool ref_* dilepas lagi
    }
  }

  /** Sesi ini punya referensi? Menentukan apakah tool ref_* ikut dipasang (hemat skema token). */
  hasReferences(sessionId: string): boolean {
    return this.db.getRefTargets(sessionId).length > 0
  }

  /** Daftar referensi sebuah sesi (untuk UI & tool ref_list). */
  listReferences(helperId: string): Array<{ id: string; title: string; status: string; cwd: string }> {
    return this.db
      .getRefTargets(helperId)
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => !!s)
      .map((s) => ({ id: s.meta.id, title: s.meta.title, status: s.meta.status, cwd: s.meta.cwd }))
  }

  private assertLinked(helperId: string, targetId: string): Session {
    if (!this.db.getRefTargets(helperId).includes(targetId)) {
      throw new Error(`Sesi ${targetId} bukan referensimu (tautan satu arah belum dibuat)`)
    }
    const t = this.sessions.get(targetId)
    if (!t) throw new Error(`Sesi referensi ${targetId} sudah tidak ada`)
    return t
  }

  /**
   * Baca kondisi target: papan tulis + ekor chat (ringkas). SENGAJA cuma cuplikan — menyalin seluruh
   * percakapan target ke konteks helper akan mahal & menghapus keuntungan cache masing-masing sesi.
   */
  readReference(helperId: string, targetId: string, lines = 12): string {
    const t = this.assertLinked(helperId, targetId)
    const b = this.db.getBoardEntry(targetId)
    const tail = this.db
      .getChatMessages(targetId)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-Math.max(1, Math.min(40, lines)))
      .map((m) => `${m.role === 'user' ? 'USER' : 'ASISTEN'}: ${m.text.slice(0, 400)}`)
      .join('\n')
    return (
      `REFERENSI "${t.meta.title}" (${targetId.slice(0, 6)}) · status ${t.meta.status} · cwd ${t.meta.cwd}\n` +
      (b
        ? `RINGKASAN: ${b.summary || '(kosong)'}\nPROGRES: ${b.progress || '(kosong)'}${
            b.percent != null ? ` (${b.percent}%)` : ''
          }\nTODO:\n${b.todo.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n') || '(kosong)'}\n`
        : 'PAPAN: (kosong)\n') +
      `\nEKOR PERCAKAPAN:\n${tail || '(belum ada)'}`
    )
  }

  /**
   * Kirim bantuan ke target. Masuk sebagai PESAN USER biasa di sesi target — jadi target
   * mengerjakannya tanpa tahu asalnya dari sesi lain (persis yang diminta: satu arah, tak
   * pair-to-pair). Tercatat jelas di chat KEDUA sesi supaya manusianya tetap bisa mengaudit.
   */
  sendToReference(helperId: string, targetId: string, text: string): void {
    const t = this.assertLinked(helperId, targetId)
    const body = text.trim()
    if (!body) throw new Error('Pesan kosong')
    const helper = this.sessions.get(helperId)
    helper?.systemNote(`📤 Dikirim ke referensi "${t.meta.title}": ${body.slice(0, 160)}${body.length > 160 ? '…' : ''}`)
    this.sendChat(targetId, body)
  }

  /** /btw — pertanyaan sampingan untuk sesi ini (query terpisah; sesi utama tak tersentuh). */
  async askSide(id: string, question: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`Session ${id} tidak ditemukan`)
    await s.askSide(question)
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
    // Path file handover TIDAK ditulis di sini: Session.compactWith yang menempelkannya (ia tahu
    // file mana yang benar-benar jadi — punya model atau tulisan Grove). Dulu kalimat "baca
    // .grove/checkpoint.md" selalu ikut walau file itu tak pernah ada → model mengejar file hantu.
    const summary = `Ringkasan tugas pohon ini (dari laporan worker, hasil compact):\n${lines.join('\n') || '(belum ada laporan board)'}`
    const mem = this.db.addMemory(treeId, rootId, summary, Date.now())
    this.emit({ channel: 'memory:new', payload: mem })
    root.compactWith(summary)
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
    // (path handover ditempel Session.compactWith — lihat compactSession)
    const summary = `Ringkasan tugasmu (auto-compact karena konteks nyaris penuh):\n${parts.join('\n')}`
    const mem = this.db.addMemory(s.meta.treeId, sessionId, summary, Date.now())
    this.emit({ channel: 'memory:new', payload: mem })
    s.compactWith(summary)
  }

  /**
   * GroveHost.beforeCompact — JAMINAN "selalu ada file untuk melanjutkan" (lihat handover.ts).
   *
   * Lapis 1 (kaya): checkpoint yang DITULIS MODEL — dihormati apa adanya bila ia segar (ditulis
   * setelah compact terakhir & belum basi). Menimpanya dengan versi Grove justru membuang alasan &
   * keputusan yang cuma ada di kepala model.
   * Lapis 2 (jaring pengaman): Grove menulis sendiri dari papan tugas + jejak file + ekor percakapan.
   *
   * Balikan = path relatif untuk disebut di reseed; null = benar-benar tak ada file (gagal tulis) —
   * Session akan mengatakannya terus terang alih-alih menyuruh model membaca file hantu.
   */
  beforeCompact(sessionId: string, summary: string): string | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    const rel = handoverRel(sessionId)
    const abs = handoverPath(s.meta.cwd, sessionId)
    if (handoverIsFresh(abs, s.getLastCompactAt())) return rel // model sudah menulis → jangan disentuh
    const b = this.db.getBoardEntry(sessionId)
    const ok = writeHandover(abs, {
      sessionId,
      title: s.meta.title,
      role: s.meta.role,
      status: s.meta.status,
      cwd: s.meta.cwd,
      reason: 'compact',
      summary,
      progress: b?.progress,
      percent: b?.percent,
      todo: b?.todo,
      files: s.getFilesTouched(),
      filesRead: s.getFilesRead(),
      searches: s.getSearches(),
      // Hanya giliran percakapan yang berisi maksud/hasil; baris tool sudah terwakili "Files Changed".
      chatTail: s.getHistory().filter((m) => m.role === 'user' || m.role === 'assistant')
    })
    if (!ok) console.warn(`[handover] gagal menulis ${abs}`)
    return ok || existsSync(abs) ? rel : null
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
    this.loopCacheWarmMode.delete(rootId) // tugas baru → keluar mode cache-warm, kembali auto-check normal
    this.cacheWarmPings.delete(rootId) // tugas baru → jatah ping cache-warm pulih
    this.loopIdleStreak.delete(rootId) // tugas baru → rantai "tanpa perubahan" direset
    this.lastLoopSummary.delete(rootId)
    this.loopDonePinged.delete(rootId) // tugas baru → ping penutup boleh dikirim lagi nanti
    this.scheduleLoop(rootId)
    if (wasOff) this.emit({ channel: 'session:update', payload: { id: rootId, loopActive: true } })
  }

  private stopLoop(rootId: string): void {
    this.clearLoopTimer(rootId)
    this.loopCacheWarmMode.delete(rootId)
    if (this.loopEnabled.delete(rootId)) {
      this.emit({ channel: 'session:update', payload: { id: rootId, loopActive: false } })
    }
  }

  private clearLoopTimer(rootId: string): void {
    const t = this.loopTimers.get(rootId)
    if (t) clearTimeout(t)
    this.loopTimers.delete(rootId)
  }

  private scheduleLoop(rootId: string, intervalMs?: number): void {
    this.clearLoopTimer(rootId)
    this.loopTimers.set(rootId, setTimeout(() => this.runLoopCheck(rootId), intervalMs ?? WAKE.loopIntervalMs))
  }

  /**
   * Tiap interval: dorong root cek worker HANYA bila perlu. Biaya satu tick BUKAN teks ping (~200-450
   * token) melainkan GILIRAN root-nya (seluruh transkrip root dibaca ulang: ~7rb token @ctx35% window
   * 200k, ~35rb @1M) → yang harus ditekan adalah JUMLAH giliran, bukan ukuran teks.
   *
   * Tick DILEWATI (tanpa giliran) bila: root sedang running, belum ada worker, semua worker masih
   * running, ATAU sudah tak ada info baru (lihat aturan streak di bawah).
   *
   * Setelah WAKE.idleCheckLimit tercapai: TIDAK berhenti total — beralih ke MODE CACHE-WARM: ping
   * ringan (cacheWarm) dengan interval WAKE.cacheWarmIntervalMs agar prefix prompt tetap ter-cache
   * di API (Pro plan TTL 1 jam). Cache-warm dihentikan hanya oleh task_done atau tugas baru.
   */
  private runLoopCheck(rootId: string): void {
    this.loopTimers.delete(rootId)
    if (!this.loopEnabled.has(rootId)) return
    const root = this.sessions.get(rootId)
    if (!root || root.meta.role !== 'root') {
      this.stopLoop(rootId)
      return
    }

    // ---- MODE CACHE-WARM: ping ringan, tujuannya hanya menjaga prefix tetap ter-cache ----
    if (this.loopCacheWarmMode.has(rootId)) {
      if (root.meta.status !== 'running') this.maybeCacheWarm(root)
      this.scheduleLoop(rootId, WAKE.cacheWarmIntervalMs)
      return
    }

    // ---- MODE AUTO-CHECK NORMAL ----
    const subs = [...this.sessions.values()].filter((s) => s.meta.treeId === rootId && s.meta.role === 'sub')
    const stalled = subs.filter((s) => s.meta.status !== 'running' && s.meta.status !== 'done')
    const allDone = subs.length > 0 && subs.every((s) => s.meta.status === 'done')
    if (!allDone) this.loopDonePinged.delete(rootId)
    const worthAsking = subs.length > 0 && (stalled.length > 0 || allDone)
    if (root.meta.status !== 'running' && worthAsking) {
      const sig = this.subBoardSignature(rootId)
      const unchanged = this.lastLoopSummary.get(rootId) === sig
      const streak = unchanged ? (this.loopIdleStreak.get(rootId) ?? 0) + 1 : 0
      this.loopIdleStreak.set(rootId, streak)
      this.lastLoopSummary.set(rootId, sig)
      if (streak >= WAKE.idleCheckLimit) {
        root.systemNote(
          `⏹ Auto-check dihentikan: ${WAKE.idleCheckLimit}× berturut tak ada perubahan. Cache prefix tetap dijaga. Nyala lagi otomatis saat kamu kirim tugas baru.`
        )
        this.loopCacheWarmMode.add(rootId)
        this.scheduleLoop(rootId, WAKE.cacheWarmIntervalMs)
        return
      }
      if (allDone) {
        if (!this.loopDonePinged.has(rootId)) {
          this.loopDonePinged.add(rootId)
          root.autoCheck(this.loopCheckPrompt(rootId))
        }
      } else if (streak <= 1) {
        root.autoCheck(this.loopCheckPrompt(rootId))
      }
    } else if (root.meta.status !== 'running' && !worthAsking) {
      // Tak ada worker / semua worker baik-baik saja → tak perlu auto-check, tapi jaga cache.
      this.maybeCacheWarm(root)
    }
    this.scheduleLoop(rootId)
  }

  /**
   * Ping cache-warm — DENGAN REM. Yang dijaga di sini adalah biaya, bukan sekadar cache:
   *
   *  - Ping cache-warm memang balas satu kata (output ~nol), TAPI request-nya membawa SELURUH
   *    konteks. Pada sesi 120k token, satu ping = 120k token input. Itu bukan "gratis".
   *  - Karena itu ping hanya berguna bila jatuh SEBELUM TTL cache habis (dibayar sebagai cache-read
   *    0,1×). Kalau telat, yang dibayar cache-creation 1,25× — lebih mahal daripada tidak
   *    menghangatkan sama sekali. Angka jadwalnya sudah diperbaiki di wakePolicy.
   *  - Konteks kecil tak sepadan dihangatkan, dan sesi yang benar-benar ditinggalkan harus BERHENTI
   *    dihangatkan: 4 ping beruntun tanpa aktivitas nyata lalu stop, bukan selamanya.
   */
  private maybeCacheWarm(root: Session): void {
    const id = root.meta.id
    if (Date.now() - root.lastApiActivity <= WAKE.cacheWarmStaleMs) return // cache masih segar
    if (root.meta.ctxInput < WAKE.cacheWarmMinCtx) return // tak ada konteks berarti untuk dijaga
    const used = this.cacheWarmPings.get(id) ?? 0
    if (used >= WAKE.cacheWarmMaxPings) {
      if (used === WAKE.cacheWarmMaxPings) {
        this.cacheWarmPings.set(id, used + 1) // tandai "nota sudah dikirim" (anti-spam)
        root.systemNote(
          `⏹ Cache-warm dihentikan setelah ${WAKE.cacheWarmMaxPings} ping tanpa aktivitas nyata. Menghangatkan konteks sebesar ini terus-menerus lebih mahal daripada sekali membangun ulang cache saat kamu kembali. Kirim tugas baru → jatahnya pulih.`
        )
      }
      return
    }
    this.cacheWarmPings.set(id, used + 1)
    root.cacheWarm()
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
  /** Berapa sesi yang BENAR-BENAR sedang bekerja sekarang. Dipakai konfirmasi tutup jendela. */
  countRunning(): number {
    return [...this.sessions.values()].filter((s) => s.meta.status === 'running').length
  }

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
      this.loopCacheWarmMode.delete(sid)
      this.cacheWarmPings.delete(sid)
      this.loopIdleStreak.delete(sid) // state auto-check milik sesi ini → jangan tinggalkan sisa
      this.lastLoopSummary.delete(sid)
      this.lastPingSummary.delete(sid) // dedupe ping board (keyed treeId = id root) → ikut dibuang
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

  /**
   * Worker → parent: update board (+persen), nota ke panel pesan, lalu titipkan laporan ke BUFFER
   * COALESCE parent — SATU jalur wake saja.
   *
   * FIX 1 (dobel-wake). Dulu jalur ini memanggil `scheduleRootStatus` SENDIRI, terpisah dari buffer
   * laporan milik `autoReportFinal`. Akibatnya satu penutupan worker anak-langsung root memicu DUA
   * giliran root: (1) flush laporan gabungan, dan (2) ping board 60 detik kemudian yang isinya
   * tumpang-tindih. Sekarang laporan progres masuk buffer yang SAMA, jadi progres + hasil akhir
   * worker yang sama menyatu menjadi satu giliran. Ping board hanya dipakai untuk worker yang BUKAN
   * anak langsung root (kalau tidak, root baru tahu setelah laporan merambat level-per-level).
   */
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
    const pctNum = opts.percent == null ? undefined : Math.max(0, Math.min(100, Math.round(opts.percent)))
    const pct = pctNum == null ? '' : `${pctNum}% · `
    this.sendMessage(fromId, parentId, `[progress] ${pct}${opts.status}`)
    const done = pctNum != null && pctNum >= 100
    // Worker sudah melapor TUNTAS sendiri → tandai, agar auto-report di akhir turn tidak dobel.
    if (done) {
      from.markFinalReported()
      from.markDone() // sub 100% → status 'done' (diterapkan saat turn-nya berakhir)
    }
    this.queueParentReport(parentId, {
      workerId: fromId,
      title: from.meta.title,
      line: cap(opts.status.replace(/\s+/g, ' ').trim(), CAP_PROGRESS),
      filePath: '',
      percent: pctNum,
      done,
      // Lapor 100% DI TENGAH turn: hasil penuh menyusul lewat notifyTurnEnd beberapa detik lagi →
      // tahan dulu supaya keduanya menyatu jadi SATU giliran root (tetap dijaga timer jendela).
      awaitTurnEnd: done && from.meta.status === 'running',
      ts: Date.now()
    })
    // Cucu/cicit: parent-nya bukan root, jadi root tak ikut terbangun oleh flush di atas.
    if (from.meta.parentId !== from.meta.treeId) this.scheduleRootStatus(from.meta.treeId)
  }

  /**
   * Safety-net: begitu satu turn worker selesai, bangunkan root untuk merangkum ke user.
   * `outcome` hanya diisi Session bila turn berakhir WAJAR dan worker belum melapor final →
   * runtime yang melapor, jadi hasil kerja tak pernah lagi nyangkut di transcript worker.
   */
  notifyTurnEnd(sessionId: string, outcome?: { finalText: string }): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.meta.role !== 'sub') return // hanya sub-worker; root menyelesaikan turn ≠ pemicu
    const parentId = s.meta.parentId
    if (outcome) {
      this.autoReportFinal(s, outcome.finalText)
      // ANTI DOBEL-GILIRAN ROOT: autoReportFinal→queueParentReport SUDAH membangunkan parent. Kalau
      // parent = root (worker anak-LANGSUNG), scheduleRootStatus di bawah jadi giliran root KEDUA yang
      // isinya tumpang-tindih dgn laporan gabungan → dua giliran ~74K utk SATU penutupan worker (biang
      // "banyak langkah kerja"). Lewati utk anak-langsung root; worker lebih dalam tetap pakai ping
      // board supaya root dapat ringkasan cepat tanpa menunggu kaskade laporan naik level-per-level.
      if (parentId === s.meta.treeId) return
    } else if (parentId && this.pendingReports.get(parentId)?.size) {
      // Turn berakhir TIDAK wajar (interupsi/limit/error) padahal ada laporan TUNTAS yang sengaja
      // ditahan menunggu turn-end (awaitTurnEnd) → lepaskan sekarang, jangan biarkan nyangkut.
      this.flushParentReportsSoon(parentId)
      if (parentId === s.meta.treeId) return
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
      awaitTurnEnd: false, // ini SUDAH akhir turn — tak ada yang perlu ditunggu lagi
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
    if (entry.done && !entry.awaitTurnEnd) {
      this.flushParentReportsSoon(parentId) // worker tuntas → jangan ditahan sampai akhir jendela
      return
    }
    // FIX 3 — laporan NON-FINAL tidak pernah membangunkan parent sendirian: ia hanya memperbarui
    // board (sudah dilakukan pemanggil) lalu MENUMPANG wake berikutnya. Alasannya bukan sekadar
    // hemat, tapi REDUNDAN: setiap ping/auto-check ke root SUDAH memuat ringkasan board lengkap
    // berisi progres yang sama. Dulu tiap laporan 25%/50%/75% = satu giliran root penuh — persis
    // pengali biaya terbesar pada sesi multi-worker.
    if (!entry.done) return
    if (this.reportTimers.has(parentId)) return // jendela sudah berjalan → cukup menumpuk
    // JARING PENGAMAN untuk entry `awaitTurnEnd` (lapor 100% di tengah turn): kalau turn worker
    // ternyata tak pernah berakhir wajar, laporan TUNTAS tetap sampai ≤ 1 jendela.
    this.reportTimers.set(
      parentId,
      setTimeout(() => this.flushParentReports(parentId), WAKE.coalesceMs)
    )
  }

  /** Percepat flush buffer parent — dipakai saat worker melapor 100%/tuntas (jangan tertahan). */
  private flushParentReportsSoon(parentId: string): void {
    const buf = this.pendingReports.get(parentId)
    if (!buf || !buf.size) return
    const prev = this.reportTimers.get(parentId)
    if (prev) clearTimeout(prev)
    this.reportTimers.set(parentId, setTimeout(() => this.flushParentReports(parentId), WAKE.priorityMs))
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
        setTimeout(() => this.flushParentReports(parentId), WAKE.coalesceMs)
      )
      return
    }
    const items = [...buf.values()].sort((a, b) => a.ts - b.ts)
    const sig = reportSignature(items)
    buf.clear()
    // FIX 6 — isi flush ini SAMA PERSIS dengan yang sudah dikirim → parent tak dapat info baru,
    // jadi giliran ini murni pemborosan. Dulu `anyDone` mem-BYPASS pengecekan ini, sehingga satu
    // worker tuntas bisa membangunkan root berkali-kali dengan isi identik. Signature ikut memuat
    // flag `done`, jadi transisi "belum selesai → SELESAI" tetap dianggap info baru dan terkirim.
    if (shouldSkipWake(this.lastReportSig.get(parentId), sig)) return
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

  /**
   * Ringkasan board 1-baris/sesi untuk pohon ini — disuntik ke ping (ganti read_board = hemat konteks).
   * `subsOnly` (dipakai semua ping ke ROOT): buang baris ROOT SENDIRI — root sudah tahu keadaannya
   * sendiri, jadi baris itu murni token terbuang di SETIAP ping.
   */
  private treeBoardSummary(treeId: string, subsOnly = false): string {
    const boardMap = new Map(this.db.getAllBoard().map((b) => [b.sessionId, b]))
    const lines: string[] = []
    for (const m of this.metaSnapshot()) {
      if (m.treeId !== treeId) continue
      if (subsOnly && m.role === 'root') continue
      const b = boardMap.get(m.id)
      const pct = b?.percent != null ? `, ${b.percent}%` : ''
      const prog = b?.progress ? ` — ${b.progress}` : b?.summary ? ` — ${b.summary}` : ''
      lines.push(`- ${m.title} (${m.status}${pct})${prog}`.slice(0, WAKE.boardLineMaxChars)) // 1 baris/sesi
    }
    const out = lines.join('\n') || '(belum ada laporan)'
    // Batas total: ringkasan ini disuntik ke SETIAP ping → jangan biarkan tumbuh tak terbatas.
    return out.length > WAKE.boardMaxChars ? out.slice(0, WAKE.boardMaxChars) + '\n… (dipotong)' : out
  }

  // FIX 4 — teks ping diringkas & larangan read_board dibuat eksplisit. Board di bawah SUDAH final:
  // memanggil read_board dari ping hanya menambah 1 tool-call + isi board yang sama ke konteks root.
  private rootStatusPrompt(treeId: string): string {
    return `[GROVE AUTO] Worker melapor. Board (final, JANGAN read_board):\n${this.treeBoardSummary(treeId, true)}\n\nBalas SATU baris ke user. Semua selesai → sintesis akhir.`
  }

  private loopCheckPrompt(treeId: string): string {
    return `[GROVE AUTO-CHECK] Udah sampai mana? Board (final, JANGAN read_board):\n${this.treeBoardSummary(treeId, true)}\n\nWorker idle tapi belum selesai → list_workers lalu assign_worker. Balas SATU baris ke user. SEMUA selesai → panggil task_done.`
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
        // FIX 6 — dedupe pakai SIGNATURE SUB (status/percent/progress), bukan treeBoardSummary.
        // treeBoardSummary memuat baris root + judul: balasan root atas ping SEBELUMNYA sudah
        // mengubahnya, jadi dedupe lama praktis tak pernah kena → tiap laporan = satu giliran root.
        const sig = this.subBoardSignature(treeId)
        if (shouldSkipWake(this.lastPingSummary.get(treeId), sig)) return
        this.lastPingSummary.set(treeId, sig)
        root.injectAutoTask(this.rootStatusPrompt(treeId))
      }, WAKE.rootStatusDebounceMs)
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
