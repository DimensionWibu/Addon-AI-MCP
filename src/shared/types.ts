// Tipe yang dipakai bersama antara main-process dan renderer.
// (renderer hanya mengimpor sebagai type-only, jadi tidak menyeret kode main.)

// CATATAN: status 'waiting' DIHAPUS — tak pernah ada satu pun `setStatus('waiting')` di kode, jadi
// ia hanya status mati. Fitur "butuh jawaban" yang NYATA memakai flag `awaitingInput` (kartu kedip
// kuning), bukan status ini. Baris DB lama berstatus 'waiting' tetap aman: dipetakan ke 'idle'
// saat dibaca (lihat normalizeStatus di db.ts) dan oleh normalizeStaleStatuses().
export type SessionStatus = 'idle' | 'running' | 'done' | 'error'
export type SessionRole = 'root' | 'sub'

export interface TodoItem {
  text: string
  done: boolean
}

export interface SessionMeta {
  id: string // id internal Grove
  sdkSessionId?: string // session_id dari SDK (untuk resume)
  treeId: string
  parentId: string | null
  role: SessionRole
  title: string
  cwd: string
  model?: string
  status: SessionStatus
  ctxInput: number
  ctxOutput: number
  ctxWindow: number
  orderIndex?: number // urutan manual dalam grup (role+parent) hasil drag; undefined → pakai createdAt
  // Akun Claude yang dipakai sesi ini. undefined = BELUM dipilih → sesi TIDAK akan start.
  // Grove berjalan murni dengan CLAUDE_CODE_OAUTH_TOKEN dari akun GUI; tidak ada lagi jalur diam-diam
  // ke ~/.claude/.credentials.json (login CLI), supaya billing tak pernah nyasar tanpa sepengetahuan user.
  accountId?: string
  createdAt: number
  updatedAt: number
}

export interface BoardEntry {
  sessionId: string
  summary: string
  todo: TodoItem[]
  progress: string
  percent?: number // 0-100 progres kasar (dari report_progress/report_to_parent); undefined = belum ada
  updatedAt: number
}

export interface InboxMessage {
  id: number
  from: string
  to: string | null // null = broadcast
  body: string
  read: boolean
  ts: number
}

/** Provider akun. 'claude' = langganan Claude (CLAUDE_CODE_OAUTH_TOKEN). 'openrouter' = key
 *  OpenRouter, dipakai lewat "Anthropic Skin" (ANTHROPIC_BASE_URL=https://openrouter.ai/api +
 *  ANTHROPIC_AUTH_TOKEN). CATATAN: OpenRouter sendiri hanya MENJAMIN Claude Code untuk provider
 *  Anthropic 1P — model non-Claude (mis. Nemotron) bisa saja tak patuh protokol tool Claude Code. */
export type AccountProvider = 'claude' | 'openrouter'

/** Akun untuk dipakai per-session. Token/key TIDAK pernah dikirim ke renderer. */
export interface Account {
  id: string
  label: string
  /** undefined/'claude' = akun Claude; 'openrouter' = key OpenRouter. */
  provider?: AccountProvider
  /** Untuk 'openrouter': id model OpenRouter yang WAJIB dipakai akun ini (mis.
   *  nvidia/nemotron-3-super-120b-a12b:free). Alias claude (opus/sonnet/haiku) tak berlaku di sini. */
  model?: string
  /** Ukuran paket (mis. 20 untuk Max 20x, 5 untuk Max 5x). Dipakai memilih akun terbesar
   *  sebagai cadangan saat SEMUA akun sudah menembus ambang kuota — agar kerja tak terkunci. */
  plan?: number
  /** Ambang usage (persen) yang memicu pindah akun untuk akun INI. undefined → pakai default global.
   *  Ambang hanya bisa ditegakkan bila usage akun ini TERBACA — lihat `usageReadable`. */
  switchPct?: number
  /** Apakah usage akun ini benar-benar bisa dibaca (probe terakhir). undefined = belum pernah diprobe.
   *  Token `setup-token` (tanpa scope user:profile) TETAP terbaca lewat header rate-limit Messages API,
   *  jadi false di sini berarti benar-benar buntu — mis. token dicabut/kedaluwarsa.
   *  false → ambang tidak aktif; proteksi yang tersisa hanya switch REAKTIF saat kena limit. */
  usageReadable?: boolean
  createdAt: number
}

/** Kondisi akun + preferensi rotasi, dikirim bareng agar UI tak pernah setengah-sinkron. */
export interface AccountsState {
  accounts: Account[]
  autoSwitch: boolean
  autoResume: boolean
  /** Ambang yang dipakai akun tanpa `switchPct` sendiri. */
  defaultSwitchPct: number
  /** Akun GLOBAL: dipakai pohon yang tak menentukan akunnya sendiri. null = belum diset. */
  defaultAccountId: string | null
  /** Model GLOBAL: dipakai sesi yang tak menentukan model sendiri. null = default SDK. */
  defaultModel: string | null
}

/** Base URL "Anthropic Skin" OpenRouter — Claude Code menambahkan /v1/messages sendiri. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api'

/** Satu model OpenRouter (mendukung tools) untuk dropdown pilih model. */
export interface OpenRouterModel {
  id: string // mis. nvidia/nemotron-3-super-120b-a12b:free
  name: string // nama tampil dari OpenRouter
  context: number // panjang context (token)
  paramB: string // ukuran parameter mis. "120B" ('' bila tak diketahui)
  free: boolean // input & output $0
}

/** Saran model OpenRouter gratis untuk dropdown (id persis dari openrouter.ai/api/v1/models). */
export const OPENROUTER_MODEL_SUGGESTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super (free)' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra (free)' },
  { id: 'nvidia/nemotron-3-nano-30b-a3b:free', label: 'Nemotron 3 Nano 30B (free)' }
]

/** Pilihan model yang ditawarkan di UI. value '' = mewarisi/default. Alias Claude Code (opus/sonnet/
 *  haiku) sengaja dipakai — ringkas, dikenal CLI, dan memudahkan turun ke model lebih murah demi kuota. */
export const MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

/** Label pendek untuk sebuah nilai model (untuk badge/pilihan). Nilai tak dikenal → apa adanya. */
export function modelLabel(model?: string | null): string {
  if (!model) return 'Default'
  const hit = MODEL_OPTIONS.find((m) => m.value === model)
  return hit ? hit.label : model
}

/** Hasil "compact": ringkasan konsolidasi 1 pohon, disimpan persist di DB Grove. */
export interface Memory {
  id: number
  treeId: string
  sessionId: string // root yang men-compact
  content: string
  createdAt: number
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  ts: number
  images?: string[] // data URL untuk ditampilkan (tidak dipersist ke DB)
  detail?: string // untuk baris tool: input lengkap (+ output tool saat tiba) yang bisa di-expand
  toolUseId?: string // korelasi live untuk menempel output tool (tidak dipersist)
}

/** Gambar dari clipboard untuk dikirim ke Claude. */
export interface ImageAttachment {
  mediaType: string // mis. "image/png"
  data: string // base64 tanpa prefix "data:..."
}

/** Node pohon untuk sidebar (SessionMeta + persen context + board + anak). */
export interface TreeNode extends SessionMeta {
  ctxPercent: number
  board?: BoardEntry
  loopActive?: boolean // auto-check berkala ("udah sampe mana?") aktif (root saja)
  children: TreeNode[]
}

/** Snapshot penuh untuk render awal UI. */
export interface GroveSnapshot {
  trees: TreeNode[]
  board: BoardEntry[]
  messages: InboxMessage[]
  memories: Memory[]
}

export interface UsageWindow {
  utilization: number | null // persen terpakai
  resetsAt: string | null // ISO timestamp
}

export interface UsageInfo {
  fiveHour: UsageWindow
  sevenDay: UsageWindow
  sevenDayOpus?: UsageWindow
  sevenDaySonnet?: UsageWindow
  monthly?: {
    enabled: boolean
    limit: number | null
    used: number | null
    utilization: number | null
    currency: string | null
  }
  fetchedAt: number
  stale?: boolean // true = fetch terakhir gagal, ini nilai last-good (token mungkin sedang refresh)
}

/** Kenapa usage sebuah akun tak bisa ditampilkan — supaya UI jujur, bukan diam-diam kosong. */
export type UsageUnavailable =
  | 'no-token' // akun tak punya token tersimpan
  | 'scope' // 403: token `claude setup-token` tak punya scope user:profile (kasus paling umum)
  | 'unauthorized' // 401: token ditolak/kedaluwarsa
  | 'rate-limited' // 429
  | 'error' // jaringan/lainnya

/**
 * Usage SELALU dibawa bersama identitas akun pemiliknya. Tanpa ini angka jadi ambigu:
 * user tak bisa tahu "5-jam 19%" itu milik akun mana (bug lama: selalu akun login utama).
 * usage null = tak bisa diketahui untuk akun INI — UI menampilkan alasannya, dan JANGAN
 * pernah menggantinya dengan angka akun lain.
 */
export interface UsageSnapshot {
  accountId: string | null // null = login utama (~/.claude/.credentials.json)
  accountLabel: string
  accountEmail: string | null // hanya bisa didapat bila token punya scope user:profile
  usage: UsageInfo | null
  reason?: UsageUnavailable // terisi saat usage null
}

/** Event yang dikirim main → renderer lewat channel 'grove:event'. */
export type GroveEvent =
  | { channel: 'session:new'; payload: SessionMeta & { ctxPercent: number } }
  | {
      channel: 'session:update'
      payload: { id: string } & Partial<SessionMeta> & {
          ctxPercent?: number
          ctxPending?: boolean // true = konteks baru di-reset (compact); UI tampilkan badge netral, bukan 0%
          tokensTotal?: number
          loopActive?: boolean
          apiStopped?: boolean
          awaitingInput?: boolean // turn berhenti menunggu jawaban user/parent → kartu berkedip kuning
        }
    }
  | { channel: 'chat:delta'; payload: { id: string; delta: string } }
  | { channel: 'chat:message'; payload: { id: string; message: ChatMessage } }
  | { channel: 'chat:detail'; payload: { id: string; toolUseId: string; detail: string } }
  | { channel: 'board:update'; payload: BoardEntry }
  | { channel: 'message:new'; payload: InboxMessage }
  | { channel: 'memory:new'; payload: Memory }
  | {
      channel: 'accounts:update'
      // Sengaja memakai AccountsState yang SAMA dengan listAccounts() — dulu tipe ini disalin
      // inline, lalu ikut basi tiap kali ada field baru (bug: renderer tak melihat field itu).
      payload: AccountsState
    }
  | { channel: 'session:removed'; payload: { ids: string[] } }
  | { channel: 'session:activity'; payload: { id: string; activity: string } }
  | { channel: 'usage:update'; payload: UsageSnapshot }
  /** Sesi tak bisa jalan karena belum ada akun/token. UI menampilkan banner, app TETAP jalan. */
  | {
      channel: 'auth:missing'
      payload: {
        sessionId: string
        sessionTitle: string
        /** true = akun sudah dipilih tapi tokennya hilang; false = memang belum pilih akun sama sekali. */
        tokenMissing: boolean
        /** Ada tidaknya akun tersimpan — menentukan bunyi ajakan ("tambah akun" vs "pilih akun"). */
        hasAccounts: boolean
      }
    }

/** API yang dibuka preload sebagai window.grove */
export interface GroveApi {
  getPathForFile: (file: File) => string
  dropFolder: (path: string, title?: string) => Promise<SessionMeta>
  newChat: (title?: string) => Promise<SessionMeta>
  pickFolder: () => Promise<SessionMeta | null>
  /** Kunci sesi yang SUDAH ADA ke folder project (drag-drop folder ke kartu sesi). */
  setSessionCwd: (id: string, path: string) => Promise<SessionMeta>
  sendChat: (id: string, text: string, images?: ImageAttachment[]) => Promise<void>
  stopSession: (id: string) => Promise<void>
  stopAll: () => Promise<number>
  reorderSessions: (orderedIds: string[]) => Promise<void>
  compactSession: (id: string) => Promise<void>
  setLoop: (id: string, enabled: boolean) => Promise<void>
  listAccounts: () => Promise<AccountsState>
  addAccount: (
    label: string,
    token: string,
    plan?: number,
    switchPct?: number,
    provider?: AccountProvider,
    model?: string
  ) => Promise<Account>
  deleteAccount: (id: string) => Promise<void>
  /** Ambang auto-switch akun ini; null → kembali ikut default global. */
  setAccountSwitchPct: (id: string, pct: number | null) => Promise<void>
  /** Ambang default untuk akun yang tak punya ambang sendiri. */
  setDefaultSwitchPct: (pct: number) => Promise<void>
  /** Akun GLOBAL: dipakai semua pohon yang tak menentukan akunnya sendiri. */
  setDefaultAccount: (accountId: string | null) => Promise<void>
  /** Model GLOBAL: dipakai semua sesi yang tak menentukan model sendiri. */
  setDefaultModel: (model: string | null) => Promise<void>
  /** Model sebuah sesi (null = kembali mewarisi dari sesi utama / global). */
  setSessionModel: (id: string, model: string | null) => Promise<void>
  /** Daftar model OpenRouter (mendukung tools) untuk dropdown; freeOnly default true. */
  listOpenRouterModels: (freeOnly?: boolean) => Promise<OpenRouterModel[]>
  setSessionAccount: (id: string, accountId: string | null) => Promise<void>
  setAutoSwitch: (on: boolean) => Promise<void>
  setAutoResume: (on: boolean) => Promise<void>
  interruptSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<string[]>
  getSnapshot: () => Promise<GroveSnapshot>
  getChat: (id: string) => Promise<ChatMessage[]>
  /** Refresh MANUAL usage akun sesi terpilih (tombol ↻). Ber-cooldown 10s di main → klik saat cooldown balik cache. */
  refreshUsage: () => Promise<UsageSnapshot>
  /** Beri tahu main sesi mana yang sedang dipilih; balikan = snapshot cache akun itu (tanpa nunggu fetch). */
  setUsageSession: (sessionId: string | null) => Promise<UsageSnapshot>
  onEvent: (cb: (ev: GroveEvent) => void) => () => void
}

declare global {
  interface Window {
    grove: GroveApi
  }
}
