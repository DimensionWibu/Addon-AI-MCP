# Grove — Diagnosa kebocoran konteks lintas-project + boros token (READ-ONLY, tanpa edit kode)

Tanggal: 2026-07-20. Keluhan: sesi yang mestinya bekerja di `E:\Addon DN\fast-dana-new juni\apps`
ternyata "tahu" scope project lain (`multiip-web`: IPv6 carrier/NAT64, Telkomsel, 192.168.1.222).

> Sudah terbukti sebelumnya & TIDAK diulang di sini: transkrip TIDAK menyatu (spawn `resume:undefined`
> + `randomUUID`, query SQLite ketat `WHERE session_id=?`, tiap Session punya inbox/history/q/meta sendiri).
> Dokumen ini mencari sumber kebocoran LAIN — dan menemukannya.

---

## VERDICT: (a) — memori/CLAUDE.md global termuat di SEMUA sesi karena `cwd` SAMA

Bukan transkrip yang menyatu. Yang menyatu adalah **IDENTITAS PROJECT**: semua sesi Grove
berjalan di `cwd` yang sama, sehingga Claude Code menganggapnya SATU project dan memuat
**satu direktori memory yang sama** ke setiap sesi.

### Rantai bukti

**1. "+ Chat" mem-hardcode satu folder scratch bersama** — `src/main/ipc.ts:16-20`
```ts
ipcMain.handle('grove:newChat', (_e, { title }) => {
  const scratch = join(app.getPath('userData'), 'scratch')   // SAMA untuk SEMUA chat
  if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true })
  return manager.createRoot(scratch, title || 'Chat baru')
})
```

**2. cwd itu menurun ke seluruh pohon**
- `SessionManager.ts:64-78` `createRoot(cwd)` menyimpan cwd ke meta.
- `SessionManager.ts:98` `cwd: parent.meta.cwd` — worker mewarisi cwd parent.
- `Session.ts:385` `cwd: this.meta.cwd` — diteruskan ke opsi `query()` SDK.

**3. BUKTI LIVE dari DB (`%APPDATA%\grove\grove.sqlite`)** — `SELECT cwd, COUNT(*) GROUP BY cwd`
mengembalikan **tepat SATU baris**:

| cwd | jumlah sesi |
|---|---|
| `C:\Users\fastpanel\AppData\Roaming\grove\scratch` | **17** |

**17 sesi / 4 tree — 100% memakai cwd yang sama. NOL sesi memakai folder project.**
Padahal judulnya lintas-project: *Diagnose DanaZ Proxy Check Failure*, *Debug ForgotPin reset stuck*,
*Deploy NEED_PASSKEY CheckBalance* (fast-dana/DANA) berdampingan dengan *Fix LAN client not detected*,
*Investigasi LAN metrics ethernet*, *Proxy Scheme Selector* (multiip-web) dan *Local GLM AI App* (GLM).

**4. Satu cwd → satu project slug → satu memory dir bersama**
Claude Code menurunkan direktori memory dari cwd:
`C:\Users\fastpanel\.claude\projects\C--Users-fastpanel-AppData-Roaming-grove-scratch\memory\`
→ **15 file, 62.141 B**, di antaranya **5 file multiip-web** (`multiip-web-modem-source-tahapB.md`
11.227 B, `multiip-web-ipv6-dependency.md` 4.520 B, `multiip-web-features-scale.md`,
`multiip-web-err-at-scale-fix.md`, `multiip-web-eth-lan-metrics.md`) + `coolify-multiip-deploy.md`.

**5. `MEMORY.md` (6.071 B) disuntik ke system prompt SETIAP sesi — terverifikasi langsung**
Sesi worker ini sendiri (yang tugasnya Grove, bukan multiip-web) memuat `MEMORY.md` itu verbatim
di system prompt-nya, di bawah blok `# claudeMd`, dengan path slug scratch di atas.

**6. Kecocokan TEKSTUAL dengan keluhan user** — isi `MEMORY.md` yang ikut termuat:
- baris 4: `… Coolify (SSH **192.168.1.222**, token+helper di …)` → keluhan "192.168.1.222"
- baris 6: `ethernet/**NAT64** pull needs carrier global **IPv6** /64 … **Telkomsel** IPv4-only`
- baris 7: `**NAT64** discovery RFC7050 … egress **Telkomsel** asli`

Persis istilah yang user sebut. Jadi sesi fast-dana "tahu" multiip-web **bukan** karena transkrip
tercampur, melainkan karena ia membaca index memori project-scratch yang memuat semuanya.

### Apakah "+ Folder" benar-benar mengubah cwd? YA — tapi tak pernah terpakai
- `ipc.ts:23-27` `grove:pickFolder` → `showOpenDialog` → `createRoot(r.filePaths[0])` — cwd asli.
- `ipc.ts:9-13` `grove:dropFolder` (drag-drop) → `createRoot(dir)` — cwd asli.

Jadi "+ Folder" bukan sekadar label/grouping; ia sungguh menetapkan cwd sesi. Masalahnya: jalur
DEFAULT ("+ Chat") menyalurkan semua sesi ke satu scratch, dan bukti DB menunjukkan **tidak ada satu
pun sesi** yang dibuat lewat "+ Folder". Selain itu cwd tidak bisa diubah lagi setelah sesi dibuat.

### Temuan tambahan: `excludeDynamicSections` tidak mencapai tujuannya
`Session.ts:393-395` berkomentar bahwa flag ini membuang "auto-memory MEMORY.md + working-dir +
git-status". Kenyataannya system prompt sesi ini MASIH memuat index `MEMORY.md`, `# Environment`
(Primary working directory), dan `# currentDate`. Artinya index memori TIDAK datang lewat "dynamic
sections", melainkan lewat kanal claudeMd/settings yang tak disentuh flag ini.
Perlu dicatat pula: **`settingSources` TIDAK PERNAH di-set** di seluruh `src/` — ia hanya disebut
dalam komentar `Session.ts:394`. Jadi perilaku pemuatan CLAUDE.md/memori mengikuti default SDK,
bukan pilihan eksplisit Grove.
(Caveat jujur: bukti ini dari system prompt sesi yang berjalan di build Grove yang ter-install
sekarang; namun path memory dir tetap membuktikan cwd = scratch.)

---

## (b) `read_board` scope "all" — kanal kebocoran NYATA, tapi sekunder

- `mcpTools.ts:167-175`: scope `'all'` terbuka untuk **setiap** sesi, **tanpa gate** — deskripsinya
  hanya mengimbau "use sparingly".
- `SessionManager.ts:789`: `return scope === 'all' ? true : m.treeId === callerTree` — tak ada cek izin.
- Mitigasi yang SUDAH ada (`SessionManager.ts:797-799`): bila pemanggil **sub**, entri sesi lain
  diredaksi → `summary:'(sesi lain — awareness saja…)', todo:[], progress:''`.
- **Lubangnya:** pemanggil **root** menerima board PENUH SEMUA tree lintas project (summary ≤600,
  todo ≤12×100, progress ≤200 per sesi). Dan `title`/`treeId`/`role`/`status` (`:793`) selalu
  terekspos ke SIAPA PUN termasuk sub — nama project bocor lewat judul.
- Perkiraan payload: 17 sesi × ~2 KB ≈ **~34 KB ≈ ~9.000 token** dalam SATU panggilan → nyata berpotensi
  membanjiri konteks pemanggil root.

**Tapi ini bukan penyebab keluhan user:** read_board tidak memuat detail teknis seperti
"RFC7050"/"NAT64 prefix"; detail itu hanya ada di `MEMORY.md`. Kanal (b) = risiko terpisah.

## (c) Overlap domain yang sah — TIDAK cukup menjelaskan
fast-dana memang memakai proxy dari multiip-web, jadi sebagian overlap wajar. Tapi istilah spesifik
(`192.168.1.222`, `NAT64/RFC7050`, `Telkomsel IPv4-only`) muncul VERBATIM di `MEMORY.md` yang
termuat otomatis. Jadi penjelasannya (a), bukan (c).

---

## (4) Yang terkirim ulang TIAP GILIRAN ke TIAP sesi

Diukur dari sumber (perkiraan token ≈ byte/3.6):

| Komponen | Ukuran | ~token | Catatan |
|---|---|---|---|
| **`MEMORY.md` (index memori)** | **6.071 B** | **~1.686** | **63%** dari preamble yg dikendalikan Grove — DAN sumber kebocoran |
| `GROVE_COMMON` + `GROVE_ROOT` | 3.981 B | ~1.106 | sesi root |
| `GROVE_COMMON` + `GROVE_SUB` | 2.480 B | ~689 | sesi sub |
| `CLAUDE.md` global | 1.068 B | ~297 | generik, tak memuat detail project |
| **Total preamble tetap (SUB)** | 9.619 B | **~2.672** | di LUAR preset `claude_code` + skema tool |
| **Total preamble tetap (ROOT)** | 11.120 B | **~3.089** | idem |

Yang **paling besar & paling sia-sia: `MEMORY.md`** — 63% dari preamble, mayoritas isinya project
yang TIDAK relevan bagi sesi bersangkutan.

**Sudah efisien (bukan masalah):** `treeBoardSummary` (`SessionManager.ts:755-764`) — 1 baris/sesi,
dipotong 220 char, hanya se-pohon. Cap di `mcpTools.ts:43-48` juga ditegakkan sungguhan.

**Pemboros DOMINAN yang sebenarnya — jumlah GILIRAN, bukan besar teksnya:**
`injectAutoTask` membuat **giliran BARU**, dan tiap giliran baru menagih ulang SELURUH konteks
sesi yang sudah menumpuk:
- `SessionManager.ts:751` `autoReportFinal` → tiap worker menutup turn, parent disuntik snippet ≤700 char.
- `SessionManager.ts:800` ping `[GROVE AUTO]` ke root tiap worker melapor.
- `SessionManager.ts:584` `autoCheck` `[GROVE AUTO-CHECK]` berkala.

Dengan N worker aktif, root bisa mendapat N giliran ekstra per ronde — masing-masing memproses ulang
konteks root yang terus membesar. Ini pengali biaya terbesar, jauh di atas teks board itu sendiri.
Peredam yang SUDAH ada: dedupe `lastPingSummary` (`:798-799`), `IDLE_CHECK_LIMIT` (`:577-583`),
debounce `rootStatusTimers` (`:42`).

---

## USULAN FIX (belum diimplementasikan — sesuai instruksi)

**Prioritas 1 — cwd/project per sesi (memperbaiki kebocoran DAN 63% preamble sekaligus)**
- Hentikan "+ Chat" memakai satu scratch bersama. Pilihan: (i) beri tiap root **subfolder scratch
  sendiri** (`scratch/<rootId>`) → slug project berbeda → memory terisolasi otomatis, atau
  (ii) minta user memilih folder project saat membuat chat.
- Tampilkan cwd di kartu sesi & izinkan **mengubah cwd** sesi yang sudah ada (sekarang tak bisa).
- Karena direktori memory diturunkan dari cwd, memperbaiki cwd otomatis men-scope memori per project —
  tanpa perlu mekanisme memori baru.

**Prioritas 2 — kendalikan pemuatan setting secara eksplisit**
- Set `settingSources` secara EKSPLISIT di opsi `query()` (kini tak pernah di-set) supaya jelas
  CLAUDE.md/memori mana yang boleh masuk; jangan bergantung pada asumsi di komentar `Session.ts:394`.
- Verifikasi ulang klaim `excludeDynamicSections` — terbukti index `MEMORY.md` tetap termuat.

**Prioritas 3 — gate `read_board` scope "all"**
- Batasi `'all'` hanya untuk `role === 'root'` (atau flag yang dinyalakan user).
- Redaksi tree LAIN untuk SEMUA pemanggil (kini hanya untuk sub) — untuk tree asing kembalikan
  `title`+`status` saja, tanpa summary/todo/progress.
- Beri batas jumlah baris + total char (pakai `cap()` yang sudah ada) agar tak membanjiri konteks.

**Prioritas 4 — pangkas preamble & giliran**
- Setelah cwd terisolasi, `MEMORY.md` mengecil dengan sendirinya (hanya memori project itu).
- Ringkas `GROVE_ROOT` (~1.106 tok) — banyak kalimat prosedural yang bisa dipadatkan.
- Gabungkan beberapa laporan worker menjadi SATU giliran root (coalesce dalam jendela waktu)
  alih-alih satu giliran per worker.
