# Fix 2 Bug UI State (renderer) — 2026-07-20

Semua perubahan di renderer (`src/renderer/main.ts` + `styles.css`). **Session.ts TIDAK disentuh** — sisi
main sudah benar per-sesi. Verifikasi: `npx tsc --noEmit -p tsconfig.json` → exit 0; `npm run build` → exit 0.

---

## BUG 1 — Kedip "butuh jawaban" hilang di sesi LAIN saat satu sesi dijawab

### Root cause (RENDERER, bukan main)
Kandidat (d) dari brief: **full re-render membangun ulang kartu tanpa membawa state per-kartu.**

- Sisi main (`Session.ts:855-859` `setAwaitingInput`) dan handler `session:update`
  (`main.ts` `onEvent`) SUDAH per-id: tiap emit hanya membawa `id` sesi ybs, dan
  `updateNodeVisual(id)` (`main.ts:722`) hanya menyentuh kartu id itu. Jadi jalur *incremental* benar.
- Biang di `renderNode` (`main.ts` ~636): saat membangun `<div class="node …">` kelasnya hanya
  `node[ child][ active]` — **tidak menyertakan `awaiting-input` / `api-stopped`**. State datanya
  (`node.awaitingInput`) tetap utuh di map `nodes`, tapi kelas DOM-nya hilang.
- `renderTree()` (rebuild penuh) dipanggil pada `session:new`, `session:removed`, dan reorder —
  yang RUTIN terjadi tepat setelah user menjawab satu sesi (pohon berubah / sub-worker muncul).
  Rebuild itu menghapus `.awaiting-input` dari SEMUA kartu sekaligus; hanya kartu yang kebetulan
  menerima `session:update` berikutnya (mis. sesi yang dijawab → jadi running) yang dapat kelasnya
  kembali. Sesi lain yang masih menunggu kehilangan kedip walau belum dibalas → persis gejalanya.

### Fix
`renderNode` kini memetakan ulang state per-kartu ke kelas saat rebuild:
`…${node.awaitingInput ? ' awaiting-input' : ''}${node.apiStopped ? ' api-stopped' : ''}${drafts.has(node.id) ? ' has-draft' : ''}`.
Kedip/stop/draft kini bertahan melewati `renderTree()`. Sesi yang masih menunggu TETAP berkedip
sampai masing-masing dijawab; hanya sesi yang benar-benar mulai turn baru (`beginTurn` → `setAwaitingInput(false)`)
yang berhenti. (`api-stopped` yang punya bug laten sama ikut terperbaiki.)

---

## BUG 2 — Compose box global → per-sesi

### Root cause
`chat-input` (textarea) + global `pendingImages` / `pendingRefs` dipakai bersama semua sesi.
`selectSession` tidak pernah menyimpan/memuat draft, jadi teks & lampiran satu sesi terlihat &
terkirim di sesi lain.

### Fix (draft per-sessionId)
- Store baru: `const drafts = new Map<string, {text, images, refs}>()` — **hanya berisi draft sesi NON-aktif**;
  draft sesi aktif "hidup" di textarea.
- `saveDraft(id)` / `loadDraft(id)`: saat `selectSession` pindah sesi (dan HANYA saat ganti sesi,
  bukan re-select yang sama) → simpan draft sesi lama (teks + `pendingImages` + `pendingRefs`), lalu
  muat draft sesi baru ke textarea (kosong bila belum ada) + `autoGrow` + `renderAttachStrip`.
  `loadDraft` mengeluarkan entri dari map (jadi ✎ hanya tampil di sesi non-aktif).
- **Kirim pasti ke sesi terpilih**: `doSend` memakai `targetId = activeId` saat tombol/Enter ditekan
  (jalur lama, tak berubah), lalu `drafts.delete(targetId)` setelah target ditentukan → draft sesi itu
  dibuang begitu terkirim.
- `applyRemoved` → `drafts.delete(id)` saat sesi dihapus (anti-bocor & anti-leak).

### Lampiran (gambar + referensi) IKUT per-sesi — YA
`pendingImages` & `pendingRefs` masuk ke objek draft & di-restore per sesi. Menempel/drag gambar atau
referensi masuk ke draft sesi aktif; pindah sesi menyimpan/memuatnya. Jadi lampiran satu sesi TIDAK
terkirim ke sesi lain.

### Indikator draft (poin opsional #3)
Kartu sesi non-aktif yang punya teks/lampiran belum terkirim diberi tanda `✎` kecil
(`.node.has-draft .node-title::after`, warna `--accent-2`). Minimal, tidak berlebihan; bertahan
melewati rebuild karena `has-draft` ikut dipetakan di `renderNode` + `updateNodeVisual`.

---

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**
- `npm run build` (electron-vite) → **exit 0** (main/preload/renderer semua ter-bundle)
- Tidak restart/dev/dist (sesuai instruksi).
