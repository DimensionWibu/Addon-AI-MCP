# Grove — Gelombang 3: kunci folder kerja per-sesi (drag-drop) + badge folder + cleanup status mati

Tanggal: 2026-07-20. Verifikasi: `npx tsc --noEmit` **exit 0**, `npm run build` **exit 0**.
App live TIDAK di-restart/dev/dist.

---

## A) Drag-and-drop folder → kunci cwd sesi

### API Electron untuk path hasil drop
Electron terpasang: **43.1.1** (`package.json` `^43.1.1`). Sejak Electron 32 `File.path` **dihapus**,
jadi membacanya di renderer akan `undefined`. API yang benar — diverifikasi di
`node_modules/electron/electron.d.ts:19479` — adalah **`webUtils.getPathForFile(file): string`**.

Preload **sudah** meng-expose-nya sebelumnya (`src/preload/index.ts:6-7`), jadi renderer memakai
`window.grove.getPathForFile(file)` dan **tidak pernah** menyentuh `file.path`.
Untuk membedakan folder vs file dipakai `DataTransferItem.webkitGetAsEntry()?.isDirectory`;
validasi otoritatif tetap di main (`statSync().isDirectory()`).

### Backend
| Berkas | Baris | Perubahan |
|---|---|---|
| `src/shared/types.ts` | 172-174 | `GroveApi.setSessionCwd(id, path) => Promise<SessionMeta>` |
| `src/preload/index.ts` | 11 | expose `setSessionCwd` → `grove:setSessionCwd` |
| `src/main/ipc.ts` | 36-41 | handler IPC `grove:setSessionCwd` (tipis; validasi di manager) |
| `src/main/orchestrator/SessionManager.ts` | 7 | import `existsSync`, `statSync` |
| `src/main/orchestrator/SessionManager.ts` | 80-122 | method `setSessionCwd()` |

`setSessionCwd()` melakukan:
1. **Validasi** — sesi ada; path tidak kosong; `existsSync`; `statSync().isDirectory()`. Gagal →
   `throw` dengan pesan jelas (mis. `Bukan folder (drop sebuah FOLDER, bukan file): …`).
2. **No-op** bila cwd sudah sama.
3. **Persist** `meta.cwd` ke DB (`upsertSession`) → tahan restart.
4. **Emit** `session:update` dengan `cwd` → UI tersinkron tanpa rebuild pohon.

### Perilaku saat ganti folder di sesi yang SUDAH jalan
cwd sebuah sesi SDK **tidak bisa diubah di tempat**. Karena itu:

- **Sesi belum punya sesi SDK** (`meta.sdkSessionId` kosong) → cukup ganti `meta.cwd` + persist.
  Query pertamanya nanti langsung lahir dengan cwd baru. Nota: `📁 Folder kerja sesi ini diatur ke: …`
- **Sesi sudah punya sesi SDK** → dipakai mesin yang sudah ada `resetForNewTask()` (drop
  `sdkSessionId` + hentikan query lama) sehingga query BERIKUTNYA lahir dengan cwd baru.
  Konsekuensinya konteks lama dilepas — dan itu benar secara semantik: **ganti project = ganti
  konteks**. **Tidak dilakukan diam-diam** — ada nota sistem eksplisit di chat:
  > 📁 Folder kerja sesi ini dipindah ke: `<path>`
  > ⚠️ Karena folder project berubah, KONTEKS percakapan sebelumnya dilepas (ganti project = ganti
  > konteks). Pesan berikutnya mulai dari sesi bersih di folder baru.

Sub-worker yang **sudah jalan** sengaja TIDAK dipaksa ikut pindah (agar kerjanya tak terpotong);
sub-worker **baru** tetap mewarisi cwd parent lewat `spawnWorker` (perilaku existing, tak diubah).

### Renderer
| Berkas | Baris | Perubahan |
|---|---|---|
| `src/renderer/main.ts` | 465-560 | blok helper baru: `dragHasFiles`, `folderDropHandled`, `folderLabel`, `folderPathFromDrop`, `lockSessionToFolder`, `createSessionInFolder`, `setupSidebarFolderDrop` |
| `src/renderer/main.ts` | 597-611 | handler `dragover`/`dragleave`/`drop` pada KARTU sesi (+ kelas `.drop-folder`) |
| `src/renderer/main.ts` | 1218 | `setupSidebarFolderDrop()` dipanggil di `init()` |
| `src/renderer/main.ts` | 1186-1192 | handler drop global melewati bagian "jadikan referensi" bila drop sudah dimaknai sebagai folder |
| `src/renderer/main.ts` | 476 | teks empty-state menjelaskan drop folder |
| `src/renderer/styles.css` | 176-179 | `.node.drop-folder`, `.tree.drop-zone-active` (afordans drag-over) |

**Kenapa TIDAK memakai `stopPropagation`.** Handler drop global-lah yang membereskan overlay dan
counter `dragenter`/`dragleave`. Kalau propagasi dihentikan, overlay akan **nyangkut** menyala.
Solusinya flag `folderDropHandled`: handler global tetap jalan (bereskan overlay) tapi
**melewati** bagian "jadikan referensi". Reorder kartu memakai **pointer event**, bukan HTML5 drag,
jadi kedua mekanisme tidak bertabrakan.

**Tolak non-folder.** `folderPathFromDrop()` mengembalikan `null` bila tak ada satu pun entry
direktori → renderer langsung `alert('Drop sebuah FOLDER (bukan file) …')` tanpa round-trip.
Kalau `webkitGetAsEntry()` mengembalikan null (tak bisa dipastikan di renderer), path tetap dikirim
dan **main** yang menolak dengan pesan jelas.

---

## B) Badge folder di kartu sesi
`src/renderer/main.ts:640-646` menambah `<span class="node-cwd">` ke baris meta kartu:
- **Teks** = basename folder (mis. `📁 apps`).
- **Tooltip** = full path + petunjuk (`Folder kerja: <path>\n(drop sebuah folder ke kartu ini …)`).
- **Sesi scratch otomatis** → ditampilkan netral sebagai `📁 scratch`, **bukan** UUID panjang.
  Deteksi: basename cocok pola UUID **atau** bernama `scratch` (`folderLabel()`), jadi tidak perlu
  menanam path `%APPDATA%` di renderer.
- Badge ikut ter-update saat cwd berubah (`updateNodeVisual`, `main.ts:670-671`).
- Style: `src/renderer/styles.css:189-190` (`.node-cwd`, ellipsis, max-width 130px).

---

## C) Cleanup status `'waiting'` yang mati

Temuan yang dikonfirmasi: **tidak ada satu pun `setStatus('waiting')`** di seluruh kode — status itu
mati. Fitur "butuh jawaban" yang NYATA memakai flag `awaitingInput` (+ kelas `.awaiting-input`).

| Berkas | Baris | Perubahan |
|---|---|---|
| `src/shared/types.ts` | 4-8 | `'waiting'` dibuang dari `SessionStatus` (+ komentar alasan) |
| `src/main/orchestrator/db.ts` | 414-423 | helper baru `normalizeStatus()` |
| `src/main/orchestrator/db.ts` | 431 | `rowToSession` memakai `normalizeStatus(r.status)` |
| `src/main/orchestrator/db.ts` | 311-317 | komentar: `'waiting'` sengaja tetap di SQL pembersih |
| `src/main/orchestrator/SessionManager.ts` | 213-219 | filter autoResume → `status === 'running'` saja |
| `src/renderer/main.ts` | 690 | `updateNodeTime`: `active = status === 'running'` |
| `src/renderer/index.html` | 25 | swatch legenda `s-waiting` → `s-await` |
| `src/renderer/styles.css` | 199-202 | `.s-waiting` → `.s-await` (+ komentar) |

### Backward-compatibility (WAJIB, dan terpenuhi)
- **`normalizeStatus()`** memetakan legacy `'waiting'` → `'idle'` **saat baris dibaca**, dan nilai
  tak dikenal apa pun juga → `'idle'`. Baris DB lama tetap terbaca; app tidak gagal start; tidak
  ada sesi yang hilang.
- **`normalizeStaleStatuses()` tetap menyebut `'waiting'`** di SQL-nya secara sengaja, supaya baris
  lama ikut dibersihkan di DB dan tidak tertinggal selamanya.
- Tidak ada perubahan skema DB, tidak ada migrasi.

### Legend tetap ada & konsisten
Swatch **"butuh jawaban" tetap ada**, kini memakai `.s-await` dengan warna `var(--warn)` —
**persis sama** dengan kedip `.node.awaiting-input` (`styles.css:160-163`), sehingga legenda dan
kartu terbaca sebagai satu hal. Animasi `.dot.await-legend` (legendPulse) tidak berubah.

---

---

## D) REFINE — semantik per ZONA DROP

Revisi lanjutan: arti sebuah drop kini ditentukan **zona** tempat ia dilepas, dan user diberi tahu
akibatnya **sebelum** melepas.

### Bug yang ditemukan & diperbaiki saat refine: overlay menelan semua event drag
`.drop-overlay` adalah `position: fixed; inset: 0` **tanpa** `pointer-events`. Begitu overlay tampil
(dipicu `dragenter` pertama), ia menjadi elemen teratas sehingga **semua** `dragover`/`drop`
mendarat di overlay — `e.target` selalu overlay, dan handler pada kartu sesi **tak akan pernah
jalan**. Artinya fitur "drop folder ke kartu" dari gelombang sebelumnya praktis tidak berfungsi,
dan deteksi zona pun mustahil.

**Perbaikan:** `pointer-events: none` pada `.drop-overlay` (`styles.css:339-345`) — overlay jadi
murni visual, event turun ke elemen sebenarnya. Scrim juga diringankan `rgba(0,0,0,.85)` →
`rgba(0,0,0,.55)` supaya highlight zona terbaca.

### Deteksi zona
`zoneOf(e)` (`main.ts:498-501`): `(e.target as Element).closest('.sidebar')` → `'sidebar'`,
selain itu `'chat'`. Sederhana dan mengikuti DOM, bukan koordinat.

### Teks hint per zona (berubah saat hover)
`ZONE_HINT` (`main.ts:491-494`) + `applyZone()` (`main.ts:1247-1257`):

| Zona | Teks overlay | Highlight |
|---|---|---|
| `sidebar` (kolom SESSIONS) | `📁 Lepas FOLDER → kunci folder kerja sesi (fokus)` | `.sidebar.drop-target` outline `--accent-2` |
| `chat` (kolom percakapan) | `📎 Lepas file/folder → jadi referensi chat ini · gambar → lampiran` | `.chat.drop-target` outline `--accent` |

Panel target diangkat `z-index: 51` (di ATAS scrim) → zona aktif terlihat terang, zona lain redup.
Warna kotak hint juga ikut zona (`.drop-overlay[data-zone='sidebar'] .drop-inner`).
`<div class="drop-inner" id="drop-hint">` (`index.html:78-79`) supaya teksnya bisa diganti runtime.

### Perilaku per target
| Target drop | Akibat | Berkas |
|---|---|---|
| Kolom CHAT | file/folder → referensi chat; gambar → lampiran (perilaku lama, tak diubah) | `main.ts` handler drop global |
| Kartu **ROOT** | kunci cwd sesi (+ nota reset bila sesi sudah pernah jalan) | `main.ts:625-648` |
| Kartu **SUB** | **TIDAK** mengunci & **TIDAK** mereset — muncul petunjuk singkat yang menyebut judul root-nya dan mengarahkan user ke kartu UTAMA | `main.ts:625-648`, `rootTitleOf()` `main.ts:509-517` |
| Area KOSONG sidebar | sesi BARU terkunci di folder itu (jalur sama dgn "+ Folder") | `setupSidebarFolderDrop()` `main.ts:526-538` |
| File biasa (bukan folder) ke sidebar | ditolak: `Drop sebuah FOLDER (bukan file)…` | `folderPathFromDrop()` → `null` |

Kartu SUB memberi afordans **penolakan** saat drag-over (`.node.drop-reject`, merah +
`cursor: not-allowed`, `styles.css:180-181`) — user melihat "tidak boleh" sebelum melepas.

### Yang TIDAK diregresi
- Tetap **tanpa `stopPropagation`**; tetap memakai flag `folderDropHandled`. Handler drop global
  tetap satu-satunya yang membereskan overlay & counter `dragenter` (kini juga memanggil
  `clearDropAffordance()`), jadi overlay tak mungkin nyangkut.
- Reorder kartu tetap memakai **pointer event** — terpisah total dari HTML5 drag, tak bertabrakan.
- Validasi otoritatif tetap di main (`statSync().isDirectory()`); renderer hanya pra-deteksi
  (`webkitGetAsEntry().isDirectory`). Path tetap via `webUtils.getPathForFile` — **tidak pernah**
  `file.path`.
- `clearDropAffordance()` (`main.ts:503-507`) membersihkan highlight zona + semua kartu saat drop
  atau saat drag keluar jendela, sehingga tak ada highlight yang tertinggal.

`.tree.drop-zone-active` dihapus (sudah tak terpakai, digantikan `.sidebar.drop-target`).

---

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**
- `npm run build` → **exit 0**
- Output terkompilasi diperiksa:
  - `out/main/index.js`: `setSessionCwd` (3×), `normalizeStatus`, SQL `status IN ('running','waiting')` utuh
  - `out/preload/index.mjs`: `grove:setSessionCwd`
  - `out/renderer/assets/index-*.js`: `getPathForFile`, `webkitGetAsEntry`, `folderPathFromDrop`,
    `drop-folder`, `node-cwd`, `drop-zone-active`, `setSessionCwd`
  - `out/renderer/assets/index-*.css`: `s-await`/`node-cwd`/`drop-folder`/`drop-zone-active` ada,
    **`s-waiting` = 0** (benar-benar bersih)

## Risiko / catatan
- ~~Drop folder ke kartu SUB juga berlaku~~ → **SUDAH DIATASI di bagian D**: kartu SUB kini menolak
  drop (tak mengunci, tak mereset) dan hanya menampilkan petunjuk. Risiko salah-drop hilang.
- **Ganti folder pada sesi yang sudah jalan = konteks dilepas.** Ini disengaja & diberitahukan, bukan
  senyap — tapi tetap perubahan yang terasa bagi user.
- `webkitGetAsEntry()` hanya andal saat event `drop` (bukan `dragover`), jadi afordans drag-over
  bersifat netral ("ada file di-drag") dan penolakan non-folder terjadi saat drop.
- Fitur baru ini belum diuji di app live (dilarang restart). Perlu rebuild oleh user untuk mencobanya.
