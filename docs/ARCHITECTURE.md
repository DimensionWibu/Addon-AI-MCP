# Grove — Arsitektur Orchestrator Multi-Agent Claude

> Codename **Grove** (kebun): tiap "pohon session" berdiri sendiri (terisolasi), tapi
> semuanya tumbuh di satu kebun dan berbagi satu **papan tulis** di tanah yang sama.
>
> Stack: **Electron + TypeScript** · **@anthropic-ai/claude-agent-sdk** · **SQLite (sql.js)** · **zod**

---

## 1. Tujuan

GUI desktop (tema gelap, gaya "DanaZ Universal") untuk **mengorkestrasi banyak session Claude Code paralel**:

- **Drag-n-drop folder proyek** → spawn satu session **UTAMA** (root worker) untuk folder itu.
- Session UTAMA bisa **spawn sub-session (multi-agent)** secara otomatis saat butuh → membentuk **pohon**.
- **Banyak pohon** boleh jalan bersamaan dengan tugas berbeda.
- **Double-click** node session → lihat progress detail + chat session itu.
- Di samping judul & ID tiap session → **% context** terpakai.
- **Kolom chat berganti** mengikuti session yang dipilih.

---

## 2. Terminologi

| Istilah | Arti |
|---|---|
| **Pohon (Tree)** | Satu grup: 1 UTAMA + semua sub-session turunannya. Punya `treeId`. |
| **UTAMA (Root)** | Session akar sebuah pohon; dibuat dari drag folder. `parentId = null`. |
| **PENDUKUNG (Sub)** | Session anak yang di-spawn UTAMA (atau sub lain) dalam pohon yang sama. |
| **Papan Tulis (Board)** | DB SQLite di disk. Semua session menulis summary/todo/progress ke sini; semua bisa membaca. |
| **Isolasi Pohon** | Session hanya boleh berinteraksi langsung dalam pohonnya sendiri; lintas-pohon hanya lewat Papan Tulis. |

---

## 3. Model Session & Aturan Isolasi

```
POHON A                         POHON B                    ┌── Papan Tulis (SQLite) ──┐
 UTAMA-A ──┬── SUB-A1            UTAMA-B ── SUB-B1          │ sessions  (registry)     │
           └── SUB-A2                                       │ board     (summary/todo/ │
   ▲  full context share ▲          ▲ full share ▲         │            progress)     │
   └──────────────────────┘         └────────────┘         │ messages  (antar-session)│
                                                            └──────────────────────────┘
  A dan B TIDAK bisa akses langsung   ───►  hanya boleh: read_board + send_message  ◄───
```

**Aturan (di-enforce di layer MCP tool, bukan hanya UI):**

| Aksi | Dalam pohon sama | Lintas pohon |
|---|---|---|
| `spawn_worker` (bikin sub) | ✅ (jadi anak pemanggil) | ❌ tidak relevan |
| `send_message` ke session tertentu | ✅ | ✅ (hanya pesan; bukan akses konteks) |
| `read_board` (lihat semua summary/todo/progress) | ✅ | ✅ |
| baca transkrip / lanjutkan kerjaan session lain | ✅ (dalam pohon) | ❌ **ditolak tool** |
| `report_progress` / `update_todo` / `update_summary` | ✅ nulis punya sendiri | ✅ nulis punya sendiri |

Enforcement: setiap tool handler tahu `callerSessionId`. Untuk aksi yang butuh target session, handler cek `sameTree(caller, target)`; kalau beda pohon dan aksinya bukan `send_message`/`read_board`, kembalikan `isError`.

---

## 4. Komponen Sistem

```
┌──────────────────────────── Electron ────────────────────────────┐
│  MAIN process (Node)                     RENDERER (UI, sandboxed)  │
│  ┌────────────────────────────┐          ┌─────────────────────┐  │
│  │ Orchestrator               │   IPC    │ SessionTreePanel    │  │
│  │  • SessionManager          │◄────────►│ ChatPanel (switch)  │  │
│  │  • Session (per query())   │  (preload │ BoardPanel          │  │
│  │  • MCP tools (in-process)  │  bridge)  │ ContextBadge (%)    │  │
│  │  • Board DB (sql.js→disk)  │          └─────────────────────┘  │
│  └─────────────┬──────────────┘                                   │
│                │ @anthropic-ai/claude-agent-sdk                    │
│         query() × N  ──► spawns `claude` CLI subprocess each       │
└───────────────────────────────────────────────────────────────────┘
```

- **Renderer** murni presentasi; tidak menyentuh SDK/DB langsung (contextIsolation ON, nodeIntegration OFF). Semua lewat `window.grove.*` yang dibuka `preload`.
- **Main** memegang orchestrator, DB, dan semua `query()`.

---

## 5. Skema Papan Tulis (SQLite)

```sql
-- Registry semua session (semua pohon)
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,      -- id internal Grove (bukan session_id SDK)
  sdk_session_id TEXT,                -- session_id dari SDK (untuk resume)
  tree_id      TEXT NOT NULL,
  parent_id    TEXT,                  -- NULL untuk UTAMA
  role         TEXT NOT NULL,         -- 'root' | 'sub'
  title        TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  model        TEXT,
  status       TEXT NOT NULL,         -- 'idle'|'running'|'waiting'|'done'|'error'
  ctx_input    INTEGER DEFAULT 0,     -- akumulasi token input terakhir
  ctx_output   INTEGER DEFAULT 0,
  ctx_window   INTEGER DEFAULT 200000,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Ringkasan/todo/progress "lagi ngerjain apa" — 1 baris per session
CREATE TABLE board (
  session_id   TEXT PRIMARY KEY REFERENCES sessions(id),
  summary      TEXT DEFAULT '',       -- ringkasan tujuan/hasil session
  todo         TEXT DEFAULT '[]',     -- JSON array {text,done}
  progress     TEXT DEFAULT '',       -- kalimat "sedang mengerjakan X"
  updated_at   INTEGER NOT NULL
);

-- Pesan antar-session (bulletin/DM) — boleh lintas pohon
CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session TEXT NOT NULL,
  to_session   TEXT,                  -- NULL = broadcast ke semua
  body         TEXT NOT NULL,
  read_flag    INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL
);
```

Persistensi: sql.js menyimpan DB in-memory; setiap mutasi → `db.export()` ditulis ke
`<userData>/grove.sqlite` (debounce ~250 ms). Ini nol dependensi native → `npm install` mulus.
(Migrasi ke `better-sqlite3` bila perlu throughput lebih tinggi nanti.)

---

## 6. Protokol MCP Tools (in-process, diberikan ke tiap session)

Dibuat via `createSdkMcpServer({ name:'grove', tools:[...] })`, dipasang lewat
`options.mcpServers` + di-allow lewat `allowedTools: ['mcp__grove__*']`. Tiap handler
menerima `callerSessionId` lewat closure (satu server instance per session).

| Tool | Input (zod) | Efek | Isolasi |
|---|---|---|---|
| `spawn_worker` | `{ title, task, model? }` | Bikin sub-session (anak pemanggil) di pohon yang sama; register + mulai `query()`. | Selalu jadi anak caller |
| `update_summary` | `{ summary }` | Tulis `board.summary` milik caller. | Milik sendiri |
| `update_todo` | `{ items: {text,done}[] }` | Ganti `board.todo` caller. | Milik sendiri |
| `report_progress` | `{ progress }` | Set `board.progress` caller + status. | Milik sendiri |
| `read_board` | `{ scope?: 'tree'\|'all' }` | Baca summary/todo/progress semua session (default all). | Read-only, boleh lintas pohon |
| `send_message` | `{ to?, body }` | Kirim pesan; `to` opsional (broadcast). | Boleh lintas pohon |
| `read_messages` | `{ unread_only? }` | Ambil pesan yang ditujukan ke caller (+broadcast). | Milik sendiri |
| `list_workers` | `{}` | Daftar session dalam pohon caller (untuk koordinasi). | Hanya pohonnya |

Semua tool juga meng-emit event ke renderer (via IPC) agar UI update real-time.

---

## 7. Perhitungan % Context

Dari pesan `assistant` SDK: `message.message.usage` = `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`.
Context terpakai ≈ **token input pada turn terakhir** (itu isi window saat ini), bukan akumulasi seluruh sesi.

```
ctxUsed  = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
percent  = clamp( ctxUsed / ctxWindow * 100, 0, 100 )
```

`ctxWindow` per model (dibuat konfigurabel; default 200k, Opus [1m] = 1_000_000).
Badge di UI: `UTAMA-A · a1b2  [34%]` — warna hijau <60%, kuning <85%, merah ≥85%.

---

## 8. Integrasi Agent SDK (keputusan)

- **query()** dijalankan dengan `options.includePartialMessages = true` untuk streaming teks ke chat.
- **Multi-turn**: tiap session dibuka dengan `prompt` berupa `AsyncIterable` (streaming input) supaya
  user bisa kirim pesan lanjutan ke session yang sudah jalan (lewat kolom chat).
- **Sub-session** = **`query()` independen** yang di-spawn dari handler `spawn_worker` (bukan Task tool
  bawaan) → tiap sub jadi node pohon sendiri dengan session_id, token %, dan chat sendiri. (Guide SDK:
  ini cara yang tepat untuk visibilitas per-node.)
- **permissionMode**: default `bypassPermissions` (sesuai `claudeee.bat` user) **atau** `canUseTool`
  callback untuk kebijakan aman headless — dibuat opsi di Konfigurasi.
- **hooks**: `PreToolUse`/`PostToolUse` dipakai untuk feed panel aktivitas/log per session.
- **Auth**: default pakai kredensial login Claude Code yang sudah ada (subscription); `ANTHROPIC_API_KEY`
  opsional sebagai override. **Diverifikasi saat build.**
- **Concurrency**: banyak `query()` paralel di satu proses Node OK; jaga FD/rate-limit; sediakan
  `p-limit` bila perlu batasi worker aktif.

## 9. Alur Data / IPC (`window.grove`)

Renderer → Main (invoke): `dropFolder(path)`, `sendChat(sessionId, text)`, `selectSession(id)`,
`stopSession(id)`, `getTree()`, `getBoard()`.
Main → Renderer (event): `session:new`, `session:update` (status/ctx%), `chat:delta`,
`board:update`, `message:new`.

## 10. Struktur Folder

```
Addon AI MCP/
├─ docs/ARCHITECTURE.md
├─ package.json · tsconfig*.json · electron.vite.config.ts
├─ src/
│  ├─ shared/types.ts            # tipe dipakai bersama
│  ├─ main/
│  │  ├─ index.ts                # bootstrap app + window
│  │  ├─ ipc.ts                  # handler IPC
│  │  ├─ orchestrator/
│  │  │  ├─ SessionManager.ts    # pohon, spawn, isolasi
│  │  │  ├─ Session.ts           # bungkus 1 query(): streaming, token, chat
│  │  │  ├─ mcpTools.ts          # createSdkMcpServer + tools
│  │  │  ├─ db.ts                # sql.js + persist ke disk
│  │  │  └─ contextWindows.ts    # model → ukuran window
│  ├─ preload/index.ts           # contextBridge → window.grove
│  └─ renderer/
│     ├─ index.html · main.ts · styles.css
│     └─ panels/ (tree, chat, board, badge)
```

## 11. UI/UX

- **Sidebar kiri**: UTAMA / PENDUKUNG (tree). Double-click node → set session aktif.
- **Tengah**: ChatPanel session aktif (streaming), input kirim pesan lanjutan.
- **Kanan/bawah**: BoardPanel (summary/todo/progress semua session) + inbox pesan.
- **Header node**: `title · idPendek [ctx%]` dengan warna status.
- Tema gelap: latar `#0b1220`, aksen biru siano (`#38bdf8`), mirip DanaZ Universal.

## 12. Roadmap (milestone)

1. **M1 — Skeleton jalan (fokus sekarang):** scaffold Electron+TS; drag folder → spawn UTAMA;
   chat streaming; DB papan tulis; MCP tools inti (`report_progress`, `update_summary`, `read_board`,
   `send_message`); pohon di sidebar; badge % context.
2. **M2 — Sub-session:** `spawn_worker` + render pohon berakar + isolasi lintas-pohon.
3. **M3 — Multi-turn chat** ke session berjalan + inbox pesan + panel aktivitas (hooks).
4. **M4 — Persistensi & resume**, Konfigurasi (model, permissionMode, auth), Monitoring/Log tabs.
5. **M5 — Poles UI** sesuai gaya DanaZ (tabs Dashboard/Console/Monitoring/Log), theming final.

## 13. Risiko & Keputusan

- **Auth SDK** (subscription vs API key) → verifikasi awal saat build; sediakan kedua jalur.
- **Native deps** → pakai sql.js (WASM) agar `npm install` bebas kompilasi.
- **Isolasi** ditegakkan di tool layer + dicek ulang di SessionManager (defense in depth).
- **% context** definisi "input turn terakhir" dipilih karena paling mencerminkan isi window nyata.
```

