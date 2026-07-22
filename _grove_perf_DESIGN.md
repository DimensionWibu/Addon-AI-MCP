# Grove — Desain Optimasi Performa (request → stream → render + konkurensi)

Status: **DESAIN (READ-ONLY)** — belum ada perubahan kode. Disusun dari profiling
`Session.ts`, `ipc.ts`, `preload/index.ts`, `renderer/main.ts`, `db.ts`,
`contextWindows.ts`, `SessionManager.ts`, `index.ts`.

## Catatan jujur soal batasan (WAJIB dibaca dulu)

Latency "thinking"/generasi token ada di **server inference Anthropic**. Itu **tidak bisa
dipercepat** dengan thread/optimasi di sisi klien — token datang secepat API mengirimnya.
Semua usulan di bawah **hanya** mempercepat pipeline **LOKAL** (baca chunk → IPC → render)
dan mengurangi **interferensi antar-sesi** (agar N sesi paralel tak saling nge-lag di
main-thread). Tujuan: respons **TERASA** lebih cepat & lancar, throughput UI naik, konkurensi
tidak serialize di satu titik. Bukan mempercepat model.

Prinsip: **jangan cargo-cult multi-thread.** Hanya 1 titik yang benar-benar CPU/IO-bound &
layak di-offload (DB sql.js `export()`). Sisanya cukup batch/throttle/incremental.

---

## Ringkasan bottleneck (paling berdampak → paling kecil)

| # | Bottleneck | File:line | Dampak | Fix | Risiko |
|---|-----------|-----------|--------|-----|--------|
| B1 | DB sql.js meng-`export()` SELURUH database ke disk tiap flush (250ms), O(ukuran DB), di main-thread → nge-block SEMUA sesi | `db.ts:139-155`, `:126` | Tinggi (konkurensi) | Off-main / better-sqlite3 / throttle | Med–High |
| B2 | `chat:delta` di-emit **per token** ke renderer, tak dibatch, dan tetap dikirim utk sesi non-aktif (lalu dibuang) | `Session.ts:850-851`; `main.ts:980-989,981` | Tinggi (IPC + terasa) | Coalesce ~40ms + suppress non-fokus | Low |
| B3 | `upsertSession()` (2 statement + schedule save) dipanggil tiap `applyUsage` = tiap pesan assistant | `Session.ts:1009`, `:997-1023` | Sedang–Tinggi | Throttle persist ctx | Low (SAFE) |
| B4 | Efek ketik (typewriter) meng-`textContent = slice(0,n)` string yang tumbuh tiap frame → **O(n²)** + tail-lag artifisial | `main.ts:287-301` | Sedang (terasa) | Append delta node + reveal lebih besar | Low (SAFE) |
| B5 | `renderBoard()` full-rebuild semua kartu tiap `board:update` | `main.ts:773-818,1014-1018` | Rendah–Sedang | Update per-kartu incremental | Low–Med |
| B6 | `extractResultText()` `JSON.stringify` output tool besar di main sebelum di-clip | `Session.ts:157-171,907` | Rendah | Clip lebih awal | Low (SAFE) |

**Bukan bottleneck (jangan disentuh):** `contextWindows.ts` — `contextPercent`/`contextWindowFor`
murni O(1) aritmetika + beberapa `String.includes`. Diklaim "recompute berat" — **tidak**.
**worker_threads:** saat ini **NOL** dipakai (grep bersih). Satu-satunya kandidat offload yang
sah adalah DB (B1); markdown/highlight TIDAK cukup berat untuk dijustifikasi worker.
**Tidak ada** re-parse markdown / re-highlight per token (lihat catatan di B4) — render markdown
penuh hanya SEKALI saat blok final (`main.ts:999`), dan tak ada syntax-highlighter sama sekali.

---

## B1 — DB: `export()` seluruh DB tiap flush di main-thread  ⚠️ paling penting utk konkurensi

**Bukti.** DB pakai **sql.js (WASM in-memory)**, bukan better-sqlite3. Tiap mutasi → `run()`
(`db.ts:124-127`) → `scheduleSave()` (`:145-155`, debounce 250ms) → `writeAtomic()` (`:139-143`)
yang memanggil **`this.db.export()`** — menyalin SELURUH image SQLite dari heap WASM ke
`Uint8Array`, lalu `writeFileSync` seluruh file. Biaya = **O(total ukuran DB)**, bukan O(perubahan).

Kenapa parah untuk konkurensi:
- Semua sesi (semua pohon) berbagi **satu** instance sql.js di main-thread. sql.js murni JS/WASM
  → **tak ada thread native**; setiap `prepare/step` dan setiap `export()` jalan di event-loop main.
- Riwayat chat **tak pernah dipangkas dari DB** (hanya DOM yang di-cap 400, `main.ts:263-267`).
  `chat_messages.detail` bisa sampai 6 KB/baris (`Session.ts:907`). DB tumbuh tanpa batas →
  biaya `export()` **naik seiring waktu**. Tiap 250ms saat streaming aktif, seluruh DB (bisa
  beberapa MB) di-memcpy + ditulis ke disk → **spike blocking event-loop** yang menghentikan
  streaming SEMUA sesi berbarengan. Inilah titik serialize antar-sesi terbesar.
- Tiap `record()` (`Session.ts:577-583`) = `addChatMessage` = **INSERT + query kedua
  `SELECT last_insert_rowid()`** (`db.ts:279-284`) → 2 statement/pesan, tiap-tiap memicu save.

**Usulan (pilih jalur):**

- **B1-a (REKOMENDASI jangka menengah): migrasi ke `better-sqlite3`.** Native, tulis
  **inkremental** (WAL) O(perubahan) — hilang total biaya "export seisi dunia". Sinkron tapi
  cepat (µs). Hilangkan `writeAtomic/export/scheduleSave` seluruhnya. **Risiko: MEDIUM** —
  modul native harus di-rebuild utk ABI Electron + `asarUnpack` (pola untuk binary unpacked sudah
  ada di repo, lih. `Session.ts:26-40`). Ini menuntaskan akar B1.

- **B1-b (alternatif, tetap sql.js): pindahkan DB ke `worker_thread`.** `export()` + disk I/O
  keluar dari main-thread. **Risiko: HIGH** — banyak call-site sinkron mengandalkan nilai balik
  langsung (`addChatMessage`→rowId dipakai seketika di `Session.ts:882-889`; `getChat`,
  `getBoardEntry`, `getAccountToken` sinkron). Harus di-async-kan + rowid di-generate lokal.
  Refactor besar; hanya ambil bila B1-a ditolak.

- **B1-c (INTERIM, LOW risk, bisa segera): kurangi frekuensi & besaran export.**
  1. `writeAtomic` hanya jalan bila **dirty** (ada mutasi sejak simpan terakhir) — flag boolean.
  2. Saat ada sesi `running`, naikkan debounce save 250ms → **~1.5–2s** (koalesce lebih banyak;
     data tetap aman di memori, `flush()` saat quit sudah ada di `db.ts:130`).
  3. Gabung B3 (di bawah) → jauh lebih sedikit mutasi memicu save.
  Ini meredakan gejala tanpa mengubah engine; **SAFE**. Tetap O(size) per export, jadi bukan
  obat akar — pasangkan dengan rencana B1-a.

**Dampak:** konkurensi & throughput naik paling besar; hilangkan micro-freeze berkala yang
menghentikan semua sesi. **B1-c aman dikerjakan lebih dulu; B1-a menuntaskan akarnya.**

---

## B2 — `chat:delta` per token, tak dibatch, dikirim ke sesi non-fokus

**Bukti.** `Session.ts:850-851`: tiap `content_block_delta`/`text_delta` → **satu**
`emit(chat:delta)`. Tak ada batching di main. `index.ts:107-109` mengirim tiap event ke
`webContents` (satu renderer) untuk **semua** sesi & pohon. Di renderer, delta sesi non-aktif
langsung **dibuang** (`main.ts:981: if (ev.payload.id !== activeId) break`) — tapi biaya
serialize IPC + structured-clone + wake renderer **sudah terlanjur** terjadi. Dengan 12 worker
(`MAX_WORKERS_PER_TREE`, `SessionManager.ts:26`) streaming bersamaan, ini banjir IPC + kerja
serialize main-thread yang percuma.

**Usulan:**
- **B2-a: coalesce delta per sesi di main (~30–60ms flush).** Buffer string delta per sesi,
  emit **satu** `chat:delta` berisi gabungan tiap ~40ms (atau saat blok selesai). Wajib flush
  sisa buffer **sebelum** `chat:message` finalisasi (`Session.ts:872`) & di `interruptTurn`/
  `result` agar urutan/keutuhan teks terjaga. Turunkan jumlah IPC 5–20×. **Risiko: LOW** (urutan
  tetap; hanya perlu flush di titik-titik akhir). **SAFE.**
- **B2-b: suppress delta utk sesi non-fokus.** Main sudah bisa tahu sesi aktif (renderer memanggil
  `setUsageSession(activeId)`, `preload:31`, `main.ts:159`). Simpan `activeId` di main; untuk sesi
  ≠ aktif **jangan emit `chat:delta` sama sekali** (teks tetap tersimpan via `record()`→DB dan
  di-`chat:message`; saat user pindah sesi, `getChat` memuat ulang, `main.ts:625-631`).
  **Risiko: LOW–MED** — regresi kecil: menonton sesi background secara live tak menampilkan token
  parsial sampai blok/turn menutup (baru muncul dari history). Bisa diterima; atau tetap kirim
  `chat:message` per blok (sudah demikian) agar teks final tetap tampil. **Cukup aman.**

**Dampak:** IPC & wake renderer turun drastis saat banyak sesi paralel → main-thread lebih lega,
streaming sesi aktif lebih mulus. Kombinasi B2-a+B2-b menghilangkan pemborosan terbesar di jalur IPC.

---

## B3 — `upsertSession` tiap `applyUsage` (tiap pesan assistant)

**Bukti.** `Session.ts:997-1023`: tiap pesan `assistant` membawa `usage` → `applyUsage` →
`this.db.upsertSession(this.meta)` (`:1009`). `upsertSession` (`db.ts:159-181`) menjalankan
**2 INSERT** (sessions + `INSERT OR IGNORE` board) + memicu `scheduleSave`. ctxInput/ctxOutput
berubah tiap pesan → dipersist tiap pesan, padahal angka konteks bersifat **ephemeral** (dihitung
ulang tiap turn dari `usage`).

**Usulan:** throttle persist ctx — cukup persist meta **setiap beberapa detik** atau **saat turn
selesai** (`result`, `Session.ts:935`), bukan tiap pesan. Emit `session:update` live ke UI tetap
jalan (badge ctx% real-time), hanya **penulisan DB** yang dijarangkan. **Risiko: LOW** — bila app
crash, hanya kehilangan hitungan ctx beberapa detik terakhir (dihitung ulang di turn berikutnya).
**SAFE.** Sangat sinergis dgn B1-c (memangkas sumber mutasi save terbesar kedua).

---

## B4 — Efek ketik: `textContent = slice(0,n)` O(n²) + tail-lag artifisial

**Bukti.** `main.ts:287-301` `flushPending`: tiap frame `pendingEl.textContent =
pendingText.slice(0, shownLen)` — **menyalin ulang seluruh string yang tumbuh** tiap frame →
total kerja ≈ **O(n²)** untuk pesan panjang; plus `scrollChatToBottom()` membaca `scrollHeight`
(`:277-284`) = forced reflow tiap frame. Selain itu reveal `ceil(remaining/12)` per frame
**menahan** tampilan (menambah lag ekor ~200–500ms pada stream cepat). Ini "efek", bukan
kebutuhan — kontraproduktif untuk kesan "cepat".

Klarifikasi penting: **tidak ada** re-parse markdown/re-highlight per token di sini. Streaming
memakai `textContent` polos (plain), markdown penuh baru dirender **sekali** saat blok final
(`main.ts:999`). Jadi biang lambat di jalur render adalah **O(n²) textContent + easing**, bukan
markdown.

**Usulan:**
- Simpan node teks & **append hanya substring baru** (`pendingText.slice(shownLen_lama)`) via
  `appendData`/text node → total **O(n)**.
- Naikkan laju reveal (mis. ungkap seluruh buffer per frame, atau easing jauh lebih besar) →
  hilangkan lag ekor; opsional matikan easing (tampilkan langsung) untuk kesan tercepat.
- Panggil `scrollChatToBottom` ter-throttle (sudah rAF-guard `scrollRaf`, cukup pertahankan).

**Risiko: LOW** (kosmetik, di renderer). **SAFE.** **Dampak: terasa** — pesan panjang mulus,
CPU renderer turun, output terasa "instan".

---

## B5 — `renderBoard()` full-rebuild tiap update  (prioritas lebih rendah)

**Bukti.** `main.ts:773-818`: `container.textContent=''` lalu bangun ulang **semua** kartu tiap
`board:update` (rAF-batched via `scheduleBoard`, `:1014-1018`). `board:update` menyala tiap
`reportProgress/updateSummary/updateTodo/reportToParent` (`SessionManager.ts:596-626`). Dengan
banyak worker melapor, seluruh board dibangun ulang berkali-kali.

**Usulan:** simpan ref DOM per kartu (pola `nodeEls`, `main.ts:58-61,513`) → update kartu yang
berubah saja. **Risiko: LOW–MED** (perlu diffing rapi). Dampak sedang; kerjakan setelah B1–B4.

---

## B6 — `JSON.stringify` output tool besar di main (kecil)

**Bukti.** `Session.ts:157-171` `extractResultText` bisa `JSON.stringify` konten tool besar,
`:907` baru di-`clip(...,6000)` **setelah** stringify penuh. Untuk output tool sangat besar
(mis. grep ribuan match) stringify penuh jalan sinkron di main sebelum dipotong.

**Usulan:** clip/junk lebih awal (batasi panjang sebelum stringify penuh, atau stringify hanya
potongan). **Risiko: LOW.** **SAFE.** Dampak kecil tapi murah.

---

## Urutan eksekusi yang disarankan (impact vs risiko)

1. **B2-a + B2-b** (coalesce & suppress delta) — dampak tinggi, risiko rendah, tanpa ubah engine.
2. **B3** (throttle persist ctx) — SAFE, memangkas mutasi DB drastis.
3. **B1-c** (export hanya-dirty + debounce lebih panjang saat streaming) — SAFE, meredakan B1 seketika.
4. **B4** (typewriter O(n)+laju) — SAFE, langsung terasa di UI.
5. **B1-a** (migrasi better-sqlite3) — menuntaskan akar konkurensi; jadwalkan sebagai kerja terpisah (risiko packaging).
6. **B5, B6** — polish.

Langkah 1–4 semuanya **SAFE/LOW-risk** dan sudah memberi lompatan "terasa jauh lebih cepat +
sesi paralel tak saling nge-lag" tanpa menyentuh engine DB. Langkah 5 barulah menghapus micro-
freeze sistemik. **Tak satu pun** dari ini mengklaim mempercepat inference model — itu di server.

## Titik yang TIDAK perlu diubah
- `contextWindows.ts` — O(1), bukan beban.
- Menambah worker_threads di mana-mana — hanya DB (B1) yang layak; sisanya tidak.
- Render markdown streaming — sudah sekali di akhir blok; bukan sumber lambat.
