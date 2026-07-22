# Grove — FIX biaya AUTO-CHECK berkala (`runLoopCheck`)

Tanggal: 2026-07-20. Acuan: `_grove_autocheck_DIAG.md`. Scope edit: **hanya**
`src/main/orchestrator/SessionManager.ts` (`Session.ts` TIDAK perlu disentuh).
Verifikasi: **`npx tsc --noEmit -p tsconfig.json` exit 0** + **`npm run build` exit 0**. App tak di-restart.

Prinsip: yang mahal adalah **JUMLAH GILIRAN root** (tiap tick = transkrip root dibaca ulang,
~7rb token @ctx35% window 200k / ~35rb @1M), **bukan** teks ping (~200-450 token). Maka semua fix di
sini menekan jumlah tick yang benar-benar mengirim giliran. Teks ping **tidak** diperkecil (sia-sia),
interval **tidak** dinaikkan melewati TTL cache 1 jam.

---

## FIX #2 (paling penting) — SIGNATURE STABIL: menutup jalur biaya TAK TERBATAS

**Masalah:** deteksi `unchanged` memakai `treeBoardSummary(rootId)` yang menyertakan **baris ROOT
sendiri** + field volatil (`title`). Begitu root membalas ping lalu `update_summary`/`set_title`/
`assign_worker`, signature berubah → `streak` reset ke 0 → auto-stop 3-strike **tak pernah tercapai**
→ loop bisa jalan selamanya (144 tick/hari/root).

**Fix — SessionManager.ts:699-715** method baru `subBoardSignature(rootId)`:
```ts
this.metaSnapshot()
  .filter((m) => m.treeId === rootId && m.role === 'sub')   // baris SUB saja — root DIKECUALIKAN
  .map((m) => `${m.id}|${m.status}|${b?.percent ?? ''}|${b?.progress ?? ''}`)  // field stabil saja
  .join('\n')
```
- Urutan deterministik (`metaSnapshot()` sudah urut `createdAt`), dikunci per `m.id`.
- `title` & baris root **tidak** ikut → aksi root atas ping-nya sendiri **tidak bisa** me-reset streak.
- Dipakai di **SessionManager.ts:669** (`const sig = this.subBoardSignature(rootId)`), menggantikan
  `treeBoardSummary` untuk keperluan signature. (`treeBoardSummary` TETAP dipakai untuk isi ping &
  `compactSession` — tak diubah.)
- Komentar field **SessionManager.ts:62-66** diperbarui: `lastLoopSummary` kini menyimpan signature.

**Efek:** 3-strike jadi **deterministik** → loop **pasti** berhenti. Ini menghapus sumber biaya
tak-terbatas, bukan sekadar mengurangi.

## FIX #1 — SKIP PING SAAT `unchanged` (dengan 1 pengulangan wajib)

**Masalah:** `unchanged` dulu hanya menaikkan streak, **tidak** mencegah ping → pada tree diam,
tick 2 & 3 mengirim giliran root ber-payload **byte-identik**.

**Fix — SessionManager.ts:688-693:** `} else if (streak <= 1) { root.autoCheck(...) }`
- `streak 0` (ada perubahan / tick pertama) → **FIRE**.
- `streak 1` (unchanged pertama) → **FIRE** — pengulangan yang **WAJIB** dipertahankan: worker yang
  MANDEK justru **tidak** mengubah board, jadi kalau semua tick unchanged di-skip, kasus mandek tak
  akan pernah terkejar. Ini juga jadi retry bila root gagal menindak ping pertama.
- `streak ≥ 2` → **SKIP** (murni redundan; root sudah 2× diberi tahu state yang sama).
- `streak ≥ 3` → `stopLoop` + systemNote (cabang lama, tak diubah).

## FIX #3 — STOP saat SEMUA sub `done` (bedakan tuntas vs mandek)

**Masalah:** `anyStalled = subs.some(s => s.status !== 'running')` menganggap sub ber-status **`done`**
sebagai "stalled", sehingga tree yang seluruh workernya SUDAH SELESAI tetap dipingg berulang.

**Fix — SessionManager.ts:657-666:**
```ts
const stalled  = subs.filter((s) => s.meta.status !== 'running' && s.meta.status !== 'done')
const allDone  = subs.length > 0 && subs.every((s) => s.meta.status === 'done')
const worthAsking = subs.length > 0 && (stalled.length > 0 || allDone)
```
**Cara membedakan (hati-hati, ini yang rawan regresi):**

| Status sub | Arti | Perlakuan |
|---|---|---|
| `running` | sedang kerja | jangan tanya |
| `done` | **benar-benar tuntas** (`markDone()` / `report_to_parent` 100%) | boleh berhenti |
| `idle` | tak jalan **tapi belum tuntas** = **MANDEK** | **TETAP dikejar** (tujuan asli auto-check) |
| `error` | tak jalan & bermasalah | **TETAP dikejar** (butuh perhatian) |

- `allDone` → **SATU ping penutup** (ajak sintesis akhir + `task_done`), dijaga
  `loopDonePinged` (**:68**, set **:684-686**) agar tidak berulang; tick berikutnya **diam** sementara
  streak tetap naik → loop berhenti sendiri lewat cabang `IDLE_CHECK_LIMIT`.
- `loopDonePinged` di-reset saat keadaan berubah (**:663**, `if (!allDone)`) dan saat tugas baru
  (`enableLoop`, **:617**) → kalau kerja berlanjut, auto-check kembali normal (tak ada regresi deteksi mandek).
- **Bonus:** kombinasi baru juga melewati kasus "sebagian sub `done`, sisanya `running`, tak ada yang
  mandek" (dulu tetap ping karena `done !== running`).

## Interval: TETAP 10 menit (tidak diubah)

`LOOP_INTERVAL_MS = 10 * 60_000` (**SessionManager.ts:31**) **dibiarkan**. Alasan: fix #1-#3 sudah
memangkas biaya utama; menaikkan interval memperlambat deteksi worker mandek, dan menaikkannya melewati
**60 menit** akan menembus TTL cache 1 jam (CLI meminta `ttl: "1h"`) sehingga tiap tick jadi cache-MISS
dan total biaya justru NAIK (42rb → 87rb token/jam). Sesuai instruksi: ragu → biarkan 10 menit.

---

## Perilaku SEBELUM vs SESUDAH (tree yang diam, `IDLE_CHECK_LIMIT = 3`)

| Tick | SEBELUM | SESUDAH (worker MANDEK) | SESUDAH (semua sub `done`) |
|---|---|---|---|
| 1 | FIRE | **FIRE** | **FIRE** (ping penutup) |
| 2 | FIRE (byte-identik) | **FIRE** (retry wajib) | diam |
| 3 | FIRE (byte-identik) | diam | diam |
| 4 | stopLoop | **stopLoop** | **stopLoop** |
| **Total giliran** | **3** | **2** | **1** |
| **Bila signature ter-reset** | **∞ (tak pernah berhenti)** | **mustahil** (signature stabil) | **mustahil** |

**Estimasi penghematan per periode diam, per root** (ctx 35%):
- Kasus mandek: 3 → 2 giliran = **−33%** (~7rb token @200k, ~35rb @1M).
- Kasus tree selesai: 3 → 1 giliran = **−67%** (~14rb token @200k, ~70rb @1M).
- Kasus signature dulu ter-reset terus (skenario paling mahal & paling mungkin menurut diagnosa):
  dari **tak terbatas** (≈144 tick/hari ≈ 1,0 juta token/hari @200k, ≈5,0 juta @1M) menjadi **maks 2
  giliran lalu berhenti** → penghematan praktis mendekati **−99%** pada tree yang ditinggal diam.

## INVARIAN yang dijaga (tidak regresi)
- **Root tetap tahu ada worker mandek:** ping pertama + satu pengulangan tetap dikirim; sub `idle`/`error`
  tak pernah dianggap selesai.
- **`task_done` → `stopLoop`** (SessionManager.ts:706-712 area) — tidak disentuh.
- **`scheduleRootStatus`** (ping `[GROVE AUTO]`) — tidak disentuh.
- **Coalesce `autoReportFinal`/`queueParentReport`** (fix token sebelumnya) — tidak disentuh.
- **`treeBoardSummary`** tetap dipakai apa adanya untuk isi ping & `compactSession`.
- Kebersihan: `loopIdleStreak` / `lastLoopSummary` / `loopDonePinged` dibersihkan saat sesi dihapus
  (**SessionManager.ts:751-753**) — sekaligus menutup sisa state lama yang sebelumnya tak dibersihkan.

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**.
- `npm run build` → **exit 0** (main 120.72 kB; renderer ikut hijau meski sedang diedit worker lain).
- Tidak menjalankan dev/start/dist/restart. Tidak ada file di luar scope yang diubah.
