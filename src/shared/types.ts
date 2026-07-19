// Tipe yang dipakai bersama antara main-process dan renderer.
// (renderer hanya mengimpor sebagai type-only, jadi tidak menyeret kode main.)

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error'
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
  accountId?: string // akun Claude yang dipakai session ini; undefined → login default
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

/** Akun Claude (langganan) untuk dipakai per-session. Token TIDAK pernah dikirim ke renderer. */
export interface Account {
  id: string
  label: string
  createdAt: number
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

/** Event yang dikirim main → renderer lewat channel 'grove:event'. */
export type GroveEvent =
  | { channel: 'session:new'; payload: SessionMeta & { ctxPercent: number } }
  | {
      channel: 'session:update'
      payload: { id: string } & Partial<SessionMeta> & {
          ctxPercent?: number
          tokensTotal?: number
          loopActive?: boolean
          apiStopped?: boolean
        }
    }
  | { channel: 'chat:delta'; payload: { id: string; delta: string } }
  | { channel: 'chat:message'; payload: { id: string; message: ChatMessage } }
  | { channel: 'chat:detail'; payload: { id: string; toolUseId: string; detail: string } }
  | { channel: 'board:update'; payload: BoardEntry }
  | { channel: 'message:new'; payload: InboxMessage }
  | { channel: 'memory:new'; payload: Memory }
  | { channel: 'accounts:update'; payload: { accounts: Account[]; autoSwitch: boolean; autoResume: boolean } }
  | { channel: 'session:removed'; payload: { ids: string[] } }
  | { channel: 'session:activity'; payload: { id: string; activity: string } }
  | { channel: 'usage:update'; payload: UsageInfo | null }

/** API yang dibuka preload sebagai window.grove */
export interface GroveApi {
  getPathForFile: (file: File) => string
  dropFolder: (path: string, title?: string) => Promise<SessionMeta>
  newChat: (title?: string) => Promise<SessionMeta>
  pickFolder: () => Promise<SessionMeta | null>
  sendChat: (id: string, text: string, images?: ImageAttachment[]) => Promise<void>
  stopSession: (id: string) => Promise<void>
  stopAll: () => Promise<number>
  reorderSessions: (orderedIds: string[]) => Promise<void>
  compactSession: (id: string) => Promise<void>
  setLoop: (id: string, enabled: boolean) => Promise<void>
  listAccounts: () => Promise<{ accounts: Account[]; autoSwitch: boolean; autoResume: boolean }>
  addAccount: (label: string, token: string) => Promise<Account>
  deleteAccount: (id: string) => Promise<void>
  setSessionAccount: (id: string, accountId: string | null) => Promise<void>
  setAutoSwitch: (on: boolean) => Promise<void>
  setAutoResume: (on: boolean) => Promise<void>
  interruptSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<string[]>
  getSnapshot: () => Promise<GroveSnapshot>
  getChat: (id: string) => Promise<ChatMessage[]>
  getUsage: () => Promise<UsageInfo | null>
  onEvent: (cb: (ev: GroveEvent) => void) => () => void
}

declare global {
  interface Window {
    grove: GroveApi
  }
}
