# Grove — Fix "Claude Code native binary not found" di build TERPAKET

Tanggal: 2026-07-20. Investigasi + verifikasi oleh worker Grove.

## Gejala
Di app TERPAKET (electron-builder), setiap pesan gagal:
```
Claude Code native binary not found at
C:\Users\<user>\AppData\Local\Temp\<hash>\resources\app.asar.unpacked\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe.
Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.
```
Di DEV normal; hanya di app terpaket. (Path `Temp\<hash>\resources` = ekstraksi build **Portable**.)

## Root cause
Binary CLI Claude (`claude.exe`, ~256 MB) datang sebagai paket platform
`@anthropic-ai/claude-agent-sdk-win32-x64`, yang merupakan **optionalDependency** dari
`@anthropic-ai/claude-agent-sdk`. Dua syarat harus dipenuhi agar app terpaket bisa memakainya:

1. File .exe TIDAK boleh berada di dalam arsip `app.asar` — file di dalam asar tidak bisa
   dieksekusi sebagai proses. Ia harus di-`asarUnpack` ke `resources/app.asar.unpacked/...`.
2. SDK harus diarahkan ke lokasi unpacked itu (default resolusi SDK via `require.resolve`
   menunjuk ke dalam asar → tidak ada file nyata → "native binary not found").

Pesan error yang dilaporkan berasal dari **build LAMA yang dibuat SEBELUM fix** — pada build itu
`pathToClaudeCodeExecutable` belum di-set dan/atau binary belum ter-asarUnpack, sehingga SDK
menunjuk path app.asar.unpacked yang KOSONG.

## Status fix: SUDAH ADA di source (commit a76753b, 2026-07-19 16:59) — tidak perlu perubahan kode baru
Fix persis seperti rekomendasi task, dan sudah lengkap:

- **package.json → build.asarUnpack** memuat `node_modules/@anthropic-ai/**`
  → electron-builder menyalin `claude.exe` keluar dari asar ke `resources/app.asar.unpacked/...`.
- **src/main/orchestrator/Session.ts:26-40** `packagedClaudeExecutable()` menghitung
  `process.resourcesPath/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude.exe`,
  cek `existsSync`, lalu dialirkan sebagai `pathToClaudeCodeExecutable` ke `query()` di **Session.ts:393**.
  Di DEV path ini tak ada → `undefined` → SDK pakai resolusi bawaannya (require.resolve dari node_modules) → tetap jalan.

File:line kunci:
- `package.json` → `build.asarUnpack: ["node_modules/@anthropic-ai/**", "node_modules/sql.js/**"]`
- `src/main/orchestrator/Session.ts:26-40` (resolver `packagedClaudeExecutable` + `const CLAUDE_EXE`)
- `src/main/orchestrator/Session.ts:393` (`...(CLAUDE_EXE ? { pathToClaudeCodeExecutable: CLAUDE_EXE } : {})`)

Resolver ini COMMITTED (a76753b) dan tidak diubah oleh edit working-tree worker lain (hanya blok
opsi query di sekitarnya yang tersentuh; baris pathToClaudeCodeExecutable utuh).

## Verifikasi (dijalankan sekarang, working-tree terkini)
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**.
- `npm run build` (electron-vite build) → **exit 0**.
- `out/main/index.js` hasil build baru memuat resolver lengkap:
  `process.resourcesPath` (baris 559), `"app.asar.unpacked"` (564),
  `claude-agent-sdk-${process.platform}-${process.arch}` (567),
  `pathToClaudeCodeExecutable` (865).
- Bukti config meng-unpack binary: `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`
  ADA (256 MB), dan pack TERAKHIR (`release/win-unpacked`, 2026-07-19 23:19) SUDAH menaruh
  `resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`
  serta `app.asar`-nya memuat string `pathToClaudeCodeExecutable`.
  → Full `npm run dist` TIDAK dijalankan ulang (berat: 256 MB copy + exe 160 MB; config sama & sudah terbukti).

## Yang perlu dilakukan USER
1. **`npm run dist`** untuk membuat build terpaket SEGAR (memuat fix ini + semua fix hari ini).
   Catatan: release lama (23:19) sudah memuat fix binary ini, tapi build baru sekaligus membawa
   fix-fix lain yang masuk hari ini.
2. **TUTUP Grove lama lebih dulu** (tray → "Keluar"), baru jalankan build baru. Karena
   single-instance lock + `%APPDATA%\grove\grove.sqlite` bersama, menjalankan exe baru selagi
   instance lama hidup HANYA memunculkan kembali instance lama (yang buggy), bukan build baru.
   Inilah kemungkinan besar kenapa user masih melihat error: masih memakai install LAMA (pra-fix).

## Caveat / jangan lakukan
- Paket platform adalah **optionalDependency** transitif. JANGAN reinstall dengan
  `npm install --omit=optional` / `npm ci --omit=optional` — itu akan menghapus `claude.exe`
  dari node_modules dan pack berikutnya kehilangan binary. `npm install` biasa aman (sudah terpasang).
