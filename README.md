# Grove — Multi-Agent Claude Orchestrator

GUI desktop (Electron + TypeScript) untuk mengorkestrasi banyak session Claude Code paralel.
Drag folder proyek → spawn session **UTAMA** (root). UTAMA bisa spawn **sub-worker** otomatis
(membentuk pohon). Banyak pohon jalan bersamaan, terisolasi, tapi berbagi satu **Papan Tulis**
(SQLite) untuk summary/todo/progress + pesan antar-session.

Arsitektur lengkap: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Prasyarat
- Node.js ≥ 20, npm
- **Claude Code sudah login** (SDK memakai kredensial login-mu; tidak perlu `ANTHROPIC_API_KEY`).

## Jalankan dari source (dev)
```bash
npm install       # sekali saja
npm run dev        # jalankan Grove (HMR)
```
Atau double-click **`run-dev.bat`** (otomatis install dep bila belum ada, lalu jalan).

Jika binary Electron gagal ter-download saat `npm install`, picu manual:
```bash
node node_modules/electron/install.js
```

## Build .exe siap pakai
```bash
npm run dist        # installer NSIS + portable (folder release/)
# atau, tanpa installer (folder aplikasi langsung):
npm run dist:dir    # hasil di release/win-unpacked/Grove.exe
```
Hasil `npm run dist` ada di folder **`release/`**:
- **`Grove-0.1.0-x64.exe`** (NSIS installer — double-click untuk pasang; bisa pilih folder, ada shortcut desktop).
- **`Grove-0.1.0-x64.exe`** portable (jalan tanpa install) — nama artefak dibedakan otomatis.

Catatan penting untuk exe:
- Mesin target **harus punya Node.js** (SDK men-spawn Claude CLI via Node) dan **Claude Code sudah login** (auth dari `~/.claude`).
- `@anthropic-ai/claude-agent-sdk` & `sql.js` sengaja **di-asarUnpack** agar subprocess & WASM bisa diakses dari paket.
- Single-instance lock aktif di build terpaket: buka Grove lagi → fokus ke window yang sudah ada.

## Cara pakai
1. Jalankan app → **drag-drop folder proyek** ke jendela → muncul session **UTAMA**.
2. Ketik tugas di kolom chat → Claude mulai bekerja; ia melapor ke Papan Tulis dan
   bisa `spawn_worker` untuk sub-tugas paralel (muncul sebagai anak di sidebar).
3. **Double-click** node di sidebar untuk berpindah session (kolom chat ikut berganti).
4. Badge `%` di tiap node = context terpakai (hijau <60, kuning <85, merah ≥85).

## Aturan isolasi
- **Dalam 1 pohon** (UTAMA ↔ sub): berbagi konteks penuh.
- **Antar pohon**: tidak boleh saling mengerjakan; hanya boleh `read_board` (baca status semua)
  dan `send_message` (koordinasi). Ditegakkan di layer MCP tool.

## Status
- [x] M1 — skeleton jalan: drag-drop → spawn UTAMA, chat streaming, Papan Tulis SQLite,
      MCP tools inti, pohon di sidebar, badge % context.
- [x] M2 (inti) — `spawn_worker` + pohon berakar + isolasi lintas-pohon.
- [x] M3 (inti) — chat multi-turn ke session berjalan + inbox pesan.
- [ ] M4 — resume session, tab Konfigurasi/Monitoring/Log, packaging.
- [ ] M5 — poles UI penuh gaya DanaZ (tabs, dsb).

## Struktur
```
src/
  shared/types.ts              # tipe bersama main ↔ renderer
  main/
    index.ts · ipc.ts
    orchestrator/
      SessionManager.ts        # pohon, spawn, isolasi (GroveHost)
      Session.ts               # 1 query(): streaming, token, chat
      mcpTools.ts              # createSdkMcpServer + 8 tools
      db.ts                    # sql.js → disk (Papan Tulis)
      contextWindows.ts        # model → ukuran window
  preload/index.ts             # contextBridge → window.grove
  renderer/                    # index.html · main.ts · styles.css
```
