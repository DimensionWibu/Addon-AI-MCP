# Grove — FIX billing/akun: usage "kebagi" & balik ke akun default

Tanggal: 2026-07-20. Gejala user: login utama = **ZoraSupport**; sesi di-set ke **ZoraCorp** (Max 5x),
tapi usage awalnya ke ZoraCorp lalu **BALIK ke ZoraSupport**. Auto-switch AKTIF.
Verifikasi: **`npx tsc --noEmit -p tsconfig.json` exit 0** + **`npm run build` exit 0**. App TIDAK di-restart.

Ada **3 penyebab terpisah** yang semuanya berkontribusi. Semua diperbaiki.

---

## 1) ATRIBUSI TAMPILAN — angka akun lain menimpa angka akun terpilih

**Root cause (2 lapis):**
- `src/main/index.ts` handler `grove:setUsageSession` **tidak** menaikkan `usageGen`. Guard generasi di
  `runUsageFetch` (`if (gen === usageGen) emit(...)`) jadi tak pernah gugur saat user PINDAH SESI →
  fetch untuk akun LAMA yang masih in-flight tetap di-`emit` dan mendarat di header akun BARU.
  (Regresi dari penghapusan `restartUsage` yang dulu menaikkan `usageGen`.)
- `src/renderer/main.ts` handler `usage:update` dulu `renderUsage(ev.payload)` **tanpa cek identitas** —
  snapshot akun mana pun langsung dirender. `UsageSnapshot` SUDAH membawa `accountId`/`accountLabel`
  (shared/types.ts), jadi identitasnya ada, cuma tak dipakai untuk gating.

**Fix:**
- **index.ts:180-182** — `setUsageSession` menaikkan `usageGen++` → emit dari fetch akun sebelumnya dibatalkan.
- **renderer/main.ts:1052-1059** — gate: `const want = activeId ? (nodes.get(activeId)?.accountId ?? null) : null;`
  `if (ev.payload.accountId !== want) break` → HANYA usage milik akun sesi terpilih yang dirender.
  Hasil fetch watchdog akun default tak bisa lagi menimpa angka ZoraCorp.

## 2) AUTO-SWITCH menetap di akun pengganti (biang "balik ke ZoraSupport")

**Root cause:** `SessionManager.onLimitHit` (dulu :352) memanggil `setSessionAccount(sessionId, next.id)`
yang **menimpa PERMANEN** akun pilihan user dan mem-persist ke DB — tanpa catatan pin & tanpa jalan pulang.
Target dipilih `pickAvailableAccount` (dulu :244) dengan `.find()` = **urutan pembuatan**, sehingga dari
ZoraCorp hampir pasti mendarat di ZoraSupport (akun login utama). Hasilnya billing pindah selamanya.

**Fix:**
- **SessionManager.ts:52** — map baru `pinnedAccount` (sessionId → akun PILIHAN user).
- **SessionManager.ts:221-227** — `setSessionAccount(id, accountId, opts?: { auto?: boolean })`.
  Panggilan dari UI/IPC (tanpa `auto`) **mencatat pin**; panggilan otomatis (`auto:true`) tidak menimpanya.
- **SessionManager.ts:248-257** — `pickAvailableAccount` kini memilih di antara kandidat non-limit yang
  **paketnya TERBESAR** (paling mungkin masih punya kuota), bukan yang paling lama dibuat.
- **SessionManager.ts:304-306** (`onUsageHigh`) & **:356-361** (`onLimitHit`) — catat akun saat ini sebagai
  pin bila belum ada (sesi lama/warisan parent), lalu `setSessionAccount(..., { auto: true })`.
- **SessionManager.ts:368-392** — method baru **`restorePinnedAccounts()`**: kembalikan sesi ke akun pilihan
  user begitu akun itu tak lagi ditandai limit. Melewati sesi yang sedang `running` (jangan potong turn)
  dan akun yang sudah dihapus. Dipanggil tiap tick usage 5-menit dari **index.ts:162**.
- **Sinyal UI (tidak diam-diam):** systemNote kini menyebut akun asal + status SEMENTARA + janji balik,
  mis. `🔀 Akun "ZoraCorp" kena limit → SEMENTARA pindah ke "ZoraSupport" (billing turn berikutnya ke akun
  ini). Akan dikembalikan ke "ZoraCorp" begitu limitnya reset.` dan saat pulih `↩️ Limit sudah reset —
  sesi dikembalikan ke akun pilihanmu "ZoraCorp".` (plus `session:update{accountId}` → header ikut berubah).
- **Checkbox "Auto-switch akun saat kena limit" (c):** DIVERIFIKASI sudah benar-benar mematikan perilaku —
  `onLimitHit` early-return saat `!this.autoSwitch` (SessionManager.ts:324) dan `onUsageHigh` `return 0`
  saat `!this.autoSwitch` (:292). Tak ada jalur switch lain. Tidak diubah.

## 3) TOKEN PER-SESI — fallback DIAM-DIAM ke login utama (paling berbahaya utk billing)

**Root cause:** `Session.start()` — `const token = this.host.getAccountToken(this.meta.accountId)`
lalu `...(token ? { env: accountEnv(token) } : {})` (Session.ts:380 & ~412). Jalur normal BENAR
(accountId → token akun itu → `CLAUDE_CODE_OAUTH_TOKEN`, dan `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`
dibuang di `accountEnv`, Session.ts:256-261). **TAPI** bila sesi di-pin ke akun tersimpan sementara
tokennya null/kosong (akun dihapus / token blank), spread menghasilkan `{}` → **opsi `env` tak di-set
sama sekali** → subprocess CLI memakai `~/.claude/.credentials.json` = **AKUN LOGIN UTAMA (ZoraSupport)**
dan menagih ke sana **tanpa peringatan apa pun**. Inkonsisten: `getSessionAccountInfo`
(SessionManager.ts:208-213) sudah benar menolak fallback untuk TAMPILAN, tapi jalur spawn tidak.

**Fix:**
- **Session.ts:379-395** — guard sebelum `query()`: bila `meta.accountId` ada tapi `!token` →
  batalkan start (`this.started = false`), tulis nota system tegas (⛔ jelaskan sesi dihentikan agar tidak
  diam-diam menagih akun utama; suruh isi ulang token atau pilih "Default" secara sadar),
  `setStatus('error')` + `emitActivity('akun tanpa token')`, lalu `return` — **query TIDAK dibuat**.
- **Session.ts:542-550** (`sendUserMessage`) — bila `start()` dibatalkan, pesan user tetap DIREKAM (tak
  hilang) tapi sesi tidak ditandai `running` & tak mendorong ke query yang tidak ada.
- **Session.ts:576-579** (`injectAutoTask`) — guard sama (return bila start dibatalkan).

---

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**.
- `npm run build` → **exit 0** (main 107.82 kB, preload 2.06 kB, renderer css 20.42 kB / js 39.07 kB).
- Tidak menjalankan dev/start/dist/restart (sesi live aman).
- Koordinasi: `Session.ts`/`SessionManager.ts` juga sedang disentuh worker lain — semua perubahan di sini
  memakai edit ber-anchor (gagal aman bila region berubah), bukan overwrite file. Tak ada error tsc/build
  yang berasal dari file di luar scope.

## Risiko / keputusan
- **Sesi dipin ke akun tanpa token kini BERHENTI** (dulu diam-diam jalan di akun utama). Ini disengaja:
  salah-menagih akun lain lebih buruk daripada berhenti dengan pesan jelas. Pemulihan: isi ulang token,
  atau pilih "Default (login utama)" secara sadar di panel Akun.
- **Restore pin** hanya jalan saat sesi TIDAK `running` (agar turn tak terpotong) dan dievaluasi tiap tick
  5-menit → pengembalian bisa tertunda maksimal ±5 menit setelah limit reset. Dapat dipercepat dgn klik ↻.
- ~~`pinnedAccount` disimpan di MEMORI (bukan DB) → reset saat app restart.~~ **SUDAH DIPERBAIKI** —
  lihat bagian "PERSIST PIN" di bawah (pin kini tersimpan di tabel `session_pins`, tahan restart).

---

# PERSIST PIN — `pinnedAccount` tahan restart (follow-up)

Tanpa ini, `npm run dist` + restart menghapus map pin → `restorePinnedAccounts()` kehilangan target dan
sesi nyangkut PERMANEN di akun hasil auto-switch (mis. ZoraSupport) = bug billing balik sebagian.

## Skema yang dipilih: tabel terpisah `session_pins` (BUKAN kolom di `sessions`)
Alasan risiko-minimum: `upsertSession` memakai daftar kolom eksplisit + `ON CONFLICT DO UPDATE` dan
dipanggil SANGAT sering (tiap perubahan status/ctx). Menambah kolom `pinned_account` di situ berarti
harus ikut ditulis tiap upsert — kalau tidak ikut ia jadi kolom mati, kalau ikut (dari `SessionMeta` yang
tak punya field itu) ia akan **menimpa pin dengan NULL** tiap kali status berubah. Tabel terpisah
menghilangkan seluruh kelas bug itu, dan `CREATE TABLE IF NOT EXISTS` di SCHEMA (dijalankan tiap
`Board.init`) sudah idempoten — tak perlu `ALTER TABLE` ber-guard sama sekali.

Semantik: **baris ADA = ada pin**; `account_id NULL` = pin eksplisit ke "Default (login utama)"
(berbeda dari "tak ada baris" = belum pernah dipin). Cocok 1:1 dengan `Map<string, string | null>`.

## Perubahan
- **db.ts:75-84** — SCHEMA: tabel `session_pins (session_id TEXT PRIMARY KEY, account_id TEXT)` + komentar.
- **db.ts:207-223** — `setSessionPin(sessionId, accountId)` (INSERT … ON CONFLICT(session_id) DO UPDATE)
  & `getAllSessionPins()` → dipakai saat startup.
- **db.ts:233** — `deleteSession` juga `DELETE FROM session_pins WHERE session_id=?` (tak ada baris yatim).
- **SessionManager.ts:225-230** — helper `rememberPin(sessionId, accountId)`: tulis ke map **dan** DB sekaligus.
- **SessionManager.ts:240** — `setSessionAccount` jalur NON-auto (dari UI) → `rememberPin` (persist).
  Jalur `{auto:true}` tetap TIDAK menyentuh pin tersimpan.
- **SessionManager.ts:318** (`onUsageHigh`) & **:369** (`onLimitHit`) — saat auto-switch "mengabadikan"
  akun yang sedang dipakai sebagai pin (bila belum ada), kini ikut di-persist lewat `rememberPin`.
- **SessionManager.ts:156** (`loadFromDisk`) — muat semua pin dari DB ke `pinnedAccount` saat startup →
  `restorePinnedAccounts()` tetap tahu tujuan setelah restart.
- **SessionManager.ts:636** (`deleteSession`) — `pinnedAccount.delete(sid)` (baris DB dibersihkan db.deleteSession).

## Uji migrasi (script sementara, sudah dihapus setelah lulus)
SCHEMA diekstrak LANGSUNG dari `db.ts` lalu dijalankan via sql.js:
1. **DB LAMA** (skema tanpa `session_pins`, sudah berisi `sessions` + `settings`) → jalankan SCHEMA baru
   **2×** → tidak error → **idempoten**; data lama (sessions + settings) **utuh**.
2. `setSessionPin`: insert → **jalur ON CONFLICT** (ganti akun) → pin `NULL`; hasil
   `[["s1","acc-zorasupport"],["s2",null]]` sesuai harapan (update, bukan duplikat/error).
3. `DELETE FROM session_pins` saat hapus sesi → bersih.
4. **DB fresh** (install baru) + init 2× + insert pin → OK.
→ **SEMUA UJI MIGRASI LULUS.** DB existing user aman, app tidak gagal start.

## Tidak berubah (diverifikasi)
- `restorePinnedAccounts()` tetap dipanggil tiap tick usage 5 menit (index.ts:162) & tetap melewati sesi
  `running`/akun terhapus/akun masih limit.
- Checkbox "Auto-switch akun saat kena limit" tetap menonaktifkan switch (SessionManager `!autoSwitch`
  early-return di `onUsageHigh`/`onLimitHit`).
- Guard token anti-fallback (#3, Session.ts) utuh — tak disentuh.

## Verifikasi akhir
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**.
- `npm run build` → **exit 0** (main 109.85 kB, preload 2.06 kB, renderer css 20.42 kB / js 39.07 kB).
- Tidak menjalankan dev/start/dist/restart.
- Catatan proses: sempat ada error `TS1005` karena komentar SQL memakai backtick di dalam template literal
  SCHEMA — sudah diperbaiki (db.ts:79 tanpa backtick), tsc hijau.
