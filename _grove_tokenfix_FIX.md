# Grove — FIX pemborosan token: coalesce laporan worker + gate `read_board` "all"

Tanggal: 2026-07-20. Rujukan temuan: `_grove_contextleak_DIAG.md`.
Scope edit: **HANYA** `src/main/orchestrator/SessionManager.ts` + `src/main/orchestrator/mcpTools.ts`
(deskripsi tool). `ipc.ts` & `Session.ts` TIDAK disentuh (dipakai worker lain).
Verifikasi: **`npx tsc --noEmit -p tsconfig.json` exit 0** + **`npm run build` exit 0**. App tak di-restart.

---

## FIX A — PENGALI GILIRAN: coalesce laporan worker

### Temuan saat membaca kode (mempertajam diagnosa)
Dari 3 jalur inject ke parent/root, **hanya SATU yang benar-benar tak teredam**:

| Jalur | Status SEBELUM fix |
|---|---|
| `scheduleRootStatus` (ping `[GROVE AUTO]`) | SUDAH teredam: debounce `ROOT_STATUS_DEBOUNCE_MS` **60 dtk** + dedupe `lastPingSummary` + tunda saat root `running` |
| `runLoopCheck` (`[GROVE AUTO-CHECK]`) | SUDAH teredam: interval 10 mnt + `IDLE_CHECK_LIMIT` |
| **`autoReportFinal` → `parent.injectAutoTask(note)`** | **TANPA peredam sama sekali** — tiap worker menutup turn = SATU giliran parent SEKETIKA |

Jadi pengali dominan = `autoReportFinal`. Dengan N worker menutup turn, parent dapat N giliran, dan tiap
giliran menagih ULANG seluruh konteks parent yang menumpuk. **Itu yang diperbaiki**; dua jalur lain
sengaja DIBIARKAN (sudah efisien, dan mengubahnya berisiko regresi auto-check).

### Mekanisme: batching window per-parent (bukan debounce geser)
- **SessionManager.ts:40-42** konstanta: `WORKER_REPORT_COALESCE_MS = 12_000` (jendela gabung),
  `REPORT_PRIORITY_MS = 800` (flush cepat saat worker tuntas), `MAX_BOARD_ROWS = 40`.
- **SessionManager.ts:45-55** tipe `PendingWorkerReport` (workerId/title/line/filePath/percent/done/ts).
- **SessionManager.ts:67-71** state: `pendingReports` (parentId → Map workerId→laporan TERBARU),
  `reportTimers` (parentId → timer), `lastReportSig` (parentId → isi flush terakhir).
- **SessionManager.ts:788-806** `autoReportFinal` TIDAK lagi `injectAutoTask` langsung → `queueParentReport(...)`.
- **SessionManager.ts:810-827** `queueParentReport`: masuk buffer + jadwalkan flush.
- **SessionManager.ts:829-835** `flushParentReportsSoon`: mempercepat timer (jalur prioritas).
- **SessionManager.ts:843-868** `flushParentReports`: kirim SATU auto-task gabungan.
- **SessionManager.ts:870-884** `buildCombinedReport`: format gabungan (1 bullet per worker + path file).

**Kenapa batching window, BUKAN debounce geser:** debounce yang di-reset tiap laporan baru bisa
**starvation** — aliran laporan terus-menerus menunda flush selamanya. Di sini timer **tidak digeser**
oleh laporan biasa: laporan pertama membuka jendela, laporan berikutnya hanya menumpuk di buffer, flush
terjadi di akhir jendela. Hanya laporan PRIORITAS yang boleh **mempercepat** (tak pernah memperlambat).
→ Buffer dijamin ter-flush ≤ 1 jendela (12 dtk) sejak laporan pertama.

### 4 syarat yang diminta — semuanya terpenuhi
1. **Buffer + debounce per-root** → `pendingReports` per parentId, flush 12 dtk jadi SATU auto-task gabungan.
2. **Dedupe per worker** → `buf.set(entry.workerId, entry)`: laporan lama worker yang sama ditimpa; hanya
   yang TERBARU ikut terkirim (SessionManager.ts:815).
3. **Jangan menyuntik saat parent `running`** → `flushParentReports` cek `parent.meta.status === 'running'`
   lalu **menjadwalkan ulang** (bukan membuang) — pola sama dengan `scheduleRootStatus` (SessionManager.ts:851-858).
4. **Skip bila tak ada perubahan materiil** → tanda tangan `sig` (workerId|percent|line) dibandingkan dengan
   `lastReportSig`; sama → tak membuat giliran (SessionManager.ts:861-865).

### INVARIAN yang dijaga (anti-regresi)
- **Laporan "worker SELESAI" tak boleh hilang/tertunda:**
  - `reportToParent` percent ≥ 100 → `flushParentReportsSoon(parentId)` (**SessionManager.ts:720-724**)
    → flush dalam ~800 ms, tidak menunggu 12 dtk.
  - `autoReportFinal` juga menandai `done: from.meta.status === 'done'` → `queueParentReport` langsung
    mengambil jalur prioritas (SessionManager.ts:817-819).
  - Skip "tak ada perubahan" **di-bypass** bila ada entri `done` (`if (!anyDone && sig sama) return`)
    → laporan selesai tak pernah tertelan dedupe.
  - Buffer tak pernah menggantung: timer selalu terpasang; saat parent `running` dijadwalkan ulang, bukan dibuang.
  - → alur "semua worker selesai → root menyintesis" tetap jalan.
- **`runLoopCheck` / auto-check / `task_done` (stopLoop): TIDAK disentuh sama sekali.**
- **`scheduleRootStatus` TIDAK disentuh** (ping board tetap jalan seperti semula).
- **Tidak mematikan notifikasi** — hanya menggabungkan; isi tiap laporan (ringkasan ≤700 char + path file
  hasil lengkap) tetap sampai ke parent.
- **Kebersihan:** buffer/timer/sig dihapus saat sesi dihapus (**SessionManager.ts:661-666**) dan saat parent
  sudah tak ada (SessionManager.ts:847-850) → tak ada timer/memori yatim.

---

## FIX B — Gate `read_board` scope "all"

**Sebelum:** `return scope === 'all' ? true : m.treeId === callerTree` tanpa gate; redaksi hanya bila
pemanggil SUB → **root menerima board PENUH semua tree lintas project** (≈34 KB ≈ ~9.000 token / panggilan).

**Sesudah — SessionManager.ts:941-985:**
1. **Scope 'all' ROOT-ONLY** — `const effScope = scope === 'all' && callerIsRoot ? 'all' : 'tree'`
   (SessionManager.ts:958). Sub yang meminta `'all'` **diturunkan** ke `'tree'` (bukan error keras).
   Catatan: pemanggil tak dikenal (`caller` undefined) juga jatuh ke `'tree'` — aman secara default.
2. **Tree ASING selalu RINGKAS untuk SIAPA PUN (termasuk root)** — `summary` diganti
   `'(tree lain — ringkas: status saja)'`, `todo: []`, `progress: ''`; yang tersisa hanya
   title/role/status/percent (SessionManager.ts:970-973).
3. **Cap baris** — `rows.slice(0, MAX_BOARD_ROWS)` (40), dengan `sort` mendahulukan tree SENDIRI supaya
   data yang relevan tak terpotong lebih dulu (SessionManager.ts:982-984).
4. Redaksi lama untuk sibling sepohon saat pemanggil SUB tetap berlaku (SessionManager.ts:977-979).
5. **mcpTools.ts:169** deskripsi tool `read_board` diselaraskan: "all" root-only, tree lain status-saja,
   sub yang minta "all" dilayani sebagai "tree", hasil dibatasi.

Bentuk return type TIDAK berubah → tak ada perubahan kontrak ke pemanggil.

---

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**.
- `npm run build` → **exit 0** (main 116.23 kB, preload 2.06 kB, renderer css 20.42 kB / js 39.07 kB).
- Tidak menjalankan dev/start/dist/restart.
- Scope dipatuhi: hanya `SessionManager.ts` & `mcpTools.ts` yang saya ubah pada tugas ini.
  `injectAutoTask` yang tersisa (SessionManager.ts:349, :399) = nota ganti-akun/limit — memang bukan jalur
  laporan worker, sengaja dibiarkan.

## Risiko / catatan
- Laporan progres (non-selesai) kini sampai ke parent **maksimum ~12 dtk lebih lambat**. Disengaja: itu
  harga dari menghapus pengali giliran. Laporan SELESAI tetap ~800 ms.
- Jika parent terus-menerus `running`, flush mundur per 12 dtk sampai parent idle — laporan menumpuk
  (ter-dedupe per worker) dan dikirim sekaligus, tidak hilang.
- `lastReportSig` hanya menyimpan flush terakhir per parent (bukan riwayat) → aman dari pertumbuhan memori.
- Cap 40 baris `read_board`: dengan 17 sesi saat ini belum memotong apa pun; tree asing sudah ringkas
  sehingga payload turun drastis walau jumlah sesi bertambah.
