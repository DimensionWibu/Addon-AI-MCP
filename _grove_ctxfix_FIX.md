# Grove — FIX kebocoran konteks lintas-project (implementasi dari `_grove_contextleak_DIAG.md`)

Tanggal: 2026-07-20. Scope edit DIBATASI: hanya `src/main/ipc.ts` + `src/main/orchestrator/Session.ts`.
`SessionManager.ts` & `db.ts` TIDAK disentuh (sedang dikerjakan worker lain).

---

## FIX 1 — scratch UNIK per chat baru (akar kebocoran identitas project)

**File:** `src/main/ipc.ts:3` (import) dan `src/main/ipc.ts:16-28` (handler `grove:newChat`)

**Sebelum** — semua chat memakai SATU folder yang sama:
```ts
const scratch = join(app.getPath('userData'), 'scratch')
if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true })
return manager.createRoot(scratch, title || 'Chat baru')
```

**Sesudah** — tiap root chat dapat sub-folder unik:
```ts
const scratch = join(app.getPath('userData'), 'scratch', randomUUID())
mkdirSync(scratch, { recursive: true }) // recursive → induk ikut dibuat, dan aman bila sudah ada
return manager.createRoot(scratch, title || 'Chat baru')
```
+ `import { randomUUID } from 'node:crypto'` (`ipc.ts:3`).

**Kenapa ini menyelesaikan masalahnya.** Claude Code menurunkan identitas project — dan karenanya
direktori memori `~/.claude/projects/<slug-dari-cwd>/memory` — dari `cwd`. Karena dulu semua chat
ber-cwd sama, semuanya berbagi SATU `MEMORY.md`; itulah sebabnya index memori berisi entri
multiip-web (`192.168.1.222`, `NAT64`, `Telkomsel`) ikut termuat di sesi fast-dana. Satu folder unik
per root = satu slug project = memori terisolasi.

**Yang sengaja DIJAGA:**
- **Sesi lama tidak disentuh.** `cwd` mereka sudah tersimpan di DB dan tetap dipakai apa adanya —
  tidak ada migrasi, tidak ada perubahan skema, riwayat utuh, app tetap bisa start.
- **Sub-worker tetap mewarisi cwd parent** (`SessionManager.spawnWorker`, tidak diubah) → satu POHON
  = satu identitas project. Itu memang perilaku yang diinginkan.
- **Jalur "+ Folder" tidak diubah** (`ipc.ts:9-13` drag-drop, `ipc.ts:29-33` dialog) — keduanya sudah
  benar menetapkan cwd project asli.
- `mkdirSync(..., { recursive: true })` membuat folder induk sekaligus dan **tidak melempar error
  bila folder sudah ada**, jadi pengecekan `existsSync` tak lagi diperlukan di sini.
  (`existsSync` tetap dipakai oleh handler `grove:dropFolder`, importnya tetap terpakai.)

**Efek samping yang diterima:** folder scratch lama (`…\grove\scratch`) kini menjadi INDUK dari
sub-folder UUID yang baru. Sesi lama yang ber-cwd `…\grove\scratch` akan melihat sub-folder itu
sebagai subdirektori kosong di working dir-nya. Tidak merusak apa pun.

---

## FIX 2 — `settingSources` eksplisit + verifikasi `excludeDynamicSections`

**File:** `src/main/orchestrator/Session.ts:408-414` (koreksi komentar) dan `Session.ts:418-424`
(opsi baru), di dalam blok opsi `query()`.

### Temuan: `excludeDynamicSections` TIDAK PERNAH menjanjikan pembuangan memori
Dari tipe SDK yang benar-benar terpasang, `sdk.d.ts:1943-1947`:

> `{ type: 'preset', preset: 'claude_code', excludeDynamicSections: true }` — Strip per-user dynamic
> sections (working directory, auto-memory, git status) from the system prompt so it stays static and
> cacheable across users. **The stripped content is re-injected as the first user message so the model
> still has access to it.**

Jadi opsi ini **memindahkan**, bukan membuang: konten dinamis dikeluarkan dari system prompt lalu
**disuntikkan kembali sebagai pesan user pertama**. Tujuannya **cacheability**, bukan penyembunyian
memori. Ini menjelaskan persis temuan diagnosa (index `MEMORY.md`, `# Environment`, `# currentDate`
tetap terlihat) — itu perilaku BY DESIGN, bukan bug.

**Konsekuensi:** flag ini tidak bisa dan tidak boleh dipakai sebagai alat isolasi memori. Tidak ada
hack yang dipaksakan. Isolasi memori sepenuhnya ditangani FIX 1 (cwd per-tree). Flag tetap `true`
karena manfaat caching-nya tetap berlaku. Komentar lama yang menyesatkan ("Matikan blok dynamic…")
sudah dikoreksi di tempatnya.

### `settingSources` kini eksplisit
Sebelumnya opsi ini **tidak pernah di-set** di seluruh `src/` (hanya disebut dalam komentar).
Dari `sdk.d.ts:1874-1883`: bila dihilangkan, **semua** sumber dimuat (sama dengan default CLI);
`[]` mematikan setting filesystem; dan **harus memuat `'project'` agar berkas CLAUDE.md dimuat**
(`sdk.d.ts:1881`). Nilai sah: `'user' | 'project' | 'local'` (`sdk.d.ts:6538`).

```ts
settingSources: ['user', 'project', 'local'],
```

- `'user'` → `~/.claude/settings.json` — instruksi global user TETAP berlaku
- `'project'` → `.claude/settings.json` — WAJIB agar `CLAUDE.md` dimuat
- `'local'` → `.claude/settings.local.json`

**Ini bukan pemangkasan fitur.** Ketiga sumber = persis perilaku default lama; yang berubah hanyalah
kini **eksplisit dan terprediksi**, serta kebal terhadap perubahan default SDK di masa depan.
Sengaja **tidak** memakai `[]`: user memang menghendaki CLAUDE.md global + memori — yang tak
diinginkan hanyalah memori LINTAS-PROJECT, dan itu sudah diatasi FIX 1.

---

## Perilaku baru vs lama

| | Chat BARU ("+ Chat") | Sesi LAMA (sudah ada di DB) | "+ Folder" / drag-drop |
|---|---|---|---|
| cwd | `…\grove\scratch\<uuid>` (unik per root) | cwd lamanya, tidak diubah | folder project asli (tidak diubah) |
| Memori | terisolasi per pohon | tetap memakai memori scratch lama | per folder project |
| Sub-worker | mewarisi cwd parent | mewarisi cwd parent | mewarisi cwd parent |

Catatan: fix ini berlaku untuk chat yang dibuat SETELAH build baru dipakai. Sesi lama sengaja
dibiarkan apa adanya agar riwayat tidak hilang — bila user ingin sesi lama ikut bersih, cukup buat
chat baru.

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**
- `npm run build` → **exit 0**
- Output terkompilasi dicek: `out/main/index.js:2313-2317` memuat
  `join(app.getPath("userData"),"scratch",randomUUID())` + `mkdirSync(…,{recursive:true})`;
  `out/main/index.js:927` memuat `settingSources: ["user","project","local"]`.
- App live TIDAK di-restart/dev/dist (sesuai instruksi). Perlu rebuild oleh user agar aktif.
