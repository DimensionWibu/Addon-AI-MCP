# Grove — Changelog: USAGE non-realtime (hentikan over-fetch → 429)

Tanggal: 2026-07-20. Acuan: `_grove_usage_DESIGN.md`. Verifikasi: **`npx tsc --noEmit -p tsconfig.json` exit 0**
+ **`npm run build` exit 0**. App TIDAK di-restart (hanya compile).

---

## 1) Hapus 3 pemicu over-fetch → SATU timer 5 menit (`src/main/index.ts`)
Blok usage lama (`loopUsage` poll 60s, `restartUsage`, `watchUsage` 120s, map `usageDelays`, handler
`grove:getUsage`) **DIGANTI** dengan satu timer global + fetch ber-guard.
- **index.ts:116-180 (blok baru)**:
  - Konstanta `USAGE_INTERVAL_MS = 5*60_000`, `USAGE_MANUAL_COOLDOWN_MS = 10_000`.
  - `runUsageFetch()` — SATU fetch: akun terpilih (UI, `emit('usage:update')`) + akun DEFAULT (watchdog
    `onUsageHigh`), **DEDUP** bila akun terpilih = default (`peekUsage(null)`, tak fetch dobel) →
    **maks 2 fetch / 5 menit**. Guard generasi `usageGen` pertahankan (buang hasil akun basi).
  - `usageTimer = setInterval(runUsageFetch, USAGE_INTERVAL_MS)` + `void runUsageFetch()` sekali di
    startup (header terisi, bukan poll cepat).
  - DIHAPUS: `usageDelays`, `loopUsage`, `restartUsage`, `watchUsage`/`USAGE_WATCH_MS`, `grove:getUsage`.
- **index.ts:190 (before-quit)**: tambah `if (usageTimer) clearInterval(usageTimer)` → timer berhenti saat quit.

## 2) `setUsageSession` → CACHE-ONLY (`src/main/index.ts`)
- Handler `grove:setUsageSession` kini hanya set `usageSessionId` lalu `return snapshotFor(usageTarget(), false)`
  (dari cache) — **TANPA fetch**. Ganti/klik-klik sesi = **0 request** (tak lagi memicu `restartUsage`).

## 3) Tombol REFRESH MANUAL ber-cooldown
- **Main `src/main/index.ts:165`**: IPC baru `grove:refreshUsage` — cooldown 10s: klik saat cooldown
  → balikan `snapshotFor(...,false)` (cache, TANPA fetch, anti-429); di luar cooldown → `runUsageFetch()`.
- **Preload `src/preload/index.ts:30`**: `refreshUsage: () => ipcRenderer.invoke('grove:refreshUsage')`
  (mengganti `getUsage`).
- **Types `src/shared/types.ts:190`**: `refreshUsage: () => Promise<UsageSnapshot>` (mengganti `getUsage`).
- **HTML `src/renderer/index.html:18`**: `<button id="usage-refresh" class="usage-refresh" …>↻</button>`
  di header, tepat setelah `#usage`.
- **Renderer `src/renderer/main.ts:1181-1196`**: handler klik — `stopPropagation` (jangan toggle popover),
  `disabled + .spin` selama cooldown 10s, panggil `window.grove.refreshUsage().then(renderUsage)`.
- **CSS `src/renderer/styles.css:77-82`**: `.usage-refresh` (+ `:hover/:disabled`), `.usage-refresh.spin` →
  `@keyframes usageSpin` (rotate 360°), + `prefers-reduced-motion` matikan animasi.

## 4) 429 / robust (dipertahankan, tak diubah)
- Stale last-good per-akun `usage.ts:80-107` (`fetchUsage` balik `{...lastGood, stale:true}` saat gagal)
  + timestamp "Update: …" (`main.ts` renderUsage) → header/popover **TAK PERNAH blank**.
- Interval tetap 5 menit walau 429 (tak ada retry cepat). Cooldown tombol manual 10s (main + guard visual
  renderer) → user tak bisa hammer.

---

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**.
- `npm run build` → **exit 0** (main 103.02 kB, preload 2.06 kB, renderer css 20.42 kB / js 38.95 kB).
- Grep pasca-edit: `getUsage`/`loopUsage`/`watchUsage`/`restartUsage`/`usageDelays` = 0 sisa; `refreshUsage`
  konsisten di types/preload/main; `usageSpin` tunggal (tak dobel).
- Tidak menjalankan dev/start/dist/restart (sesi live aman). Edit fokus region usage saja.

## Keputusan / risiko
- Akun baru dipilih & belum ada cache → tampil "—" sampai tick 5-mnt / klik ↻ (imbalan bebas-429).
- Watchdog auto-switch kini irama 5-mnt (dari 120s); jalur reaktif `onLimitHit` tetap menangkap limit nyata.
- `grove:getUsage` (ungated, tak dipakai renderer) dihapus → hilang foot-gun.
- Spin+disable berlangsung 10s penuh (sesuai cooldown) — sengaja, sebagai indikator visual cooldown.
