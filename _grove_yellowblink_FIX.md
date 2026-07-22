# Grove — Changelog fitur "kartu sesi MENYALA KUNING + BERKEDIP saat awaiting-input"

Tanggal: 2026-07-20. Desain acuan: `_grove_yellowblink_DESIGN.md`. Pola end-to-end meniru `apiStopped`.
Berlaku untuk ROOT (nunggu USER) & SUB (nunggu PARENT) — deteksi ada di `handle('result')` yang jalan
untuk SEMUA sesi.

Verifikasi: **`npx tsc --noEmit -p tsconfig.json` → PASS (exit 0)**, **`npm run build` → PASS (exit 0)**.
App TIDAK di-restart (hanya compile; bukan dev/start/dist).

---

## 1) `src/main/orchestrator/Session.ts`
- **:207** helper `looksLikeAwaitingInput(text)` — ambil ~2 baris non-kosong TERAKHIR dari teks
  asisten final; true bila diakhiri `?` ATAU cocok allowlist frasa konfirmasi ID+EN.
- **:306** `AsyncMessageQueue.hasPending()` — cek antrian inbox tak kosong (utk syarat "inbox kosong").
- **:347** field `private awaitingInput = false`.
- **:716** `setAwaitingInput(v)` — emit `session:update` `{id, awaitingInput}` PERSIS pola `setApiStopped`.
- **:940-948** SET di `handle('result')`: `if (cleanEnd && !this.inbox.hasPending() &&
  looksLikeAwaitingInput(this.turnText || this.lastAssistantText)) this.setAwaitingInput(true)`.
  Ditempatkan setelah hitung `cleanEnd` & SEBELUM `turnText` dibersihkan.
- CLEAR (choke-points):
  - **:500** `beginTurn()` — choke-point tunggal semua kerja baru (sendUserMessage/injectAutoTask/
    autoCheck/autoResume/recycle) → `setAwaitingInput(false)`.
  - **:785** `interruptTurn()` (defensif — Stop manual).
  - **:588** `stop()` (defensif — sesi ditutup).
  - **:455** `resetForNewTask()` (reuse worker konteks bersih → kedip lama tak relevan).

## 2) `src/shared/types.ts`
- **:153** payload `session:update`: tambah `awaitingInput?: boolean` (sebaris dgn `apiStopped`).

## 3) `src/renderer/main.ts`
- **:19** type `Node`: tambah `awaitingInput?: boolean`.
- **:533** `updateNodeVisual()`: `refs.wrap.classList.toggle('awaiting-input', !!n.awaitingInput)`
  (sebaris dgn toggle `api-stopped`). Handler `session:update` sudah `Object.assign(cur, ev.payload)`
  + `updateNodeVisual` → event `{id,awaitingInput}` langsung berefek; tak perlu perubahan lain.

## 4) `src/renderer/styles.css`
- **:149** `@keyframes awaitBlink` (background berkedip antara `rgba(217,164,65,0.10)` ↔ `0.34`).
- **:153-156** `.node.awaiting-input { animation: awaitBlink 1s ease-in-out infinite; border-color:
  var(--warn) }` + judul `#f4d68a`, dot kuning, tetap kelihatan saat `.active`.
- **:157-159** `@media (prefers-reduced-motion: reduce)` → tak berkedip (background statis) utk aksesibilitas.
- Warna kuning = `--warn: #d9a441` (konsisten dgn dot `.s-waiting`); terbaca di tema gelap.

## 5) `src/renderer/index.html` (legend, opsional)
- **:24** tambah `<span class="dot s-waiting await-legend"></span>butuh jawaban`.
- styles.css **:161-163** `.dot.await-legend` kedip halus (opacity pulse `legendPulse`), + reduced-motion off.

## TIDAK diubah
- `src/preload/index.ts`, `src/main/ipc.ts` — passthrough generik `grove:event`, tak perlu.
- `SessionManager.ts` / DB — `awaitingInput` runtime-only, tak dipersist (reset saat app restart; disengaja).

---

## Keputusan desain
- **Layer flag boolean di atas `status='idle'`** (BUKAN enum SessionStatus baru) — meniru `apiStopped`,
  non-invasif terhadap timer/board/DB/enum.
- **Allowlist frasa `looksLikeAwaitingInput`** (diikat ke ~2 baris penutup):
  - Terkuat: penutup diakhiri `?` → true (menangkap "Lanjut?", "Which one?", "ok?").
  - ID: `mau saya`, `boleh saya`, `apakah`, `konfirmasi`, `setuju`, `pilih (yang) mana`,
    `mau yang mana`, `butuh (jawaban|keputusan|konfirmasi|persetujuan)`,
    `tolong (konfirmasi|pilih|pastikan|putuskan)`, `y/n`, `ya/tidak`, `iya/tidak`.
  - EN: `confirm`, `should i`, `would you like`, `do you want`, `proceed`, `which (one|option)`,
    `let me know`, `please (confirm|choose|clarify|advise|decide)`,
    `waiting for (your) (input|confirmation|answer|decision|reply)`.
  - `lanjut` bare (tanpa `?`) SENGAJA tak dimasukkan ke branch non-`?` (terlalu umum → false-positive);
    tetap tertangkap via jalur `?`.
- **Syarat SET**: hanya saat `cleanEnd` (turn sukses, bukan interupsi/limit/blokir API) **DAN**
  `!inbox.hasPending()` (tak ada kerja tertunda) **DAN** heuristik true → tekan false-positive.
- **CLEAR terpusat di `beginTurn()`**: otomatis mati saat user membalas root, atau root `assign_worker`
  ke sub (assign → sendUserMessage → beginTurn). Plus defensif di interrupt/stop/resetForNewTask.

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**.
- `npm run build` → **exit 0** (main 101.68 kB, preload 2.10 kB, renderer css 19.83 kB / js 38.27 kB).
- Tidak menjalankan dev/start/dist/restart (sesi live aman).

---

# PERLUASAN HEURISTIK (revisi 2026-07-20) — `looksLikeAwaitingInput`

Scope edit: **HANYA** `src/main/orchestrator/Session.ts` (**:203-268**, fungsi di **:230**).
Syarat SET (`cleanEnd` + `!inbox.hasPending()`) dan semua jalur CLEAR
(`beginTurn`/`interruptTurn`/`stop`/`resetForNewTask`) **TIDAK diubah**.

## Kenapa direvisi (bug nyata)
Versi lama hanya memeriksa **~2 baris penutup**. Kasus user lolos deteksi: asisten menaruh
permintaan keputusan di **TENGAH** pesan — `"Bola di kamu sekarang, pilih satu:"` + daftar bernomor
1..4 — sedangkan **baris penutupnya kalimat PERNYATAAN tanpa `?`**
(`"…bilang saja — … Saya berhenti dulu di sini biar tidak menyentuh perangkatmu lebih jauh tanpa izin."`).
Frasa `"bilang saja"` juga belum ada di allowlist.

## Aturan baru: 3 lapis, beda lebar jendela (sensitif tapi FP tetap rendah)
| Lapis | Jendela | Aturan |
|---|---|---|
| **L1** | baris TERAKHIR | diakhiri `?` → true (sinyal terkuat) |
| **L2** | ~8 baris terakhir | **BLOK PILIHAN**: daftar ≥2 item (`1.` / `1)` / `-` / `*` / `•`) **DAN** pemicu serah-keputusan (`pilih satu`, `pilih salah satu`, `silakan pilih`, `pilihanmu`, `bola di kamu/anda`, `terserah kamu/anda`, `mana yang`, `pick one`, `choose one`, `your call`, `up to you`, `which one/option`) |
| **L3a** | ~8 baris terakhir | frasa **SPESIFIK/memblokir**: `bilang saja`, `kabari (saya\|aku\|ya\|kalau\|kalo\|begitu\|setelah)`, `beri tahu saya`, `tunggu kabar`, `(menunggu\|nunggu) (jawaban\|keputusan\|konfirmasi\|instruksi\|arahan\|persetujuan)`, `saya berhenti dulu`, `tanpa izin`, `butuh (akses\|kredensial\|password\|token\|izin) dari (kamu\|anda)`, `bola di kamu/anda`, `pilih satu/salah satu`, `silakan pilih`, `pilihanmu`, `y/n`, `ya/tidak`, `iya/tidak` · EN: `let me know`, `waiting for (your) (input\|confirmation\|answer\|decision\|reply)`, `please (confirm\|choose\|clarify\|advise\|decide)`, `should i`, `would you like`, `do you want`, `which (one\|option)` |
| **L3b** | **3 baris** penutup | frasa **GENERIK** (jendela sengaja SEMPIT): `mau saya`, `boleh saya`, `apakah`, `konfirmasi`, `setuju`, `pilih (yang) mana`, `mau yang mana`, `butuh (jawaban\|keputusan\|konfirmasi\|persetujuan)`, `tolong (konfirmasi\|pilih\|pastikan\|putuskan)` · EN: `confirm`, `proceed` |

Semua frasa lama (ID+EN) **dipertahankan** — hanya dipindah ke tier yang sesuai.

## Keputusan anti-false-positive (didokumentasikan juga di komentar kode)
- **Tier + lebar jendela dipisah.** Kata generik (`apakah`, `konfirmasi`, `confirm`, `proceed`) TIDAK
  ikut diperlebar ke 8 baris — kalau ikut, kalimat sambil-lalu gampang salah-picu. Jendelanya tetap
  sempit (3 baris) → praktis mempertahankan perilaku lama.
- **Pemicu L2 harus IMPERATIF/serah-keputusan, bukan kata benda.** `opsi`/`pilihan` sengaja TIDAK
  jadi pemicu; kalau tidak, changelog berpoin (`"menambah 3 opsi baru:"` + daftar) ikut menyala.
- **`kabari` diikat ke bentuk yang ditujukan ke USER** (`kabari saya/ya/kalau`) supaya
  `"nanti saya kabari hasilnya"` (asisten yang memberi tahu) tidak salah-picu.
- **Kasus abu-abu dicondongkan ke TIDAK menyala.** Tawaran non-blocking
  (`"Kalau mau, saya bisa lanjut ke X"`) tidak menyala — tak ada permintaan keputusan eksplisit
  maupun blok pilihan.
- **`bilang saja` = anggota paling rawan** di L3a (kadang basa-basi penutup), tetap dimasukkan atas
  permintaan eksplisit karena muncul di kasus nyata. Biaya FP rendah: kedip hilang begitu ada giliran
  baru (`beginTurn`), dan SET masih dijaga `cleanEnd` + inbox kosong.

## Hasil uji (harness sementara di luar repo, sudah DIHAPUS — tak ada file uji tertinggal)
13/13 LULUS:
- TRUE: **(a) kasus user** (blok pilihan di tengah + penutup pernyataan) · **(c)** penutup `?` ·
  **(d)** `"Mau saya lanjut ke P1?"` · `mana yang` + daftar · `menunggu keputusan` · `let me know` ·
  `butuh kredensial dari kamu`
- FALSE: **(b)** `"Selesai. tsc+build PASS, tak ada yang perlu kamu lakukan."` · tawaran non-blocking ·
  changelog berpoin · `"nanti saya kabari hasilnya"` · `"menambah 3 opsi baru:"` + daftar ·
  laporan progres biasa

## Verifikasi revisi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**.
- `npm run build` → **exit 0** (main 121.65 kB, preload 2.15 kB, renderer css 22.15 kB / js 43.71 kB;
  ikut meng-compile perubahan worker lain tanpa konflik).
- Tidak menjalankan dev/start/dist/restart.
