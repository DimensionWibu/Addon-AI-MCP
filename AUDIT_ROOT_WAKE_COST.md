# AUDIT & FIX: Root Wake Storm — Konteks Besar Dikirim Ulang Tiap Worker Lapor

## Bug Summary

Setiap kali worker melapor (reportToParent/report_progress), root orchestrator
DIBANGUNKAN → satu giliran baru → SELURUH konteks root dikirim ulang ke API.
Dengan konteks root 83.9% (≈168K token) dan 2 worker aktif, satu ronde kerja
menghabiskan ~570K token. Ini membuat kuota 5-jam habis sangat cepat (12% dalam
9 menit).

**Akar masalah**: giliran root terlalu SERING dibangunkan, dan setiap giliran
membayar ULANG seluruh konteks yang menumpuk.

---

## FASE 1: ANALISA — Petakan Semua Jalur yang Membangunkan Root

### 1.1 Inventarisasi Trigger Root Turn

Baca `src/main/orchestrator/SessionManager.ts` dan identifikasi SEMUA jalur
kode yang menyebabkan root mendapat giliran baru (turn). Catat untuk tiap jalur:
- Nama fungsi pemicu
- Kondisi yang memicunya
- Apakah ada debounce/coalesce
- Estimasi frekuensi (per menit) dalam skenario 2-3 worker aktif

Jalur yang SUDAH DIKETAHUI:
1. `reportToParent` → `wakeRoot` (via debounce `ROOT_STATUS_DEBOUNCE_MS`)
2. `notifyTurnEnd` → auto-report ke parent (bila worker belum lapor final)
3. `runLoopCheck` → auto-check berkala (`LOOP_INTERVAL_MS = 10 menit`)
4. `[GROVE AUTO]` ping dari worker progress report
5. `cacheWarm` → ping ringan (setelah idle-strike)
6. User mengirim pesan langsung ke root

Untuk tiap jalur, jawab:
- Apakah jalur ini PERLU membangunkan root?
- Bisakah informasinya ditunda/digabung tanpa kehilangan fungsionalitas?
- Berapa token yang terbuang per trigger yang sebenarnya tak perlu?

### 1.2 Ukur Biaya Nyata Per Turn Root

Buat skrip pengukuran di `test/root-wake-cost.ts`:

```
Skenario uji:
A. Root saja (tanpa worker) — kirim 1 pesan, ukur token turn pertama
B. Root + 1 worker selesai — worker lapor 100%, ukur token turn root yang bangun
C. Root + 2 worker lapor bersamaan — ukur apakah coalesce bekerja (1 vs 2 turn)
D. Root + 2 worker lapor berselang 15 detik — ukur apakah debounce efektif
E. Root konteks 20% vs 50% vs 80% — ukur pertumbuhan biaya per turn

Metrik per skenario:
- Jumlah turn root yang terjadi
- Token input (context) per turn
- Token cache_read vs cache_creation per turn  
- Token output per turn
- Total token skenario
- Waktu wall-clock skenario
```

### 1.3 Audit Coalesce dan Debounce

File: `src/main/orchestrator/SessionManager.ts`

Periksa:
1. `WORKER_REPORT_COALESCE_MS = 12_000` — apakah ini BATCHING (timer dimulai
   saat laporan PERTAMA masuk, flush setelah 12s) atau DEBOUNCE (timer di-reset
   tiap laporan baru masuk → bisa tertunda tak terbatas)?
   - Batching = benar (gabung banyak laporan, flush tepat waktu)
   - Debounce geser = salah (satu worker lambat menunda semua)

2. `ROOT_STATUS_DEBOUNCE_MS = 60_000` — apakah root benar-benar TIDAK dibangunkan
   lebih sering dari 1x per menit? Atau ada jalur yang MEMBYPASS debounce ini?

3. `REPORT_PRIORITY_MS = 800` — flush cepat saat worker selesai (100%). Apakah
   ini menyebabkan dobel-wake bila 2 worker selesai hampir bersamaan?

4. Apakah `notifyTurnEnd` JUGA membangunkan root di LUAR jalur coalesce?
   (Ini bisa jadi penyebab dobel-wake: worker lapor via reportToParent DAN
   notifyTurnEnd otomatis di akhir turn.)

5. Periksa: apakah `[GROVE AUTO]` ping yang dikirim ke root saat worker lapor
   progress SUDAH berisi ringkasan board? Kalau ya, root TAK PERLU memanggil
   read_board → hemat 1 tool call per ping. Kalau root TETAP memanggil
   read_board, itu giliran tambahan yang sia-sia.

---

## FASE 2: PERBAIKAN — Kurangi Jumlah & Biaya Giliran Root

### 2.1 Eliminasi Dobel-Wake

Problem: worker yang selesai bisa membangunkan root DUA KALI:
1. `reportToParent(percent:100)` → masuk buffer coalesce → flush (wake root)
2. `notifyTurnEnd(outcome)` → auto-report → wake root LAGI

Fix: bila worker sudah `reportToParent(100)` (`finalReportSent=true`),
`notifyTurnEnd` TIDAK BOLEH mengirim auto-report tambahan ke parent.
Periksa apakah guard ini sudah ada dan berfungsi benar.

### 2.2 Perbesar Jendela Coalesce untuk Non-Final Report

Progress report (25%, 50%, 75%) TIDAK urgen — root tak perlu merespons cepat.
Hanya laporan FINAL (100%) yang perlu segera.

```
Proposal:
- Non-final (percent < 100): WORKER_REPORT_COALESCE_MS = 30_000 (30 detik)
- Final (percent >= 100): REPORT_PRIORITY_MS = 800 (tetap cepat)
- Atau: non-final report TIDAK membangunkan root sama sekali — hanya update
  board (UI) tanpa giliran root. Root membaca saat auto-check berikutnya.
```

### 2.3 Passif Board Update (Tanpa Wake Root)

Banyak update yang cukup menulis ke board TANPA membangunkan root:
- `reportProgress` — hanya update dashboard UI, root tak perlu tahu
- `updateSummary` — sama, cukup tulis ke board
- `updateTodo` — sama

Hanya `reportToParent` dan `notifyTurnEnd(final)` yang PERLU membangunkan root.

Periksa: apakah `reportProgress` saat ini JUGA memicu wake root? Kalau ya, itu
jalur boros yang harus diputus.

### 2.4 Ringkas Auto-Check Prompt

Auto-check prompt (`loopCheckPrompt`) menyuntikkan ringkasan board ke prompt.
Periksa:
- Berapa panjang prompt auto-check (dalam token)?
- Apakah ringkasan board yang disuntik SUDAH ringkas (<500 token)?
- Apakah root merespons auto-check dengan tool call (read_board, list_workers)?
  Kalau ya, itu giliran TAMBAHAN yang boros — prompt harus melarang tool call
  untuk auto-check dan cukup merespons dari ringkasan yang disuntik.

### 2.5 Batasi Pertumbuhan Konteks Root

Root seharusnya RINGAN (koordinasi saja), tapi konteksnya bisa mencapai 83.9%.
Penyebab:
- Tiap giliran (auto-check, worker report, user chat) MENAMBAH riwayat
- Board summary yang disuntik tiap ping menumpuk
- Tool call result (list_workers, read_board) menumpuk

Fix:
- Auto-compact root LEBIH AGRESIF: turunkan ambang dari 88% ke 70% KHUSUS root
  (root butuh headroom lebih besar karena sering dibangunkan)
- Atau: root TIDAK menyimpan hasil auto-check/auto-ping di riwayat SDK —
  inject sebagai system message yang TIDAK masuk transkrip permanen

### 2.6 Smart Root Wake: Skip Bila Tak Ada yang Berubah

Sebelum benar-benar membangunkan root (injectAutoTask), periksa:
- Apakah isi laporan worker SAMA dengan yang terakhir dikirim?
- Kalau sama → SKIP wake (tulis ke board saja, tanpa giliran root)
- Gunakan hash/signature dari laporan untuk deduplikasi cepat

Ini sudah SEBAGIAN ada di `lastReportSig` — audit apakah guard ini efektif
dan apakah semua jalur wake melewatinya.

---

## FASE 3: TESTING — Pastikan Fix Tidak Merusak Fungsionalitas

### 3.1 Unit Test: Coalesce & Debounce

File: `test/root-wake-test.ts`

```
Test cases:
1. [coalesce_basic] 2 worker lapor dalam 5 detik → root hanya dapat 1 giliran
2. [coalesce_final] Worker lapor 100% → root dibangunkan dalam <1 detik
3. [no_double_wake] Worker reportToParent(100) lalu turn selesai → root hanya
   dapat 1 wake (bukan 2)
4. [progress_no_wake] Worker reportProgress → board terupdate, root TIDAK
   dibangunkan
5. [skip_unchanged] Worker lapor hal yang sama 2x → root hanya dibangunkan 1x
6. [auto_check_no_tool] Auto-check prompt → root merespons TANPA memanggil
   read_board/list_workers (cek dari transkrip/tool log)
7. [compact_root_early] Root mencapai 70% → auto-compact terpicu (bukan 88%)
8. [idle_streak] 3 auto-check tanpa perubahan → beralih ke cache-warm mode
```

### 3.2 Integration Test: Skenario Multi-Worker

File: `test/multi-worker-cost.ts`

```
Skenario end-to-end:
A. "2 worker, tugas 5 menit":
   - Spawn 2 worker, masing-masing kerjakan tugas ringan
   - Ukur: total turn root, total token root, waktu selesai
   - Target: turn root ≤ 4 (spawn + 1 coalesced progress + 1 final synthesis)

B. "3 worker, 1 selesai duluan":
   - Worker A selesai di menit 2, B & C selesai di menit 5
   - Ukur: root tidak dibangunkan ulang untuk worker A setelah final report

C. "Stress: 5 worker lapor bersamaan":
   - 5 worker lapor progress dalam jendela 10 detik
   - Ukur: root hanya dapat 1 giliran (semua tercoalesce)
   
D. "Root compact saat konteks tinggi":
   - Jalankan hingga root mencapai 70%
   - Verifikasi auto-compact terpicu dan konteks turun
```

### 3.3 Cost Regression Test

File: `test/cost-regression.ts`

```
Baseline (SEBELUM fix):
- Catat total token untuk skenario A-D di atas

Setelah fix:
- Jalankan skenario yang sama
- Bandingkan: target pengurangan ≥ 40% total token root

Jalankan otomatis di CI atau `npm run test:cost-regression`
```

---

## FASE 4: TUNING — Parameter yang Perlu Disesuaikan

### Parameter dan rentang yang diuji:

| Parameter | Sekarang | Proposal | Rasionale |
|-----------|----------|----------|-----------|
| `WORKER_REPORT_COALESCE_MS` | 12.000 | 30.000 (non-final) | Gabung lebih banyak laporan per giliran |
| `REPORT_PRIORITY_MS` | 800 | 800 (tetap) | Final report tetap cepat |
| `ROOT_STATUS_DEBOUNCE_MS` | 60.000 | 60.000 (tetap) | Sudah cukup |
| `LOOP_INTERVAL_MS` | 600.000 (10m) | 900.000 (15m) | Kurangi auto-check |
| `AUTO_COMPACT_HIGH` (root) | 88% | 70% (khusus root) | Root butuh headroom |
| `IDLE_CHECK_LIMIT` | 3 | 2 | Lebih cepat ke cache-warm |
| reportProgress → wake root | YA | **TIDAK** | Board-only, tanpa giliran |
| notifyTurnEnd + finalReportSent | kirim | **SKIP** | Cegah dobel-wake |

### Cara tuning:

1. Terapkan parameter proposal
2. Jalankan `test/multi-worker-cost.ts` skenario A
3. Bandingkan total token vs baseline
4. Kalau belum ≤ 40% pengurangan, naikkan coalesce ke 45.000 dan uji lagi
5. Kalau fungsionalitas terganggu (root terlalu lambat merespons), turunkan
   coalesce ke 20.000

---

## FASE 5: VALIDASI AKHIR

### Checklist sebelum commit:

- [ ] `npx tsc --noEmit` bersih
- [ ] `npm run test:accounts` lulus (42 check)
- [ ] `test/root-wake-test.ts` semua lulus
- [ ] `test/multi-worker-cost.ts` skenario A-D lulus
- [ ] `test/cost-regression.ts` menunjukkan pengurangan ≥ 40%
- [ ] Manual test: buka Grove, spawn 2 worker, pantau usage panel —
      kuota 5-jam TIDAK naik lebih dari 5% dalam 10 menit
- [ ] `reportProgress` TIDAK membangunkan root (verifikasi di log)
- [ ] Worker selesai → root dibangunkan TEPAT 1x (bukan 2x)
- [ ] Auto-compact root terpicu di 70% (bukan 88%)
- [ ] Auto-check → root TIDAK memanggil read_board (cukup dari injeksi prompt)

---

## File yang PASTI perlu diubah:

1. `src/main/orchestrator/SessionManager.ts` — coalesce, debounce, wake logic,
   auto-compact threshold untuk root
2. `src/main/orchestrator/Session.ts` — guard dobel-wake di notifyTurnEnd
3. `test/root-wake-test.ts` — BARU, unit test wake behavior
4. `test/multi-worker-cost.ts` — BARU, integration test multi-worker cost
5. `test/cost-regression.ts` — BARU, baseline & regression comparison

## File yang MUNGKIN perlu diubah:

6. `src/main/orchestrator/prompts.ts` — instruksi auto-check tanpa tool call
7. `src/main/orchestrator/mcpTools.ts` — reportProgress tidak trigger wake
