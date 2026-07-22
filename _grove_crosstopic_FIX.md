# Grove — Changelog fix cross-topic worker

Tanggal: 2026-07-20. Semua perubahan di `src/main/orchestrator/`. Referensi akar masalah:
`_grove_crosstopic_A.md` (jalur pembentukan context) + `_grove_crosstopic_B.md` (jalur injeksi).

Verifikasi: **`npx tsc --noEmit` → PASS (exit 0)**, **`npm run build` (electron-vite) → PASS (exit 0)**.
App TIDAK di-restart (hanya compile; bukan dev/start/dist).

---

## FIX #1 (PRIMER) — context BERSIH saat reuse worker

Penyebab utama: `assign_worker` me-reuse worker lama dan hanya push tugas baru ke inbox dari
`query()` streaming yang SAMA → transkrip topik lama ikut → worker nyambung/campur topik sibling.

- **Session.ts:276** `AsyncMessageQueue.clearQueue()` — method baru: buang pesan yang masih
  ter-antri (beda dari `resetConsumers()` yang sengaja membiarkan queue utuh).
- **Session.ts:421** `Session.resetForNewTask()` — method baru: (a) `interrupt` query long-lived
  lama, (b) `meta.sdkSessionId = undefined` + `db.upsertSession` → `start()` berikutnya
  `resume: undefined` (mint session_id baru, tanpa transkrip lama), (c) `resetCtx()` → ctx% ke 0,
  reset guard compact, `inbox.clearQueue()`, `toolRows.clear()`, `history.length=0`, (d) TIDAK
  menghapus row/id/title (slot & UI dipakai ulang). Menulis nota system boundary ke chat.
  Interrupt di dalamnya juga jadi anti-interleave bila worker masih `running`.
- **SessionManager.ts:111** `assignToWorker(callerId, workerId, task, opts?: {fresh?})` — tambah
  param `opts`. **SessionManager.ts:120**: `fresh` DEFAULT TRUE → panggil `worker.resetForNewTask()`
  sebelum `sendUserMessage(task)`; `fresh=false` (lanjutan) = perilaku lama (pertahankan konteks).
- **mcpTools.ts:12** signature `GroveHost.assignToWorker` ditambah `opts?: {fresh?: boolean}`.
- **mcpTools.ts:73-91** tool `assign_worker`: param baru `continuation: boolean = false`;
  memanggil `host.assignToWorker(id, task, { fresh: !continuation })`. Deskripsi: default = konteks
  BERSIH & independen; `continuation:true` HANYA untuk melanjutkan topik yang SAMA.

Keputusan desain: hardening "interrupt worker running sebelum assign" ditangani oleh interrupt di
`resetForNewTask()` (jalur default fresh). Untuk `continuation:false`… maksudnya fresh selalu
interrupt. Untuk `continuation:true` (lanjutan), tugas baru cukup mengantri di inbox dan diproses
setelah turn berjalan selesai (sekuensial, bukan interleave) — tak perlu interrupt paksa yang
berisiko race dengan consume().finally.

## FIX #2 — perketat prompt reuse

- **Session.ts:61-64** `GROVE_ROOT`: ganti dorongan buta "REUSE workers... keeps its full prior
  context" jadi aturan pencocokan: CONTINUATION topik sama → `assign_worker continuation:true`;
  topik BARU tak-berhubungan → `spawn_worker` ATAU `assign_worker` default (konteks bersih).
  Tambah "task harus self-contained & tak menyebut topik worker lain".
- **Session.ts:76** `GROVE_SUB`: ganti "your prior context is kept, so build on it" jadi kondisional
  (lanjutan → bawa konteks; tugas baru → konteks di-reset, kerjakan mandiri).
- **mcpTools.ts:73** deskripsi tool `assign_worker` diselaraskan (lihat FIX #1).

## FIX #3 — read_board view ringkas untuk caller SUB

Penyebab jalur SOFT (B): worker memanggil `read_board(tree)` dan menerima summary/todo/progress
sibling verbatim tanpa framing → bisa "mengadopsi" topik sibling.

- **SessionManager.ts:762,777** `readBoard()`: bila `caller.role === 'sub'`, entri sesi LAIN
  (bukan sesi caller sendiri) dikembalikan RINGKAS — `summary` diganti penanda
  `"(sesi lain — awareness saja, BUKAN tugasmu)"`, `todo=[]`, `progress=''`. Entri worker SENDIRI
  tetap penuh; caller ROOT tetap dapat board penuh. Bentuk return type tak berubah.
- **mcpTools.ts:169** deskripsi `read_board`: tambah catatan sub-worker hanya lihat status/percent
  sesi lain.

## FIX #4 — broadcast read_flag PER-PENERIMA (korektnes)

Bug: `read_flag` global per pesan → broadcast (to_session IS NULL) yang dibaca SATU sibling
ter-mark read untuk SEMUA → sibling lain kehilangan pesan (`unread_only=true`).

- **db.ts:45-49** SCHEMA: tabel baru `message_reads(message_id, session_id, PK(message_id,session_id))`.
  Aman utk DB lama (CREATE TABLE IF NOT EXISTS dijalankan tiap init).
- **db.ts:340-349** `getMessagesFor(id, unreadOnly)`: filter unread pakai
  `NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id=messages.id AND r.session_id=?)`
  (per-penerima), bukan `read_flag=0` global.
- **db.ts:355-362** `markReadFor(sessionId, ids)` — GANTI `markRead(ids)`: INSERT OR IGNORE ke
  `message_reads` (per-penerima) + tetap set `read_flag=1` global (indikator panel pesan UI).
- **db.ts:189-193** `deleteSession`: bersihkan `message_reads` (milik sesi + pesan yg dihapus)
  SEBELUM baris messages dihapus.
- **SessionManager.ts:806** `readMessages`: `db.markReadFor(sessionId, msgs.map(m=>m.id))` untuk
  SEMUA pesan yang dikembalikan (bukan filter `!m.read` global lama).

Pesan tertarget (`to_session=?`) tetap jalan; `getAllMessages()`/UI tak berubah (masih baca
`read_flag` global).

---

## Ringkas verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0** (tak ada type error).
- `npm run build` → **exit 0** (main 100.06 kB, preload 2.10 kB, renderer OK).
- Tidak menjalankan dev/start/dist/restart (sesi live tetap aman).
