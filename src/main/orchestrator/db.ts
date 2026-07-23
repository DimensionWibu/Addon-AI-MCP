// Papan Tulis (Board) — SQLite via sql.js (WASM, nol dependensi native).
// DB in-memory, di-export ke disk (debounce) setelah tiap mutasi.

import initSqlJs, { type Database } from 'sql.js'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Account, BoardEntry, ChatMessage, InboxMessage, Memory, SessionMeta, TodoItem } from '../../shared/types'
import { isEffort } from '../../shared/types'

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
-- Read-state PER-PENERIMA: broadcast (to_session IS NULL) harus bisa dibaca SETIAP sibling.
-- read_flag global lama hanya cukup untuk indikator UI; pengiriman ulang broadcast dipandu tabel ini.
CREATE TABLE IF NOT EXISTS message_reads (
  message_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (message_id, session_id)
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
-- Akun PILIHAN user per sesi ("pin"). Auto-switch akibat limit hanya SEMENTARA; nilai di sinilah yang
-- dipakai restorePinnedAccounts() untuk mengembalikan sesi ke akun yang benar — WAJIB tahan restart,
-- kalau tidak sesi bisa nyangkut permanen di akun pengganti (billing salah akun).
-- Baris ADA = ada pin; account_id NULL = pin ke "Default (login utama)" (beda dari tak ada baris).
-- Sengaja tabel TERPISAH (bukan kolom di tabel sessions) supaya upsertSession — yang dipanggil sangat
-- sering utk status/ctx — tak pernah bisa menimpa pin secara tak sengaja.
CREATE TABLE IF NOT EXISTS session_pins (
  session_id TEXT PRIMARY KEY,
  account_id TEXT
);
-- Riwayat pemakaian token PER JAM per akun (persist, biar besok-besok bisa dicek boros/normal).
-- Bucket per jam menjaga tabel tetap kecil (24 baris/hari/akun). Agregasi jam/hari/minggu dihitung
-- di SessionManager (timezone lokal) dari baris-baris ini. Dicatat tiap respons API (lihat applyUsage).
CREATE TABLE IF NOT EXISTS usage_hourly (
  hour_start INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_start, account_id)
);
-- REFERENSI ANTAR-SESI, SATU ARAH. helper_id boleh MEMBACA papan/ekor chat target dan MENGIRIM
-- pesan ke sana; target TIDAK tahu apa-apa dan TIDAK punya akses balik (dua baris berlawanan
-- sengaja ditolak di SessionManager). Ini murni kanal koordinasi: konteks & cache SDK tetap
-- terkunci per-sesi (tiap sesi punya sdkSessionId sendiri) — dua sesi di folder kerja yang sama
-- pun tak pernah berbagi percakapan.
CREATE TABLE IF NOT EXISTS session_refs (
  helper_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (helper_id, target_id)
);
`

// Debounce simpan-ke-disk. sql.js meng-EXPORT SELURUH image DB tiap simpan (O(ukuran DB),
// di main-thread) → semakin jarang, semakin sedikit micro-freeze yang menghentikan semua sesi.
// Tetap aman: flush() dipanggil saat app before-quit (lihat index.ts) + data hidup di memori.
const SAVE_DEBOUNCE_MS = 1500

export class Board {
  private db!: Database
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false // ada mutasi sejak simpan terakhir? bila tidak, lewati export (mahal).

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
      `ALTER TABLE accounts ADD COLUMN plan INTEGER`,
      // Ambang auto-switch PER AKUN (persen). NULL → pakai default global (DEFAULT_SWITCH_PCT).
      `ALTER TABLE accounts ADD COLUMN switch_pct INTEGER`,
      // Provider akun: NULL/'claude' = token Claude (CLAUDE_CODE_OAUTH_TOKEN); 'openrouter' = key
      // OpenRouter, 'deepseek' = API key DeepSeek (keduanya via ANTHROPIC_BASE_URL konstanta +
      // ANTHROPIC_AUTH_TOKEN). or_model = id model yang WAJIB dipakai akun itu (mis.
      // nvidia/nemotron-3-super-120b-a12b:free, atau deepseek-v4-pro).
      `ALTER TABLE accounts ADD COLUMN provider TEXT`,
      `ALTER TABLE accounts ADD COLUMN or_model TEXT`,
      // Untuk provider 'custom': base URL endpoint Anthropic-compatible sendiri (proxy lokal), mis.
      // http://localhost:4000 → dipakai sebagai ANTHROPIC_BASE_URL. NULL untuk claude/openrouter.
      `ALTER TABLE accounts ADD COLUMN base_url TEXT`,
      // Mode RINGAN sesi: 1 = tanpa MCP grove + tanpa append protokol (CLI-parity, hemat token).
      // NULL/0 = orkestrator penuh. Sesi lama → NULL → orkestrator (perilaku lama tak berubah).
      `ALTER TABLE sessions ADD COLUMN lite INTEGER`,
      // Tingkat mikir per-sesi ('off'|'low'|'medium'|'high'|'xhigh'|'max'). NULL = mewarisi
      // (sesi utama → global → default model), persis pola kolom model.
      `ALTER TABLE sessions ADD COLUMN effort TEXT`
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
    this.dirty = true // tandai perlu simpan → writeAtomic tak akan meng-skip
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
    if (!this.dirty) return // tak ada perubahan sejak simpan terakhir → jangan export seluruh DB (mahal)
    const tmp = `${this.dbPath}.tmp`
    writeFileSync(tmp, Buffer.from(this.db.export()))
    renameSync(tmp, this.dbPath)
    this.dirty = false
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
    }, SAVE_DEBOUNCE_MS)
  }

  // ---- sessions ------------------------------------------------------------

  upsertSession(m: SessionMeta): void {
    this.run(
      `INSERT INTO sessions
        (id, sdk_session_id, tree_id, parent_id, role, title, cwd, model, status,
         ctx_input, ctx_output, ctx_window, order_index, account_id, lite, effort, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         -- cwd WAJIB ikut diperbarui: folder kerja BISA berubah (drop folder ke kartu sesi →
         -- setSessionCwd). Dulu kolom ini tak ada di daftar UPDATE, jadi perubahan folder hanya
         -- hidup di memori. Setelah restart, sesi kembali memakai folder LAMA sementara
         -- sdk_session_id (yang ikut diperbarui) menunjuk percakapan milik folder BARU — Claude Code
         -- menyimpan transkrip per folder project, jadi resume-nya gagal:
         -- "No conversation found with session ID: …" dan sesi tak bisa dilanjut sama sekali.
         cwd=excluded.cwd,
         sdk_session_id=excluded.sdk_session_id, title=excluded.title, model=excluded.model,
         status=excluded.status, ctx_input=excluded.ctx_input, ctx_output=excluded.ctx_output,
         ctx_window=excluded.ctx_window, order_index=excluded.order_index,
         account_id=excluded.account_id, lite=excluded.lite, effort=excluded.effort,
         updated_at=excluded.updated_at`,
      [
        m.id, m.sdkSessionId ?? null, m.treeId, m.parentId, m.role, m.title, m.cwd,
        m.model ?? null, m.status, m.ctxInput, m.ctxOutput, m.ctxWindow,
        m.orderIndex ?? null, m.accountId ?? null, m.lite ? 1 : null, m.effort ?? null,
        m.createdAt, m.updatedAt
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

  // ---- pin akun per-sesi (pilihan eksplisit user; tahan restart) ------------

  /** Simpan/ubah pin akun pilihan user. accountId null = pin ke "Default (login utama)". */
  setSessionPin(sessionId: string, accountId: string | null): void {
    this.run(
      `INSERT INTO session_pins (session_id, account_id) VALUES (?,?)
       ON CONFLICT(session_id) DO UPDATE SET account_id=excluded.account_id`,
      [sessionId, accountId]
    )
  }

  /** Semua pin tersimpan → dimuat ke memori saat startup (SessionManager.loadFromDisk). */
  getAllSessionPins(): { sessionId: string; accountId: string | null }[] {
    return this.all(`SELECT session_id, account_id FROM session_pins`).map((r) => ({
      sessionId: String(r.session_id),
      accountId: r.account_id == null ? null : String(r.account_id)
    }))
  }

  deleteSession(id: string): void {
    // Bersihkan read-state DULU (sebelum baris messages hilang): milik sesi ini + utk pesan yg akan dihapus.
    this.run(`DELETE FROM message_reads WHERE session_id=?`, [id])
    this.run(
      `DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE from_session=? OR to_session=?)`,
      [id, id]
    )
    this.run(`DELETE FROM sessions WHERE id=?`, [id])
    this.run(`DELETE FROM session_pins WHERE session_id=?`, [id]) // jangan tinggalkan pin yatim
    this.run(`DELETE FROM board WHERE session_id=?`, [id])
    this.run(`DELETE FROM messages WHERE from_session=? OR to_session=?`, [id, id])
    this.run(`DELETE FROM chat_messages WHERE session_id=?`, [id])
    this.run(`DELETE FROM memories WHERE session_id=? OR tree_id=?`, [id, id])
    this.run(`DELETE FROM session_refs WHERE helper_id=? OR target_id=?`, [id, id]) // tautan yatim
  }

  // ---- referensi antar-sesi (satu arah: helper → target) --------------------

  addRef(helperId: string, targetId: string, ts: number): void {
    this.run(`INSERT OR IGNORE INTO session_refs (helper_id, target_id, created_at) VALUES (?,?,?)`, [
      helperId, targetId, ts
    ])
  }
  removeRef(helperId: string, targetId: string): void {
    this.run(`DELETE FROM session_refs WHERE helper_id=? AND target_id=?`, [helperId, targetId])
  }
  /** Target yang boleh dibantu oleh helper ini. */
  getRefTargets(helperId: string): string[] {
    return this.all(`SELECT target_id FROM session_refs WHERE helper_id=? ORDER BY created_at ASC`, [helperId]).map(
      (r) => String(r.target_id)
    )
  }
  /** Semua tautan (dipakai cek arah-balik & bersih-bersih). */
  getAllRefs(): Array<{ helperId: string; targetId: string }> {
    return this.all(`SELECT helper_id, target_id FROM session_refs`).map((r) => ({
      helperId: String(r.helper_id),
      targetId: String(r.target_id)
    }))
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

  addAccount(
    id: string,
    label: string,
    token: string,
    ts: number,
    plan?: number,
    switchPct?: number,
    provider?: string,
    orModel?: string,
    baseUrl?: string
  ): void {
    this.run(
      `INSERT INTO accounts (id, label, token, created_at, plan, switch_pct, provider, or_model, base_url) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, label, token, ts, plan ?? null, switchPct ?? null, provider ?? null, orModel ?? null, baseUrl ?? null]
    )
  }

  /** Ubah ukuran paket sebuah akun (mis. 20 untuk Max 20x). */
  setAccountPlan(id: string, plan: number | null): void {
    this.run(`UPDATE accounts SET plan=? WHERE id=?`, [plan, id])
  }

  /** Ambang auto-switch akun ini (persen). null → ikut default global. */
  setAccountSwitchPct(id: string, pct: number | null): void {
    this.run(`UPDATE accounts SET switch_pct=? WHERE id=?`, [pct, id])
  }

  deleteAccount(id: string): void {
    this.run(`DELETE FROM accounts WHERE id=?`, [id])
  }

  /** Daftar akun TANPA token (aman dikirim ke renderer), termasuk ukuran paket. */
  getAccounts(): Account[] {
    return this.all(
      `SELECT id, label, created_at, plan, switch_pct, provider, or_model, base_url FROM accounts ORDER BY created_at ASC`
    ).map((r) => ({
      id: String(r.id),
      label: String(r.label),
      plan: r.plan == null ? undefined : Number(r.plan),
      switchPct: r.switch_pct == null ? undefined : Number(r.switch_pct),
      provider:
        r.provider === 'openrouter'
          ? ('openrouter' as const)
          : r.provider === 'custom'
            ? ('custom' as const)
            : r.provider === 'cursor'
              ? ('cursor' as const)
              : r.provider === 'deepseek'
                ? ('deepseek' as const)
                : r.provider === 'dzax'
                  ? ('dzax' as const)
                  : ('claude' as const),
      model: r.or_model == null ? undefined : String(r.or_model),
      baseUrl: r.base_url == null ? undefined : String(r.base_url),
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

  // ---- riwayat pemakaian token (per jam per akun) --------------------------

  /** Tambahkan pemakaian satu respons API ke bucket jam+akunnya (dijumlahkan). */
  addUsage(
    hourStart: number,
    accountId: string,
    provider: string | null,
    input: number,
    cacheRead: number,
    cacheCreation: number,
    output: number
  ): void {
    this.run(
      `INSERT INTO usage_hourly (hour_start, account_id, provider, input, cache_read, cache_creation, output, calls)
       VALUES (?,?,?,?,?,?,?,1)
       ON CONFLICT(hour_start, account_id) DO UPDATE SET
         input = input + excluded.input,
         cache_read = cache_read + excluded.cache_read,
         cache_creation = cache_creation + excluded.cache_creation,
         output = output + excluded.output,
         calls = calls + 1,
         provider = excluded.provider`,
      [hourStart, accountId, provider, input, cacheRead, cacheCreation, output]
    )
  }

  /** Baris bucket jam sejak `sinceTs` (agregasi jam/hari/minggu dihitung di SessionManager, TZ lokal). */
  getUsageRows(sinceTs: number): Array<{
    hourStart: number
    accountId: string
    provider: string | null
    input: number
    cacheRead: number
    cacheCreation: number
    output: number
    calls: number
  }> {
    return this.all(
      `SELECT hour_start, account_id, provider, input, cache_read, cache_creation, output, calls
       FROM usage_hourly WHERE hour_start >= ? ORDER BY hour_start ASC`,
      [sinceTs]
    ).map((r) => ({
      hourStart: Number(r.hour_start),
      accountId: String(r.account_id),
      provider: r.provider == null ? null : String(r.provider),
      input: Number(r.input),
      cacheRead: Number(r.cache_read),
      cacheCreation: Number(r.cache_creation),
      output: Number(r.output),
      calls: Number(r.calls)
    }))
  }

  /** Total kumulatif SEPANJANG waktu, DIPECAH per akun (untuk biaya per-akun "sejak awal"). */
  getUsageAllTimeByAccount(): Array<{
    accountId: string
    input: number
    cacheRead: number
    cacheCreation: number
    output: number
    calls: number
  }> {
    return this.all(
      `SELECT account_id, COALESCE(SUM(input),0) i, COALESCE(SUM(cache_read),0) cr,
              COALESCE(SUM(cache_creation),0) cc, COALESCE(SUM(output),0) o, COALESCE(SUM(calls),0) n
       FROM usage_hourly GROUP BY account_id`
    ).map((r) => ({
      accountId: String(r.account_id),
      input: Number(r.i),
      cacheRead: Number(r.cr),
      cacheCreation: Number(r.cc),
      output: Number(r.o),
      calls: Number(r.n)
    }))
  }

  /** Total kumulatif SEPANJANG waktu (untuk baris "sejak dipakai"). */
  getUsageAllTime(): { input: number; cacheRead: number; cacheCreation: number; output: number; calls: number } {
    const r = this.all(
      `SELECT COALESCE(SUM(input),0) i, COALESCE(SUM(cache_read),0) cr,
              COALESCE(SUM(cache_creation),0) cc, COALESCE(SUM(output),0) o, COALESCE(SUM(calls),0) n
       FROM usage_hourly`
    )[0]
    return {
      input: Number(r?.i ?? 0),
      cacheRead: Number(r?.cr ?? 0),
      cacheCreation: Number(r?.cc ?? 0),
      output: Number(r?.o ?? 0),
      calls: Number(r?.n ?? 0)
    }
  }

  setTitle(id: string, title: string, ts: number): void {
    this.run(`UPDATE sessions SET title=?, updated_at=? WHERE id=?`, [title, ts, id])
  }

  setOrderIndex(id: string, orderIndex: number, ts: number): void {
    this.run(`UPDATE sessions SET order_index=?, updated_at=? WHERE id=?`, [orderIndex, ts, id])
  }

  /**
   * Normalisasi status basi → 'idle' (proses mati saat app ditutup).
   * 'waiting' SENGAJA tetap disebut di SQL ini: status itu sudah dihapus dari kode, tapi DB user
   * lama mungkin masih menyimpannya — biarkan ikut dibersihkan agar tak tertinggal selamanya.
   */
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
    // unreadOnly: "belum dibaca OLEH SESI INI" (per-penerima), bukan read_flag global — supaya
    // broadcast yang sudah dibaca sibling lain TETAP sampai ke sesi ini.
    const rows = this.all(
      `SELECT * FROM messages
       WHERE (to_session=? OR to_session IS NULL)
       ${unreadOnly ? 'AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id=messages.id AND r.session_id=?)' : ''}
       ORDER BY created_at ASC`,
      unreadOnly ? [id, id] : [id]
    )
    return rows.map(rowToMessage)
  }

  /**
   * Tandai pesan-pesan ini sudah dibaca OLEH `sessionId` (per-penerima). Broadcast jadi aman:
   * tiap sibling punya baris read-nya sendiri. Sekaligus set read_flag global agar panel pesan
   * UI (getAllMessages) tetap menampilkan status "read" seperti sebelumnya.
   */
  markReadFor(sessionId: string, ids: number[]): void {
    if (!ids.length) return
    const values = ids.map(() => '(?,?)').join(',')
    const params: unknown[] = []
    for (const mid of ids) params.push(mid, sessionId)
    this.run(`INSERT OR IGNORE INTO message_reads (message_id, session_id) VALUES ${values}`, params)
    this.run(`UPDATE messages SET read_flag=1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
  }

  getAllMessages(): InboxMessage[] {
    return this.all(`SELECT * FROM messages ORDER BY created_at ASC`).map(rowToMessage)
  }
}

// ---- row mappers -----------------------------------------------------------

/**
 * Status dari DB → SessionStatus, TOLERAN terhadap nilai lama/asing.
 * DB user lama bisa menyimpan status 'waiting' (status yang kini sudah dihapus karena tak pernah
 * di-set kode mana pun) — dipetakan ke 'idle' supaya baris lama tetap terbaca dan app tidak gagal
 * start. Nilai tak dikenal apa pun juga jatuh ke 'idle' daripada menyelundupkan status tak valid.
 */
function normalizeStatus(raw: unknown): SessionMeta['status'] {
  const s = String(raw ?? '')
  return s === 'running' || s === 'done' || s === 'error' || s === 'idle' ? s : 'idle'
}

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
    status: normalizeStatus(r.status),
    ctxInput: Number(r.ctx_input) || 0,
    ctxOutput: Number(r.ctx_output) || 0,
    ctxWindow: Number(r.ctx_window) || 200000,
    orderIndex: r.order_index == null ? undefined : Number(r.order_index),
    accountId: r.account_id == null ? undefined : String(r.account_id),
    lite: r.lite ? true : undefined,
    effort: isEffort(r.effort) ? r.effort : undefined,
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
