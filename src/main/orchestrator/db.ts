// Papan Tulis (Board) — SQLite via sql.js (WASM, nol dependensi native).
// DB in-memory, di-export ke disk (debounce) setelah tiap mutasi.

import initSqlJs, { type Database } from 'sql.js'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Account, BoardEntry, ChatMessage, InboxMessage, Memory, SessionMeta, TodoItem } from '../../shared/types'

const require = createRequire(import.meta.url)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  sdk_session_id TEXT,
  tree_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  ctx_input INTEGER DEFAULT 0,
  ctx_output INTEGER DEFAULT 0,
  ctx_window INTEGER DEFAULT 200000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS board (
  session_id TEXT PRIMARY KEY,
  summary TEXT DEFAULT '',
  todo TEXT DEFAULT '[]',
  progress TEXT DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session TEXT NOT NULL,
  to_session TEXT,
  body TEXT NOT NULL,
  read_flag INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id, id);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export class Board {
  private db!: Database
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    const wasmFile = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))
    // Buffer → ArrayBuffer (emscripten menerima keduanya; @types minta ArrayBuffer)
    const wasmBinary = wasmFile.buffer.slice(
      wasmFile.byteOffset,
      wasmFile.byteOffset + wasmFile.byteLength
    ) as ArrayBuffer
    const SQL = await initSqlJs({ wasmBinary })
    this.db = existsSync(this.dbPath)
      ? new SQL.Database(Uint8Array.from(readFileSync(this.dbPath)))
      : new SQL.Database()
    this.db.run(SCHEMA)
    this.migrate()
  }

  /** Migrasi ringan untuk DB lama (CREATE TABLE IF NOT EXISTS tak menambah kolom baru). */
  private migrate(): void {
    for (const sql of [
      `ALTER TABLE board ADD COLUMN percent INTEGER`,
      `ALTER TABLE sessions ADD COLUMN order_index INTEGER`,
      `ALTER TABLE chat_messages ADD COLUMN detail TEXT`,
      `ALTER TABLE sessions ADD COLUMN account_id TEXT`,
      `ALTER TABLE accounts ADD COLUMN plan INTEGER`
    ]) {
      try {
        this.db.run(sql)
      } catch {
        /* kolom sudah ada → abaikan */
      }
    }
  }

  private all(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params as never)
    const rows: Record<string, unknown>[] = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  private run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as never)
    this.scheduleSave()
  }

  /** Tulis DB ke disk segera (dipakai saat app quit / sebelum baca ulang). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.writeAtomic()
  }

  /** Tulis atomik: ke .tmp lalu rename → tak ada torn-read walau ada akses barengan. */
  private writeAtomic(): void {
    const tmp = `${this.dbPath}.tmp`
    writeFileSync(tmp, Buffer.from(this.db.export()))
    renameSync(tmp, this.dbPath)
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        this.writeAtomic()
      } catch (e) {
        console.error('[Board] gagal simpan DB:', e)
      }
    }, 250)
  }

  // ---- sessions ------------------------------------------------------------

  upsertSession(m: SessionMeta): void {
    this.run(
      `INSERT INTO sessions
        (id, sdk_session_id, tree_id, parent_id, role, title, cwd, model, status,
         ctx_input, ctx_output, ctx_window, order_index, account_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         sdk_session_id=excluded.sdk_session_id, title=excluded.title, model=excluded.model,
         status=excluded.status, ctx_input=excluded.ctx_input, ctx_output=excluded.ctx_output,
         ctx_window=excluded.ctx_window, order_index=excluded.order_index,
         account_id=excluded.account_id, updated_at=excluded.updated_at`,
      [
        m.id, m.sdkSessionId ?? null, m.treeId, m.parentId, m.role, m.title, m.cwd,
        m.model ?? null, m.status, m.ctxInput, m.ctxOutput, m.ctxWindow,
        m.orderIndex ?? null, m.accountId ?? null, m.createdAt, m.updatedAt
      ]
    )
    this.run(
      `INSERT OR IGNORE INTO board (session_id, summary, todo, progress, updated_at)
       VALUES (?,?,?,?,?)`,
      [m.id, '', '[]', '', m.updatedAt]
    )
  }

  getAllSessions(): SessionMeta[] {
    return this.all(`SELECT * FROM sessions ORDER BY created_at ASC`).map(rowToSession)
  }

  deleteSession(id: string): void {
    this.run(`DELETE FROM sessions WHERE id=?`, [id])
    this.run(`DELETE FROM board WHERE session_id=?`, [id])
    this.run(`DELETE FROM messages WHERE from_session=? OR to_session=?`, [id, id])
    this.run(`DELETE FROM chat_messages WHERE session_id=?`, [id])
    this.run(`DELETE FROM memories WHERE session_id=? OR tree_id=?`, [id, id])
  }

  // ---- memories (hasil compact) --------------------------------------------

  addMemory(treeId: string, sessionId: string, content: string, ts: number): Memory {
    this.run(`INSERT INTO memories (tree_id, session_id, content, created_at) VALUES (?,?,?,?)`, [
      treeId, sessionId, content, ts
    ])
    const id = Number(this.all(`SELECT last_insert_rowid() AS id`)[0].id)
    return { id, treeId, sessionId, content, createdAt: ts }
  }

  getAllMemories(): Memory[] {
    return this.all(`SELECT * FROM memories ORDER BY created_at ASC`).map((r) => ({
      id: Number(r.id),
      treeId: String(r.tree_id),
      sessionId: String(r.session_id),
      content: String(r.content),
      createdAt: Number(r.created_at)
    }))
  }

  // ---- accounts (token TIDAK diekspos ke UI) & settings --------------------

  addAccount(id: string, label: string, token: string, ts: number, plan?: number): void {
    this.run(`INSERT INTO accounts (id, label, token, created_at, plan) VALUES (?,?,?,?,?)`, [
      id, label, token, ts, plan ?? null
    ])
  }

  /** Ubah ukuran paket sebuah akun (mis. 20 untuk Max 20x). */
  setAccountPlan(id: string, plan: number | null): void {
    this.run(`UPDATE accounts SET plan=? WHERE id=?`, [plan, id])
  }

  deleteAccount(id: string): void {
    this.run(`DELETE FROM accounts WHERE id=?`, [id])
  }

  /** Daftar akun TANPA token (aman dikirim ke renderer), termasuk ukuran paket. */
  getAccounts(): Account[] {
    return this.all(`SELECT id, label, created_at, plan FROM accounts ORDER BY created_at ASC`).map((r) => ({
      id: String(r.id),
      label: String(r.label),
      plan: r.plan == null ? undefined : Number(r.plan),
      createdAt: Number(r.created_at)
    }))
  }
  /** Token satu akun — hanya dipakai di main-process (inject ke query env). */
  getAccountToken(id: string): string | null {
    const r = this.all(`SELECT token FROM accounts WHERE id=?`, [id])[0]
    return r ? String(r.token) : null
  }

  getSetting(key: string): string | null {
    const r = this.all(`SELECT value FROM settings WHERE key=?`, [key])[0]
    return r ? String(r.value) : null
  }
  setSetting(key: string, value: string): void {
    this.run(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [
      key, value
    ])
  }

  setTitle(id: string, title: string, ts: number): void {
    this.run(`UPDATE sessions SET title=?, updated_at=? WHERE id=?`, [title, ts, id])
  }

  setOrderIndex(id: string, orderIndex: number, ts: number): void {
    this.run(`UPDATE sessions SET order_index=?, updated_at=? WHERE id=?`, [orderIndex, ts, id])
  }

  /** Normalisasi status basi 'running'/'waiting' → 'idle' (proses mati saat app ditutup). */
  normalizeStaleStatuses(): void {
    this.run(`UPDATE sessions SET status='idle' WHERE status IN ('running','waiting')`)
  }

  // ---- chat history --------------------------------------------------------

  /** Simpan pesan chat; kembalikan rowid agar detail tool bisa di-update saat outputnya tiba. */
  addChatMessage(sessionId: string, role: ChatMessage['role'], text: string, ts: number, detail?: string): number {
    this.run(`INSERT INTO chat_messages (session_id, role, text, ts, detail) VALUES (?,?,?,?,?)`, [
      sessionId, role, text, ts, detail ?? null
    ])
    return Number(this.all(`SELECT last_insert_rowid() AS id`)[0].id)
  }

  updateChatDetail(rowId: number, detail: string): void {
    this.run(`UPDATE chat_messages SET detail=? WHERE id=?`, [detail, rowId])
  }

  getChatMessages(sessionId: string): ChatMessage[] {
    return this.all(`SELECT role, text, ts, detail FROM chat_messages WHERE session_id=? ORDER BY id ASC`, [
      sessionId
    ]).map((r) => ({
      role: r.role as ChatMessage['role'],
      text: String(r.text),
      ts: Number(r.ts),
      detail: r.detail == null ? undefined : String(r.detail)
    }))
  }

  // ---- board ---------------------------------------------------------------

  setSummary(id: string, summary: string, ts: number): void {
    this.run(`UPDATE board SET summary=?, updated_at=? WHERE session_id=?`, [summary, ts, id])
  }
  setTodo(id: string, items: TodoItem[], ts: number): void {
    this.run(`UPDATE board SET todo=?, updated_at=? WHERE session_id=?`, [JSON.stringify(items), ts, id])
  }
  setProgress(id: string, progress: string, ts: number, percent?: number): void {
    if (percent === undefined) {
      this.run(`UPDATE board SET progress=?, updated_at=? WHERE session_id=?`, [progress, ts, id])
    } else {
      const pct = Math.max(0, Math.min(100, Math.round(percent)))
      this.run(`UPDATE board SET progress=?, percent=?, updated_at=? WHERE session_id=?`, [progress, pct, ts, id])
    }
  }

  getBoardEntry(id: string): BoardEntry | undefined {
    const r = this.all(`SELECT * FROM board WHERE session_id=?`, [id])[0]
    return r ? rowToBoard(r) : undefined
  }
  getAllBoard(): BoardEntry[] {
    return this.all(`SELECT * FROM board`).map(rowToBoard)
  }

  // ---- messages ------------------------------------------------------------

  addMessage(from: string, to: string | null, body: string, ts: number): InboxMessage {
    this.run(
      `INSERT INTO messages (from_session, to_session, body, read_flag, created_at) VALUES (?,?,?,0,?)`,
      [from, to, body, ts]
    )
    const id = Number(this.all(`SELECT last_insert_rowid() AS id`)[0].id)
    return { id, from, to, body, read: false, ts }
  }

  getMessagesFor(id: string, unreadOnly: boolean): InboxMessage[] {
    const rows = this.all(
      `SELECT * FROM messages
       WHERE (to_session=? OR to_session IS NULL) ${unreadOnly ? 'AND read_flag=0' : ''}
       ORDER BY created_at ASC`,
      [id]
    )
    return rows.map(rowToMessage)
  }

  markRead(ids: number[]): void {
    if (!ids.length) return
    this.run(`UPDATE messages SET read_flag=1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
  }

  getAllMessages(): InboxMessage[] {
    return this.all(`SELECT * FROM messages ORDER BY created_at ASC`).map(rowToMessage)
  }
}

// ---- row mappers -----------------------------------------------------------

function rowToSession(r: Record<string, unknown>): SessionMeta {
  return {
    id: String(r.id),
    sdkSessionId: (r.sdk_session_id as string) ?? undefined,
    treeId: String(r.tree_id),
    parentId: (r.parent_id as string) ?? null,
    role: r.role as SessionMeta['role'],
    title: String(r.title),
    cwd: String(r.cwd),
    model: (r.model as string) ?? undefined,
    status: r.status as SessionMeta['status'],
    ctxInput: Number(r.ctx_input) || 0,
    ctxOutput: Number(r.ctx_output) || 0,
    ctxWindow: Number(r.ctx_window) || 200000,
    orderIndex: r.order_index == null ? undefined : Number(r.order_index),
    accountId: r.account_id == null ? undefined : String(r.account_id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  }
}

function rowToBoard(r: Record<string, unknown>): BoardEntry {
  let todo: TodoItem[] = []
  try {
    todo = JSON.parse(String(r.todo ?? '[]'))
  } catch {
    todo = []
  }
  return {
    sessionId: String(r.session_id),
    summary: String(r.summary ?? ''),
    todo,
    progress: String(r.progress ?? ''),
    percent: r.percent == null ? undefined : Number(r.percent),
    updatedAt: Number(r.updated_at) || 0
  }
}

function rowToMessage(r: Record<string, unknown>): InboxMessage {
  return {
    id: Number(r.id),
    from: String(r.from_session),
    to: (r.to_session as string) ?? null,
    body: String(r.body),
    read: Number(r.read_flag) === 1,
    ts: Number(r.created_at)
  }
}
