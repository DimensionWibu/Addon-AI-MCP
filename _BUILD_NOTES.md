# Grove — Build Produksi (Fix1 + Fix2)

Tanggal build: 2026-07-19 ~23:20. Perintah: `npm run dist` (electron-vite build && electron-builder --win).
Hasil: **SUKSES**, DIST_EXITCODE=0. Tidak ada error lock/EBUSY — build tidak mengganggu Grove yang sedang berjalan.
Sumber sudah memuat Fix1 (excludeDynamicSections + memory portable) & Fix2 (turnText handoff + autoReportFinal), tsc PASS.

## Artefak siap pakai (folder output: E:\Addon AI MCP\release\)
| Artefak | Path | Ukuran | Timestamp |
|---|---|---|---|
| Installer (nsis) | `E:\Addon AI MCP\release\Grove-Setup-0.1.0.exe` | 155 MB | 2026-07-19 23:20:31 |
| Portable | `E:\Addon AI MCP\release\Grove-Portable-0.1.0.exe` | 154.8 MB | 2026-07-19 23:20:44 |
| Unpacked exe | `E:\Addon AI MCP\release\win-unpacked\Grove.exe` | 215 MB | 2026-07-19 23:19:48 |

Catatan build: signtool menandatangani Grove.exe + claude.exe (unpacked SDK) + installer; ikon default Electron (app icon belum di-set) — kosmetik saja, tidak memengaruhi fungsi.

## CARA MEMAKAI (WAJIB oleh USER — bukan agent)
Grove memakai **single-instance lock** + berbagi `%APPDATA%\grove\grove.sqlite`. Untuk memakai build baru:
1. TUTUP Grove yang sekarang berjalan lebih dulu (keluar via tray → "Keluar", bukan sekadar tutup jendela).
2. Baru jalankan salah satu:
   - `Grove-Setup-0.1.0.exe` (install, buat shortcut), atau
   - `Grove-Portable-0.1.0.exe` (langsung jalan tanpa install), atau
   - `win-unpacked\Grove.exe` (langsung dari folder unpacked).
Menjalankan exe baru selagi Grove lama masih hidup hanya akan memunculkan kembali jendela instance lama (karena single-instance lock), BUKAN memuat build baru.
