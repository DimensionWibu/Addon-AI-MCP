# Grove — Root-cause "sub-worker kebawa topik sibling" (Jalur B: injeksi konten ke giliran worker)

Ruang lingkup: jalur INJEKSI konten ke context giliran worker — board / message / auto-ping / context window.
File dibaca menyeluruh: `mcpTools.ts`, `contextWindows.ts`, `Session.ts`, `db.ts`, `SessionManager.ts`.

---

## TL;DR (root cause)

Tidak ada auto-injeksi ringkasan board sibling ke worker. Ringkasan board **se-pohon** (berisi semua sibling)
HANYA disuntik ke ROOT. Jadi "sub kebawa topik sibling" TIDAK datang dari auto-ping.

Root cause paling kuat (HARD): **`assign_worker` me-reuse worker lama, dan `Session.start()` melakukan
`resume` konteks SDK penuh milik topik SEBELUMNYA** — tanpa reset konteks / tanpa batas topik. Prompt ROOT
(`GROVE_ROOT`) aktif menyuruh orchestrator me-REUSE worker idle lintas tugas. Akibatnya worker "sub-1" yang dulu
mengerjakan topik A di-assign topik B, lalu **menyambung/menggabung topik A ke B**. Dari sisi user tampak
sebagai "sub baru nyambung ke topik sub-1 yang lain".

Jalur kedua (SOFT, pull-based): worker memanggil sendiri `read_board` (default scope `tree`) atau `read_messages`
(broadcast sibling). Keduanya mengembalikan **summary/todo/progress sibling secara verbatim tanpa framing
"ini tugas sesi LAIN, bukan tugasmu"**. System prompt malah menganjurkan worker memakai tool ini untuk "awareness".

---

## Jawaban pertanyaan konkret

### Q1 — Apa PERSIS yang diinjeksi ke context worker tiap giliran? Apakah board sibling ikut masuk?

Context giliran worker = **percakapan SDK miliknya sendiri (di-`resume`)** + apa pun yang di-`push` ke inbox-nya
giliran itu. `inbox` per-Session (Session.ts:283), tidak dibagi antar sesi.

Semua titik yang mendorong isi ke inbox sebuah worker (hasil grep, sudah lengkap):

| Sumber | file:line | Isi | Bocor sibling? |
|---|---|---|---|
| Task awal spawn | Session.ts:355 / SessionManager.ts:131 | `opts.task` dari parent | Hanya bila parent menulis topik sibling di teks task |
| Assign ulang | SessionManager.ts:116 (`worker.sendUserMessage(task)`) | task baru dari parent | **Konteks SDK LAMA ikut via resume** (lihat Q-rootcause) |
| Ganti akun (usage) | SessionManager.ts:289 | teks tetap "[GROVE] Akun dipindah…" | Tidak |
| Kena limit | SessionManager.ts:333 | teks tetap "[GROVE] Akun sebelumnya kena limit…" | Tidak |
| autoResume | Session.ts:485 + 479 (`getBoardEntry(this.meta.id)`) | board **milik sendiri** | Tidak |
| Hasil anak (child→parent) | SessionManager.ts:691 (`parent.injectAutoTask(note)`) | hasil worker ANAK-nya | Tidak (arah anak→parent, di-cek se-pohon di :649) |
| Chat manual user | SessionManager.ts:372 | teks user | Tidak |

Ringkasan board se-pohon `treeBoardSummary()` (SessionManager.ts:695-708) — yang MEMUAT semua sibling —
hanya dipakai di dua tempat, **keduanya root-only**:
- `scheduleRootStatus` → `root.injectAutoTask(rootStatusPrompt)` (SessionManager.ts:740), dijaga `role==='root'` di :728.
- `runLoopCheck` → `root.autoCheck(loopCheckPrompt)` (SessionManager.ts:528), dijaga `role==='root'` di :505.

**Kesimpulan Q1: summary/todo/progress sibling TIDAK di-inject otomatis ke worker.** Worker hanya melihat konten
sibling bila (a) reuse membawa konteks topik lama miliknya sendiri, atau (b) worker sendiri memanggil
read_board / read_messages.

### Q2 — Auto-ping "[GROVE AUTO]" / "[GROVE AUTO-CHECK]": isinya + tujuannya

Dibangun di `rootStatusPrompt` (SessionManager.ts:710-712) dan `loopCheckPrompt` (:714-716). **Ya, body-nya berisi
`treeBoardSummary` = ringkasan SEMUA sesi se-pohon (termasuk sibling).** TAPI hanya dikirim ke **ROOT**
(guard `role==='root'` di :728 dan :505). Worker TIDAK pernah menerimanya.

**Kesimpulan Q2: worker tidak bisa salah memperlakukan ringkasan all-tree sebagai tugasnya — karena worker
tak pernah dikirimi auto-ping itu.** (Auto-ping bukan penyebab bug ini.)

### Q3 — send_message / read_messages: isolasi benar?

- Kirim ke target spesifik (`to` diisi): **di-cek se-pohon saat kirim** (SessionManager.ts:771-779) → tak bisa lintas pohon. OK.
- Broadcast (`to` dikosongkan): **TIDAK ada cek saat kirim**, tapi `readMessages` memfilter `treeOf.get(m.from) === myTree`
  (SessionManager.ts:784-793) → broadcast lintas-pohon terblokir saat baca. OK.
- **DALAM satu pohon: broadcast sibling A memang sampai ke sibling B** (by design "broadcast ke pohonmu"). Ini satu-satunya
  kanal keras di mana pesan sibling mencapai sibling lain — tapi butuh B memanggil `read_messages`, dan itu nota koordinasi
  yang disengaja. `reportToParent`/`autoReportFinal` mengirim TERTARGET ke parent (`to=parentId`), bukan broadcast, jadi
  tak bocor ke sibling.
- **BUG korektnes (bukan penyebab cross-topic, tapi nyata):** `read_flag` adalah satu kolom GLOBAL per pesan
  (db.ts:35-42), `markRead` menandai global (db.ts:334-337). Broadcast yang dibaca SATU sibling langsung ter-mark read
  untuk SEMUA. Dengan `unread_only=true` (default), hanya sibling pertama yang membaca broadcast; sibling lain kehilangan
  pesan itu. Efeknya PESAN HILANG, bukan cross-topic.

### Q4 — read_board: default scope + auto-inject?

- Default scope = **`tree`** (mcpTools.ts:163).
- `readBoard(scope='tree')` mengembalikan **semua baris board sibling** untuk pohon caller, **lengkap dengan
  summary + todo + progress** (SessionManager.ts:758-768). Tidak ada pembedaan role: worker pun menerima summary/todo/progress
  penuh milik semua sibling.
- **Tidak auto-inject** — worker harus memanggil sendiri. TAPI system prompt (`GROVE_COMMON`, Session.ts:50) menganjurkan
  worker memakai read_board untuk "awareness", dan hasilnya **tanpa framing "ini tugas sesi lain, jangan diambil".**
  Worker dengan task sendiri yang tipis/ambigu bisa "mengadopsi" topik sibling yang deskripsinya lebih kaya.

---

## Mekanisme PERSIS penyebab (ranking)

### #1 (HARD, paling mungkin) — reuse worker membawa konteks topik lama via `resume`
- `assignToWorker` (SessionManager.ts:108-117) → `worker.sendUserMessage(task)`.
- `sendUserMessage` → `if(!this.started) this.start()` (Session.ts:434).
- `start()` membuat query dengan **`resume: this.meta.sdkSessionId`** (Session.ts:352) = **seluruh transcript topik
  SEBELUMNYA** ikut. Tidak ada reset konteks, tidak ada pembatas "tugas baru, lupakan topik lama".
- `GROVE_ROOT` (Session.ts:61) menekan orchestrator: *"REUSE workers before creating new ones… Only spawn when there
  is no suitable idle worker."* → orchestrator rutin memberi topik-B ke worker yang konteksnya penuh topik-A.
- Jika orchestrator (yang board-view-nya menggabung semua sibling) salah pilih worker idle mana yang di-assign, worker
  "sub-1 (topik A)" dapat tugas B → **model menyambung A ke B**. Persis gejala "sub baru nyambung ke topik sub-1 lain".

### #2 (SOFT, pull-based) — read_board(tree)/read_messages tanpa framing kepemilikan
- read_board default `tree` mengembalikan summary/todo/progress sibling verbatim (SessionManager.ts:758-768).
- read_messages mengembalikan broadcast sibling (SessionManager.ts:784-793).
- System prompt menganjurkan pemakaiannya; tidak ada penanda "punya sesi lain". Worker bisa mengadopsi topik sibling.

---

## Usulan fix (ringkas — belum diterapkan)

**Fix #1 (utama, cross-topic saat reuse):**
- Di `assignToWorker`, sisipkan **banner batas topik keras** di depan task saat reuse, mis:
  `=== TUGAS BARU & INDEPENDEN. Abaikan seluruh topik/percakapan sebelumnya di sesi ini; itu penugasan berbeda. ===\n` + task.
  (Cara termurah, tetap mempertahankan reuse murah.)
- ATAU sediakan opsi "reuse-fresh": set `meta.sdkSessionId = undefined` sebelum start pada assign untuk topik yang TIDAK
  berkaitan (kehilangan konteks lama, tapi bersih). Idealnya root memilih: lanjutan topik → reuse-with-context; topik baru → reuse-fresh/spawn.
- Perketat `GROVE_ROOT`: reuse HANYA untuk melanjutkan topik yang SAMA; untuk topik tak berkaitan, spawn worker baru
  (atau reuse-fresh). Tegaskan task antar-worker harus self-contained dan tak menyebut topik worker lain.

**Fix #2 (read_board sibling framing untuk SUB):**
- Untuk caller ber-role `sub`, `readBoard` sebaiknya mengembalikan **view ringkas** (title/role/status/percent saja),
  BUKAN summary/todo/progress penuh sibling; atau bungkus hasil dengan catatan tegas
  "Ini tugas sesi LAIN — hanya untuk awareness, JANGAN dikerjakan. Tugasmu hanya yang di-assign parent." (mcpTools.ts:160-168 / SessionManager.ts:751-769).

**Fix #3 (bug read_flag global broadcast — korektnes, opsional):**
- `read_flag` per-pesan global membuat broadcast hanya bisa dibaca satu penerima. Ganti ke pelacakan read per-penerima
  (tabel `message_reads(message_id, session_id)`), atau jangan mark-read broadcast (db.ts:35-42, 324-337; SessionManager.ts:784-793).

---

## Catatan verifikasi
- Semua call-site injeksi inbox sudah dipetakan via grep (tabel Q1); dua injeksi ringkasan all-tree keduanya root-guarded.
- Worker fresh (`spawn_worker`) benar-benar fresh: `newMeta` tak menyetel `sdkSessionId` → `resume:undefined` → transcript
  baru. Jadi worker BARU tidak mewarisi konteks parent/sibling lewat SDK; berbagi konteks hanya lewat TEKS task.
- Tidak ada injeksi memori/compaction lintas-sibling ke worker; memori compact hanya di-reseed ke sesi yang sama (Session.ts:403-408).
