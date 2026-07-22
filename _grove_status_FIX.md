# Grove — Changelog fix indikator status `done` & `error`

Tanggal: 2026-07-20. Dasar: `_grove_status_DIAG.md`. Scope edit: **HANYA**
`src/main/orchestrator/Session.ts` + `src/main/orchestrator/SessionManager.ts`.
Renderer/CSS TIDAK disentuh (sudah benar: `dot s-${status}` main.ts:496/531, `.s-*` styles.css).
`awaitingInput` tidak disentuh.

Verifikasi: **`npx tsc --noEmit -p tsconfig.json` → PASS (exit 0)**, **`npm run build` → PASS (exit 0)**.
App TIDAK di-restart (hanya compile).

---

## Masalah ordering yang ditemukan saat implementasi (penting)
`task_done` (root) dan `report_to_parent(percent=100)` (sub) dipanggil sebagai **tool DI TENGAH turn**.
Kalau `markDone()` langsung `setStatus('done')` saat itu, handler `'result'` di akhir turn akan
menimpanya kembali jadi `'idle'` → fix tak terlihat. Selain itu dot akan "hijau" padahal sesi masih
bekerja. Solusi: `markDone()` menyetel **flag `doneMarked`**, dan handler `'result'` yang memutuskan
status akhir turn.

## 1) FIX `done`
- **Session.ts:350** field `private doneMarked = false`.
- **Session.ts:641** method baru `markDone()`:
  - set `doneMarked = true`; **TIDAK** memanggil `inbox.close()` (beda dari `stop()`) → sesi tetap
    hidup & bisa menerima tugas baru.
  - `setStatus('done')` LANGSUNG hanya bila `status !== 'running'` (tak ada turn jalan); kalau sedang
    running, penerapannya ditunda ke akhir turn.
  - guard `if (this.stopped) return`.
- **Session.ts:511** `beginTurn()` reset `doneMarked = false` → tugas/pesan baru mengembalikan sesi ke
  running/idle (choke-point yang sama dipakai `awaitingInput`).
- Pemanggil:
  - **SessionManager.ts:549** `taskDone()` — setelah `stopLoop(sessionId)` panggil `s.markDone()`
    (root). `stopLoop` tetap jalan lebih dulu → alur auto-check tak berubah.
  - **SessionManager.ts:627** `reportToParent()` — saat `percent >= 100`, selain `markFinalReported()`
    kini juga `from.markDone()` (sub).

## 2) FIX `error`
- **Session.ts:996-1003** handler `'result'`: ganti `setStatus('idle')` tanpa syarat menjadi keputusan
  status akhir turn:
  ```
  const failed = !!subtype && subtype !== 'success'
    && !this.apiBlockPending && !this.limitHitPending && !this.interrupting
  this.setStatus(failed ? 'error' : this.doneMarked ? 'done' : 'idle')
  this.emitActivity(failed ? 'error' : this.doneMarked ? 'selesai' : 'idle')
  ```
- Pesan sistem ramah yang sudah ada (Session.ts:967-972) **dipertahankan apa adanya**.
- Pengecualian dijaga agar TIDAK jadi 'error' palsu:
  - `interrupting` → Stop / Stop All / compact / ganti akun tetap berakhir `'idle'`.
  - `limitHitPending` → tetap lewat `onLimitHit` → `markLimited()` (Session.ts:742) yang set 'error' sendiri.
  - `apiBlockPending` → tetap lewat `handleApiBlock()` (recycle → 'running', atau 3× → 'error' + apiStopped).
- `consume()` catch (Session.ts:658) dibiarkan — sudah `setStatus('error')`.

---

## Catatan risiko / perilaku
1. **`done` persist di DB.** `normalizeStaleStatuses()` hanya menormalkan `running`/`waiting` → `idle`,
   jadi `done` bertahan lintas restart (tugas selesai tetap hijau). Dianggap benar.
   `autoResume` juga tak menyentuhnya (filter-nya hanya running/waiting) → sesi 'done' tak dibangkitkan.
2. **Auto-check loop tak berubah.** `runLoopCheck` memakai `status !== 'running'` untuk deteksi worker
   mangkrak; sub ber-status `done` diperlakukan sama seperti `idle` (perilaku lama) → tak ada regresi,
   dan untuk root loop-nya memang sudah di-`stopLoop` saat `task_done`.
3. **`stop()` tetap memakai `'done'`** (Session.ts:628) untuk sesi yang benar-benar ditutup/dihapus —
   tidak diubah. Jadi 'done' kini punya 2 sumber: tuntas (markDone, sesi hidup) & ditutup (stop).
4. **False-positive 'error' minimal**: hanya result non-sukses nyata yang lolos 3 pengecualian di atas.
   Sesi tetap bisa dilanjut (pesan berikutnya → `sendUserMessage` → `setStatus('running')`).
5. Tidak ada perubahan di renderer/CSS/mcpTools — `markDone()` dipanggil langsung dari SessionManager
   ke instance Session (bukan lewat interface GroveHost), jadi tak perlu menyentuh `mcpTools.ts`.

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**.
- `npm run build` → **exit 0** (main 104.19 kB, preload 2.06 kB, renderer css 20.42 kB / js 38.95 kB).
  Build juga meng-compile perubahan renderer worker lain tanpa konflik.
- Tidak menjalankan dev/start/dist/restart.
