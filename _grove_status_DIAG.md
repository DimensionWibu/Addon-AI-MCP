# Grove — Diagnosa indikator status kartu sesi (done / error / butuh-jawaban tak menyala)

Investigasi READ-ONLY (2026-07-20). Gejala: legend header punya 5 kategori
(`running`, `idle`, `done`, `error`, `butuh jawaban`). Dot kartu untuk `running`/`idle` benar,
tapi `done`, `error`, `butuh jawaban` TIDAK pernah aktif.

## Temuan kunci lebih dulu (bukan mismatch CSS)
- Enum status sah: `SessionStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error'`
  (**types.ts:4**). `done` & `error` SAH.
- Renderer memetakan status→class SAMA di dua tempat: `dot s-${node.status}` saat buat node
  (**main.ts:496**) & saat update (**main.ts:531**). CSS punya SEMUA lima kelas:
  `.s-running/.s-idle/.s-waiting/.s-done/.s-error` (**styles.css:167-171**), plus
  `--ok`/`--err`/`--warn` terdefinisi. ⇒ **TIDAK ADA mismatch nama class**; dot `s-done` (hijau)
  & `s-error` (merah) PASTI tampil BILA status-nya di-set. Jadi akar masalahnya di jalur ASSIGN
  status di main, bukan di CSS/renderer.
- Legend 5 dot di header (**index.html:20-24**) = **dekorasi statis** — tak terhubung ke state
  sesi mana pun. Indikator hidup = dot pada kartu (node), digerakkan `updateNodeVisual`.

---

## STATUS `done` → ROOT CAUSE (a): tak pernah di-assign saat SELESAI natural

- Akhir SETIAP turn (natural, termasuk selesai) → handler `'result'` memanggil
  **`setStatus('idle')` (Session.ts:974)** — SELALU idle, tak peduli sukses/tidak. Jadi sesi
  yang "selesai" balik ke **idle** (dot abu-abu), bukan `done`.
- Satu-satunya `setStatus('done')` ada di **`stop()` (Session.ts:628)**. `stop()` juga
  `inbox.close()` = menutup sesi permanen. Pemanggilnya:
  - `SessionManager.deleteSession` (**SessionManager.ts:568**) → tapi tepat setelahnya node
    dihapus dari UI (`session:removed`, **SessionManager.ts:574**) ⇒ dot `done` tak sempat terlihat.
  - `SessionManager.stopSession` (**SessionManager.ts:382-384**), diekspos IPC `grove:stopSession`
    (**ipc.ts:36**) TAPI **tak ada tombol UI yang memanggilnya** — tombol "⏹ Stop"
    (**index.html:50**) memanggil `interruptSession` (**main.ts:1142-1143**) → `interruptTurn()`
    → `setStatus('idle')` (**Session.ts:834**); "Stop All" juga lewat `interruptTurn` (idle).
- `mcp__grove__task_done` (root menandai tuntas) → **`SessionManager.taskDone` (SessionManager.ts:545-549)
  HANYA `stopLoop`**, TIDAK menyentuh status. Jadi walau tugas dinyatakan selesai, status tetap idle.

**Kesimpulan:** `done` praktis mati — completion natural→idle; satu-satunya penyetel (`stop()`)
bertepatan dengan penghapusan node atau lewat IPC yang tak dipakai UI. Klasifikasi **(a)**.

### Usulan fix `done`
- Wujudkan "selesai" sebagai `done` yang MASIH bisa dilanjut (jangan pakai `stop()` yang menutup):
  - Tambah method mis. `Session.markDone()` = `setStatus('done')` TANPA `inbox.close()`.
  - Root: di **`SessionManager.taskDone` (SessionManager.ts:545)** panggil status root → `done`
    setelah `stopLoop`.
  - Sub: saat worker lapor 100% — di jalur `markFinalReported`/`reportToParent` percent≥100
    (**SessionManager.ts:~619**) atau `notifyTurnEnd` — set status sub → `done`.
- Aman karena pesan berikutnya sudah `setStatus('running')` di `sendUserMessage`
  (**Session.ts:552**) → `done` otomatis kembali `running` saat ada tugas baru.

---

## STATUS `error` → ROOT CAUSE (a): jalur error UMUM justru di-set ke `idle`

- Error turn dari SDK datang sebagai `result` dengan `subtype !== 'success'` (mis. `max_turns`,
  `invalid_request`, `roles must alternate`, `refusal`, `overloaded/529`, `budget`). Handler-nya
  **mencatat pesan system ramah** (Session.ts:967-972) lalu **tetap `setStatus('idle')`
  (Session.ts:974)** — dot abu-abu, BUKAN merah.
- `setStatus('error')` HANYA di 3 jalur sempit:
  1. Exception tak-tertangkap di iterator `consume()` catch (**Session.ts:658**) — jarang
     (transport/throw), dan itu pun hanya kalau bukan apiBlock/limit/stopped.
  2. `markLimited()` (**Session.ts:742**) — limit & tak bisa auto-switch.
  3. Blokir API 3× (**Session.ts:790**) — tapi ini juga `setApiStopped(true)` (judul merah),
     jadi cue-nya lewat judul.
- Jadi permukaan error yang PALING SERING (result subtype≠success) sengaja jatuh ke `idle`
  ⇒ user "tak pernah" lihat dot merah dalam pemakaian normal. Bukan mismatch CSS (`.s-error` ada).

**Kesimpulan:** `error` under-assigned. Klasifikasi **(a)**.

### Usulan fix `error`
- Di handler `'result'` (**Session.ts:960-974**): untuk `subtype && subtype !== 'success'` yang
  BUKAN interupsi/limit/apiBlock (mereka punya penanganan sendiri), ganti tujuan status jadi
  `error`, bukan `idle`. Mis.:
  ```
  const bad = !!subtype && subtype !== 'success' && !this.apiBlockPending && !this.limitHitPending && !this.interrupting
  this.setStatus(bad ? 'error' : 'idle')   // ganti baris 974
  ```
  Tetap simpan pesan system ramah. `consume()` catch (658) biarkan (sudah 'error').
- `error` otomatis balik `running` saat pesan berikutnya (Session.ts:552). (Opsional: bila mau,
  bedakan "error tapi lanjutable" dari "berhenti".)

---

## STATUS `butuh jawaban` (awaitingInput) → ROOT CAUSE (c): BELUM LIVE (kode benar)

- Ini fitur BARU yang kita tambah, terpasang benar end-to-end:
  emit di `setAwaitingInput` (**Session.ts:751-755**) → `session:update {awaitingInput}`;
  payload di **types.ts:153**; type Node **main.ts:19**; toggle `.awaiting-input` **main.ts:533**;
  animasi kuning `@keyframes awaitBlink` + `.node.awaiting-input` **styles.css:149-159**.
  **Tidak ada bug wiring.**
- TAPI app yang SEDANG berjalan adalah proses electron LAMA (pra-fitur; build baru ada di `out/`
  tapi belum dijalankan — kita diminta TIDAK restart). ⇒ `awaitingInput` tak mungkin menyala
  sampai app **di-rebuild & DIRESTART** (`npm run dist` + relaunch, atau restart dev).
- Klasifikasi **(c) belum-live**. Setelah restart, ia akan bekerja (deteksi = heuristik akhir-turn
  `looksLikeAwaitingInput`, di-SET di handler `result` saat cleanEnd & inbox kosong).
- Catatan: `awaitingInput` runtime-only (tak dipersist; tak di `getSnapshot`/`TreeNode`) —
  disengaja; reset saat app restart. Tak memengaruhi keberfungsian dalam sesi.

### Bonus: status `waiting` (dot kuning `s-waiting`) juga mati
- Enum punya `'waiting'` & CSS `.s-waiting` (kuning) ada, TAPI **tak ada `setStatus('waiting')`
  di mana pun** (hanya di-normalisasi jadi idle saat load, `normalizeStaleStatuses`). Legend
  memakai `s-waiting` untuk label "butuh jawaban", padahal fitur nyata pakai class `.awaiting-input`
  (blink), bukan status `waiting`. Jadi dot `s-waiting` statis di legend tak mencerminkan state hidup.

---

## Ringkasan klasifikasi + fix
| Status | Root cause | Klasifikasi | Fix ringkas (file:line) |
|---|---|---|---|
| `done` | Selesai natural→idle; `done` cuma di `stop()` (nutup/hapus node); `task_done` tak set status | (a) | `taskDone` set root→done (SessionManager.ts:545) + sub→done saat 100% (SessionManager.ts:~619); tambah `Session.markDone()` tanpa `inbox.close()` |
| `error` | Result subtype≠success → `setStatus('idle')` (Session.ts:974); `error` cuma di jalur sempit | (a) | Di Session.ts:974 set `error` untuk non-success yg bukan interrupt/limit/apiBlock |
| `butuh jawaban` | Fitur baru, wiring benar, tapi app belum di-restart pakai build baru | (c) | Rebuild + restart app (`npm run dist`+relaunch). Tanpa bug kode |

Tidak ada mismatch nama class/CSS untuk ketiganya (semua `.s-*`/`.awaiting-input` ada). Akar
masalah `done`/`error` murni di sisi ASSIGN status (main); `butuh jawaban` murni belum-live.
