# Grove — Audit & Perbaikan Jalur "Bangunkan Root" (biaya token multi-worker)

Tanggal: 2026-07-21. Verifikasi: `tsc --noEmit` exit 0 · `npm run build` exit 0 · `npm run test:wake`
30/30 lulus · `npm run test:accounts` (regresi) semua lulus.
Aktivasi: perubahan main-process → baru berlaku setelah USER me-restart Grove. BUKAN tugas agent.

---

## FASE 1 — Analisa: peta jalur yang membangunkan root

Satu "wake" = satu `injectAutoTask` = **satu giliran root penuh**, dan tiap giliran menagih ULANG
seluruh konteks root. Jadi:

    total token root ≈ (jumlah wake) × (ukuran konteks root)

Ukuran teks ping (~200-450 token) hanya 1-5% dari biaya satu giliran → **yang harus ditekan adalah
JUMLAH WAKE, bukan panjang teks.**

| # | Jalur | Pemicu | Coalesce sebelum fix | Temuan audit |
|---|-------|--------|----------------------|--------------|
| 1 | `reportToParent` → `scheduleRootStatus` | tiap `report_to_parent` (termasuk 25%/50%/75%) | debounce **geser** 60s | Dedupe pakai `treeBoardSummary` yang memuat **baris root sendiri + judul** → balasan root atas ping sebelumnya sudah mengubahnya → **dedupe praktis tak pernah kena**. Tiap laporan = 1 giliran root. |
| 2 | `notifyTurnEnd` → `autoReportFinal` → `queueParentReport` → `flushParentReports` | worker menutup turn | jendela tetap 12s / 800ms prioritas | Jalur ini benar, tapi **terpisah** dari jalur 1 → satu penutupan worker memicu jalur 1 **dan** 2. |
| 3 | `runLoopCheck` auto-check berkala | 10 menit, hanya bila ada sub stalled / semua done | streak 3× tanpa perubahan | Sehat (dedupe pakai `subBoardSignature` yang stabil). Tak diubah. |
| 4 | `runLoopCheck` mode cache-warm | 45 menit saat idle | — | Balasan 1 kata, biaya output ~nol. Tak diubah. |
| 5 | `onLimitHit` / `maybeSwitchOnUsage` → `injectAutoTask` | ganti akun karena limit | — | Jarang & memang perlu. Tak diubah. |
| 6 | `autoResume` | app dibuka lagi | — | Sekali per restart. Tak diubah. |

**Audit coalesce/debounce — apakah benar bekerja?**

- Jalur 1 memakai `clearTimeout`+set ulang = **debounce geser**, bukan batching. Aliran laporan
  rapat justru **menunda** ping (starvation); laporan renggang (kasus nyata: milestone tiap
  beberapa menit) **tak pernah tergabung** → 1 wake per laporan.
- Jalur 2 sudah batching jendela tetap (benar), tapi **dedupe di-bypass saat `anyDone`** → worker
  yang menutup turn dua kali dengan isi identik membangunkan root dua kali.
- **Dobel-wake terukur:** `report_to_parent(100)` (jalur 1 → ping 60s) **+** turn-end (jalur 2 →
  flush 800ms) = **2 giliran root untuk SATU penutupan worker**, isinya tumpang-tindih.

**Biaya per turn root** (window 200k, konteks tumbuh ~6k/giliran, auto-compact lama di 88%):
rata-rata ~77k token input per giliran pada paruh akhir sesi. Skenario 3 worker × 30 menit =
**18 giliran ≈ 1.39 juta token input.**

---

## FASE 2 — Perbaikan (6 fix)

File baru **`src/main/orchestrator/wakePolicy.ts`** — semua angka tuning + fungsi murni
(signature/dedupe/ambang compact) di satu tempat, bisa diuji tanpa runtime Electron.

**FIX 1 — eliminasi dobel-wake** (`SessionManager.reportToParent`, `notifyTurnEnd`)
`reportToParent` tidak lagi memanggil `scheduleRootStatus` sendiri; laporannya masuk **buffer
coalesce yang sama** dengan hasil akhir. Ping board tersendiri kini hanya untuk worker yang **bukan
anak langsung root** (cucu/cicit — kalau tidak, root baru tahu setelah laporan merambat level per
level). Ditambah: laporan 100% yang datang **di tengah turn** ditandai `awaitTurnEnd` dan ditahan
supaya menyatu dengan hasil akhir yang menyusul beberapa detik lagi → **1 giliran, bukan 2.**
Jaring pengaman: kalau turn ternyata berakhir tak wajar, `notifyTurnEnd` tanpa outcome melepas
buffer (dan timer jendela tetap terpasang), jadi laporan TUNTAS tak mungkin nyangkut.

**FIX 2 — jendela coalesce 12s → 30s** (`WAKE.coalesceMs`)
Sekarang berperan sebagai (a) jaring pengaman laporan tuntas yang menunggu turn-end, dan (b)
coba-lagi saat parent sedang running. Jendela 12s terlalu sempit untuk kedua peran itu.

**FIX 3 — laporan progres hanya update board, TIDAK membangunkan root**
Audit: tool `report_progress` memang **sudah** tidak membangunkan siapa pun (hanya `setProgress` +
`emitBoard`) — kebocorannya ada di `report_to_parent`. Kini laporan **non-final** tidak memasang
timer sama sekali: ia memperbarui board lalu **menumpang wake berikutnya**. Alasannya bukan sekadar
hemat tapi **redundan** — tiap ping/auto-check ke root sudah memuat ringkasan board berisi progres
yang sama. Ini pengali biaya terbesar yang hilang.
*Konsekuensi UX (disengaja):* root tidak lagi menarasikan tiap milestone worker ke user; progres
tetap terlihat **live di board/kartu sesi**, dan root bicara saat worker selesai atau saat
auto-check.

**FIX 4 — ping diringkas + larangan `read_board` dipertegas**
`treeBoardSummary(treeId, subsOnly)` membuang **baris root sendiri** dari tiap ping (root sudah tahu
keadaannya sendiri), baris dipangkas 220→160 char, total 2000→1200 char. Teks prompt `[GROVE AUTO]`
& `[GROVE AUTO-CHECK]` dipersingkat (ping nyata terukur **288 char**). Di `prompts.ts`, dua butir
panjang tentang ping digabung jadi satu larangan tegas: pings **sudah** memuat board penuh →
`read_board` saat menjawab ping = menambah tool round-trip + isi board yang sama ke konteks.

**FIX 5 — auto-compact root di 70% (bukan 88%)** (`wakePolicy.COMPACT`, dipakai `Session.ts`)
Ambang kini **per role**: root `70/50`, sub tetap `88/70`. Root adalah pihak yang paling sering
dibangunkan, jadi tiap persen konteksnya ditagih berkali-kali; compact root **tidak memakai giliran
model** (`compactSession` menyusun ringkasan sendiri dari board) → memadatkan lebih awal nyaris
gratis. Sub tetap tinggi karena menyimpan detail kerja yang mahal kalau hilang dan jarang
dibangunkan ulang. Hysteresis (`low`) ikut turun agar tak thrash.

**FIX 6 — skip wake bila laporan sama dengan yang terakhir**
`reportSignature()` = field materiil saja (worker, persen, isi ternormalisasi, flag done), diurutkan
per worker → dua flush berisi sama benar-benar terdeteksi sama. `anyDone` **tidak lagi mem-bypass**
dedupe (transisi "belum selesai → SELESAI" tetap lolos karena flag `done` ikut signature). Dedupe
ping board pindah dari `treeBoardSummary` ke **`subBoardSignature`** (status/percent/progress sub,
tanpa baris root) → balasan root sendiri tak lagi mematahkan dedupe.

---

## FASE 3 — Testing

`npm run test:wake` → **30/30 lulus** (tanpa memanggil API sama sekali).

**A. Unit — `test/wake-cost.ts` (tsx, murni): 13 check**
signature stabil lintas urutan · persen berubah → beda · flag done ikut signature · whitespace
dinormalkan · wake pertama tak pernah di-skip · isi identik → skip · isi beda → tetap wake · ambang
root 70/50 · ambang sub 88/70 · root dipadatkan lebih awal · hysteresis low<high · priority <
coalesce < rootStatus · cache-warm < TTL 1 jam.

**B. Integrasi — `test/wake-integration.ts` (SessionManager NYATA di Electron): 13 check**
Sesi sengaja tanpa akun → `Session.start()` berhenti sendiri, jadi **tak ada query SDK**; yang
dihitung adalah panggilan `injectAutoTask` (= giliran root).
`I1` 3 laporan progres → **0** giliran root, board tetap terupdate · `I2` lapor 100% di tengah turn
belum membangunkan, turn-end → **tepat 1** giliran yang memuat hasil akhir + progres yang menumpang
· `I3` turn-end ulang identik → **0** giliran tambahan · `I4` dua worker selesai berdekatan → **1**
giliran gabungan memuat keduanya · `I5` cucu tetap membangunkan root lewat ping board; ping
melarang `read_board`, tanpa baris root, 288 char.

**C. Regresi biaya — simulator jam-virtual (LAMA vs BARU, timeline sama)**
Skenario: 3 worker paralel ~30 menit, tiap worker 3 milestone + lapor 100% + turn-end + satu
turn-end ulangan tanpa info baru. Jarak antar-laporan sengaja > 1 menit = **kondisi terburuk bagi
coalesce** (tak ada yang menyatu karena kebetulan berbarengan).

| | LAMA | BARU | |
|---|---|---|---|
| giliran root | 18 | 6 | **−66.7%** |
| token input root | 1.386k | 246k | **−82.3%** |

Target ≥40% **terlampaui** (token turun lebih dalam daripada giliran karena FIX 5 ikut menurunkan
konteks rata-rata tiap giliran). Simulator adalah **model** kebijakan lama (kodenya sudah dihapus) —
perilaku kode nyata diuji di bagian B.

---

## FASE 4 — Tabel parameter

| Parameter | Sebelum | Sesudah | Rasionale |
|---|---|---|---|
| laporan **non-final** → wake | 1 wake/laporan (ping 60s) | **tidak pernah** (menumpang wake berikutnya) | Redundan: tiap ping ke root sudah memuat board dengan progres yang sama. Pengali biaya terbesar. |
| `coalesceMs` | 12s | **30s** | Jadi jaring pengaman laporan tuntas + retry saat parent running; 12s terlalu sempit untuk keduanya. |
| `priorityMs` | 800ms | 800ms | Worker SELESAI tak boleh tertahan — sudah pas, tetap menggabung burst. |
| `rootStatusDebounceMs` | 60s | 60s (**hanya cucu/cicit**) | Cakupannya yang dipersempit, bukan angkanya. Anak-langsung root pakai buffer laporan. |
| lapor 100% di tengah turn | flush cepat (→ wake ke-2 saat turn-end) | **ditahan** sampai turn-end | Hasil penuh menyusul beberapa detik lagi; digabung jadi satu giliran. |
| dedupe saat ada `done` | **di-bypass** | ikut dedupe (flag `done` masuk signature) | "Belum selesai → SELESAI" tetap terkirim; ulangan identik tidak. |
| dedupe ping board | `treeBoardSummary` (memuat baris root) | **`subBoardSignature`** | Balasan root sendiri tak lagi mematahkan dedupe. |
| auto-compact **root** | 88% / 70% | **70% / 50%** | Root paling sering dibangunkan → tiap persen ditagih berkali-kali; compact root tak pakai giliran model. |
| auto-compact **sub** | 88% / 70% | 88% / 70% | Detail kerja worker mahal kalau hilang; jarang dibangunkan ulang. |
| baris ringkasan board | 220 char, total 2000 | **160 char, total 1200** | Disuntik ke SETIAP ping. |
| baris root di ping | ikut | **dibuang** | Root sudah tahu keadaannya sendiri. |
| `loopIntervalMs` / `idleCheckLimit` / cache-warm | 10 mnt / 3 / 45 mnt | tidak diubah | Audit: jalur ini sudah sehat (dedupe stabil, balasan 1 kata). |

---

## FASE 5 — Checklist validasi (10 poin)

1. ✅ `npx tsc --noEmit -p tsconfig.json` exit 0 (src) + tsc strict eksplisit untuk kedua file test exit 0.
2. ✅ `npm run build` (electron-vite) exit 0.
3. ✅ `npm run test:wake` 30/30 lulus — tanpa satu pun panggilan API.
4. ✅ `npm run test:accounts` (suite lama, menyentuh SessionManager) semua lulus → tak ada regresi.
5. ✅ **Tak ada laporan hilang**: worker tuntas selalu sampai (I2/I4); turn berakhir tak wajar tetap
   melepas buffer; timer jendela terpasang sebagai jaring pengaman untuk entry `awaitTurnEnd`.
6. ✅ **Tak ada wake tak berujung**: `notifyTurnEnd` tetap early-return untuk role ≠ 'sub'; root tak
   pernah men-trigger `autoReportFinal` → rantai berhenti di root (tak ada kaskade/loop).
7. ✅ **Isolasi antar-pohon utuh**: guard `parent.meta.treeId === from.meta.treeId` tidak disentuh;
   ping tetap `treeId` pohon sendiri.
8. ✅ **Kebersihan state**: `lastPingSummary` ikut dibuang di `deleteSession` (dulu tertinggal),
   bersama `reportTimers`/`pendingReports`/`lastReportSig`.
9. ✅ **Board tetap live**: `report_progress`/`report_to_parent` tetap `setProgress` + `emitBoard`
   (diuji di I1b) — user tetap melihat progres walau root tak menarasikannya.
10. ✅ Perubahan hanya main-process + test; renderer/IPC/DB tak disentuh → **butuh restart Grove**
    agar aktif.

### Catatan jujur
- **Deviasi dari spesifikasi awal:** permintaan "perbesar jendela coalesce non-final 12s→30s"
  diimplementasi lebih jauh — laporan non-final kini **tidak membangunkan root sama sekali** (30s
  tetap dipakai sebagai jaring pengaman). Dengan hanya memperbesar jendela ke 30s, laporan milestone
  yang jaraknya menit-menitan tetap = 1 giliran root masing-masing → penghematan hanya ~20%, tidak
  mencapai target 40%. Ini terukur di simulator sebelum keputusan diambil.
- **FIX 3 sebagian sudah benar sebelumnya**: `report_progress` memang tak pernah membangunkan root;
  kebocorannya ada di `report_to_parent` dan diperbaiki di sana.
- **Temuan lama (di luar cakupan, TIDAK diperbaiki):** `npm test` (`tsx test/integration.ts`) sudah
  rusak sejak `SessionManager` mengimpor `electron` — tsx gagal me-link named export `app`. Suite
  baru karena itu memakai pola Electron yang sama dengan `test:accounts`.
