# Grove — Review adversarial 2 changeset (cross-topic FIX + yellowblink FIX)

Tanggal: 2026-07-20. Metode: baca KODE AKTUAL (Session.ts, SessionManager.ts, db.ts, mcpTools.ts),
telusuri jalur runtime, cari bug korektnes nyata. Hasil verifikasi akhir: `npx tsc --noEmit -p tsconfig.json`
**exit 0** + `npm run build` **exit 0**. App TIDAK di-restart.

## Ringkasan
- **1 BUG CONFIRMED** (risk C) → sudah di-FIX (minimal, di `consume()`).
- Risk A, B, D, E: **bersih** (tak ada bug korektnes).

---

## C) CONFIRMED BUG — `consume().finally` meng-clobber state query yang baru di-restart

### Gejala
Setelah `assign_worker` (default fresh) me-reuse worker yang query-nya masih hidup, state sesi korup:
pesan berikutnya men-spawn **query DUPLIKAT (zombie subprocess claude.exe)** + interleaving, teks handoff
turn baru bisa ke-wipe, tombol Stop tak menjangkau turn yang berjalan, dan status idle sesaat yang palsu.

### Akar masalah (deterministik, bukan race langka)
1. `SessionManager.assignToWorker` (SessionManager.ts:120-121): `worker.resetForNewTask()` lalu
   `worker.sendUserMessage(task)` — **sinkron, back-to-back, tanpa await**.
2. `resetForNewTask` (Session.ts:452-481): query long-lived lama MASIH hidup (parkir antar-turn, lihat
   komentar `resetConsumers` Session.ts:284-290). Ia `const q=this.q; this.q=null; void q.interrupt()`
   (async — loop belum berakhir saat itu juga).
3. `sendUserMessage → start()` (Session.ts:516 → 363-399): set `this.q = q_baru`, `this.started = true`,
   `void this.consume()`.
4. Interrupt async selesai BELAKANGAN → loop query LAMA berakhir → `consume().finally` (Session.ts:626-645
   versi lama) jalan TANPA syarat: `this.started=false; this.q=null; turnText=''` → **meng-clobber
   q_baru**. Karena interrupt async, finally lama dijamin jalan SESUDAH start() → clobber deterministik
   tiap reuse yang sehat.

Konsekuensi lanjutan: `this.started=false` → `sendUserMessage` berikutnya (`if(!this.started) this.start()`)
membuat query kedua sementara q_baru masih hidup (parkir) → duplikat + `resetConsumers()` menjadikan q_baru
zombie yang tak pernah dapat input/berakhir.

### Fix (Session.ts:606-651, method `consume()`)
Tangkap `const myQ = this.q` di awal loop; bungkus SELURUH isi `finally` dengan `if (this.q === myQ)`.
Jadi reset state HANYA terjadi bila query yang berakhir MASIH query aktif sesi. Bila `this.q` sudah diganti
(reset/compact/ganti-akun + start baru), finally query lama tak menyentuh state q_baru.

Aman untuk semua jalur lain (diverifikasi manual):
- **Turn normal / error biasa / interruptTurn / stop**: tak ada penggantian this.q → `this.q===myQ` true →
  perilaku identik dgn sebelumnya (termasuk handler limit & apiBlock, dan recycle handleApiBlock yang
  memang dipanggil dari dalam finally saat this.q masih === myQ).
- **applyAccountChange / compactWith**: keduanya SUDAH set `started=false` + `this.q=null` sendiri; finally
  lama-nya kini di-skip (this.q null/q_baru ≠ myQ) → tak ada efek hilang (flag limit/apiBlock false di jalur
  ini). Bahkan jadi lebih aman (tak meng-clobber bila keburu ada start() baru).
- **resetForNewTask + start (kasus bug)**: finally query lama skip → q_baru utuh. FIXED.

---

## A) UN-BLINK benar-benar EMIT — PASS
Semua clear memanggil setter `setAwaitingInput(false)` (Session.ts:715-720) yang **emit** `session:update`,
bukan assign field mentah:
- `beginTurn()` Session.ts:500 (choke-point semua kerja baru: sendUserMessage/injectAutoTask/autoCheck/
  autoResume/recycle) ✓
- `interruptTurn()` :785 ✓ · `stop()` :588 ✓ · `resetForNewTask()` :455 ✓
Tak ada assignment `this.awaitingInput=false` liar; satu-satunya mutasi ada di dalam setter. Renderer
`updateNodeVisual` toggle `.awaiting-input` dari payload → kartu benar-benar berhenti kedip. **Tak nyangkut.**

## B) SET awaitingInput — PASS
Kondisi di `handle('result')` (Session.ts:943-949): `cleanEnd && !this.inbox.hasPending() &&
looksLikeAwaitingInput(this.turnText || this.lastAssistantText)`.
- `turnText` = akumulasi seluruh blok teks asisten turn ini (Session.ts:867), dibaca SEBELUM di-reset
  (reset di :956, sesudah cek + notifyTurnEnd). ✓ Final, bukan parsial/kosong.
- `hasPending()` (Session.ts:305-308) = `queue.length > 0`; `!hasPending()` = antrian benar-benar kosong. ✓
- Fallback `|| lastAssistantText`; bila keduanya kosong (turn semua tool tanpa teks) → false → tak kedip. ✓
- Risiko false-pos/neg: heuristik penutup (≤2 baris) + allowlist ketat — hanya berdampak kosmetik (kedip
  ekstra), bukan korektnes. Aman.

## D) Broadcast read PER-PENERIMA — PASS
- Skema `message_reads(message_id, session_id, PK(message_id,session_id))` (db.ts:45-49). ✓
- `getMessagesFor` (db.ts:337-348): `WHERE (to_session=? OR to_session IS NULL) AND NOT EXISTS(... r.message_id=messages.id AND r.session_id=?)`
  param `[id,id]`. Pesan tertarget (`to_session=?`) tetap jalan; broadcast di-suplai sampai SESI INI membacanya.
  Per-penerima. ✓
- `markReadFor` (db.ts:355-362): `INSERT OR IGNORE` message_reads (per-penerima) + set `read_flag=1` global
  (indikator panel UI). `read_flag` global TIDAK memengaruhi `NOT EXISTS` → sibling lain tetap dapat. ✓
- `SessionManager.readMessages` (SessionManager.ts:797-808): filter sepohon lalu `markReadFor(sessionId,
  msgs.map(id))` untuk SEMUA yang dikembalikan (bukan filter `!m.read` global lama). ✓ Tak ada pesan hilang/dobel.
- `deleteSession` (db.ts:187-199): hapus `message_reads` milik sesi + untuk message yg akan dihapus,
  SEBELUM baris `messages` dihapus → tak ada orphan. ✓

## E) Regresi umum — PASS
- Turn biasa non-pertanyaan → `looksLikeAwaitingInput` false → tetap idle biasa (tak kedip). ✓
- `apiStopped` (setApiStopped emit) tak tersentuh; pola `awaitingInput` sejajar, tak bertabrakan. ✓
- Handoff `notifyTurnEnd` + auto-report tetap jalan (SET awaitingInput tak mengubah alurnya). ✓
- `resetForNewTask` mint session baru BENAR: `meta.sdkSessionId=undefined` (Session.ts:457) di-baca
  `start()` saat query dibuat (`resume: this.meta.sdkSessionId`, Session.ts:394) — nilai TERKINI (undefined),
  bukan capture lama → SDK mint session_id baru tanpa transkrip lama. ✓ (dgn fix C, state pasca-restart
  tak lagi ter-clobber.)

---

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**.
- `npm run build` → **exit 0** (main 101.76 kB, preload 2.10 kB, renderer css 19.83 kB / js 38.27 kB).
- Tidak menjalankan dev/start/dist/restart (sesi live aman).

## File diubah
- `src/main/orchestrator/Session.ts` — `consume()` (guard `this.q === myQ` di `finally`). 1 method, ~6 baris efektif.
