# Grove — Desain ulang sistem USAGE (hentikan over-fetch → 429)

Read-only investigation. BELUM ada kode diubah. Semua file:line = titik yang akan diubah.

## Ringkasan
User mau: (1) BUKAN realtime, (2) fetch saat KLIK refresh, (3) auto tiap 5 MENIT, (4) header selalu
tampil nilai TERAKHIR + timestamp, tak blank walau 429. Robustness "stale last-good" **sudah ADA** dan
benar (usage.ts:80-107) — masalahnya murni **FREKUENSI fetch**. Fix = ganti 2 poller cepat jadi SATU
timer 5-menit di main + tombol refresh manual ber-cooldown + hentikan fetch-burst saat ganti akun.

---

## Investigasi — sumber over-fetch / 429 (file:line)

Renderer TIDAK fetch saat popover dibuka. Klik `#usage` (renderer/main.ts:1164-1166) HANYA toggle
`.show` popover — tak ada jaringan. Angka terlihat "realtime" karena MAIN mem-push `usage:update` sangat
sering. Sumber sebenarnya semua di `src/main/index.ts`:

1. **`loopUsage` — index.ts:142-154, distart :179.** Self-loop `setTimeout`. Sukses → `delay = 60_000`
   → **fetch `oauth/usage` tiap 60 DETIK terus-menerus** untuk akun terpilih, lalu `emit('usage:update')`.
   → **Penyumbang 429 UTAMA + kesan realtime.** (gagal → backoff s/d 300s, tapi jalur sukses tetap 60s.)
2. **`watchUsage` — index.ts:184-198, distart :198.** Self-loop `USAGE_WATCH_MS = 120_000` →
   **fetch akun DEFAULT tiap 120 DETIK** (watchdog auto-switch `onUsageHigh`). Aliran fetch KEDUA ke
   endpoint yang sama → pada akun default menumpuk dgn loopUsage (≈ tiap 60s + tiap 120s).
3. **`restartUsage` — index.ts:157-161**, dipicu `grove:setUsageSession` saat akun berubah (index.ts:175).
   → **fetch live SEGERA tiap kali user pindah sesi** yang akunnya beda. Burst saat klik-klik sesi.
4. **`grove:getUsage` — index.ts:163-166** → `snapshotFor(..., live:true)` = fetch live tak ber-guard.
   Saat ini TIDAK dipanggil renderer (grep: tak ada `grove.getUsage(` di renderer) → trigger "mati" tapi
   ada = foot-gun.

Backoff per-akun `usageDelays` (index.ts:124,151-152) & guard generasi `usageGen` (index.ts:122,146)
adalah bagian dari loopUsage.

### Yang SUDAH benar (pertahankan)
- `fetchUsage` (usage.ts:95-107): sukses → simpan `lastGood` per-akun; gagal/429 → kembalikan
  `{...lastGood, stale:true}` (TAK blank). `reasonFor(429)='rate-limited'` (usage.ts:66-70).
- `peekUsage` (usage.ts:88-93): nilai cache tanpa fetch.
- Renderer `renderUsage` (main.ts:103-151): render nilai (termasuk stale, `.stale` opacity main.ts:115,
  styles.css:75) + **timestamp "Update: …" dari `u.fetchedAt`** (main.ts:149). Jadi requirement (4)
  praktis sudah terpenuhi begitu poll dijarangkan.
- `usage:update` push channel (types.ts:165; handler renderer main.ts:1043-1045).

---

## Desain baru

### 1) Hentikan semua pemicu cepat (src/main/index.ts:116-198)
Ganti blok `loopUsage`/`restartUsage`/`watchUsage` dengan SATU timer global + fetch ber-guard. Buang
`usageDelays` (tak perlu backoff adaptif lagi — interval tetap 5 menit).

```ts
const USAGE_INTERVAL_MS = 5 * 60_000        // auto-cek tiap 5 menit — TIDAK ada yang lebih sering
const USAGE_MANUAL_COOLDOWN_MS = 10_000     // guard anti-spam tombol refresh (cegah 429 dari klik beruntun)
let usageSessionId: string | null = null
let usageGen = 0                            // buang hasil fetch akun yang sudah tak dipilih
let lastManualAt = 0

// SATU fetch per tick: akun terpilih (UI) + akun default (watchdog) — dedup bila sama. Maks 2 fetch / 5 mnt.
const runUsageFetch = async (): Promise<UsageSnapshot> => {
  const gen = ++usageGen
  const t = usageTarget()
  const snap = await snapshotFor(t, true)               // fetchUsage → update cache + stale-safe
  if (gen === usageGen) emit({ channel: 'usage:update', payload: snap })
  // Watchdog auto-switch butuh angka akun DEFAULT. Kalau terpilih = default, pakai hasil di atas (sudah di-cache).
  const def = t.id === null ? peekUsage(null) : await fetchUsage({ id: null, token: null })
  const pct = def.usage?.fiveHour?.utilization ?? null
  if (pct != null && pct >= USAGE_SWITCH_PCT) manager.onUsageHigh(null, pct)
  return snap
}

const usageInterval = setInterval(() => void runUsageFetch(), USAGE_INTERVAL_MS)
void runUsageFetch()                        // sekali di startup → header langsung terisi (bukan blank)
```
- **Jaminan no-realtime:** hanya `setInterval(…, 300_000)` + tombol manual (ber-cooldown). Tak ada
  path 60s/120s lagi; `restartUsage` (fetch saat pindah sesi) DIHAPUS.
- Watchdog auto-switch tetap hidup tapi ikut irama 5 menit (dari 120s).

### 2) Tombol REFRESH manual (IPC ber-cooldown)
Handler baru di index.ts (ganti/dampingi `grove:getUsage`):
```ts
ipcMain.handle('grove:refreshUsage', async () => {
  const now = Date.now()
  if (now - lastManualAt < USAGE_MANUAL_COOLDOWN_MS) return snapshotFor(usageTarget(), false) // cooldown → cache
  lastManualAt = now
  return runUsageFetch()
})
```
- **HAPUS `grove:getUsage` (index.ts:163-166)** + `getUsage` di preload/types (tak dipakai renderer,
  ungated). Diganti `refreshUsage` yang ber-cooldown.

### 3) Ganti akun = CACHE saja, tanpa fetch (index.ts:171-177)
```ts
ipcMain.handle('grove:setUsageSession', async (_e, { sessionId }: { sessionId: string | null }) => {
  usageSessionId = sessionId ?? null
  return snapshotFor(usageTarget(), false)   // dari cache → header langsung benar TANPA jaringan (no 429)
})
```
Akun yang belum pernah ke-fetch → tampil "—" sampai tick 5-menit / klik refresh. Konsekuensi diterima
(imbalan: bebas 429 saat klik-klik sesi). `restartUsage` dihapus.

### 4) 429 / error robust (sebagian besar sudah ada)
- Nilai terakhir TETAP tampil (stale) — `fetchUsage` usage.ts:98-107 (tak diubah).
- Interval tetap 5 menit walau 429 (tak ada retry cepat) → tak menambah tekanan rate-limit.
- Tombol manual ber-cooldown 10s (main) + disable sementara (renderer) → user tak bisa hammer.
- Opsional: bila tick barusan `rate-limited`, LEWATI watchdog-fetch default pada tick itu (kurangi 1 fetch).

---

## Perubahan per file

### `src/main/index.ts` (INTI)
- **:116-198** ganti blok usage: hapus `usageDelays`(:124), `loopUsage`(:142-154), `restartUsage`(:157-161),
  `grove:getUsage`(:163-166), `watchUsage`(:184-198, :198). Tambah `USAGE_INTERVAL_MS`,
  `USAGE_MANUAL_COOLDOWN_MS`, `runUsageFetch`, `setInterval` 5-mnt + fetch startup, handler
  `grove:refreshUsage`. Ubah `grove:setUsageSession`(:171-177) → cache-only (buang `restartUsage`).
- `snapshotFor`(:129-140) & `usageTarget`(:126-127) DIPERTAHANKAN.
- (opsional) `clearInterval(usageInterval)` di `before-quit`(:200-204).

### `src/preload/index.ts`
- **:30-31**: hapus `getUsage`; tambah `refreshUsage: () => ipcRenderer.invoke('grove:refreshUsage')`.
  `setUsageSession` tetap.

### `src/shared/types.ts` (GroveApi)
- **:189-192**: hapus `getUsage`; tambah `refreshUsage: () => Promise<UsageSnapshot>`. `usage:update`
  channel (types.ts:165) & `UsageSnapshot` tetap.

### `src/renderer/index.html`
- **:17** dekat `<div id="usage">`: tambah tombol refresh, mis.
  `<button id="usage-refresh" class="usage-refresh" title="Refresh pemakaian (auto tiap 5 menit)">↻</button>`.

### `src/renderer/main.ts`
- Di `init()` (dekat handler `#usage` main.ts:1164-1169): wire tombol:
  ```ts
  $('usage-refresh').addEventListener('click', (e) => {
    e.stopPropagation()                       // jangan ikut toggle popover
    const b = $<HTMLButtonElement>('usage-refresh')
    if (b.disabled) return
    b.disabled = true; b.classList.add('spin')
    window.grove.refreshUsage().then(renderUsage).catch(() => {})
      .finally(() => setTimeout(() => { b.disabled = false; b.classList.remove('spin') }, 10_000)) // cooldown 10s (sejalan main)
  })
  ```
- `syncUsageSession`(:157-165) TETAP (pakai `setUsageSession` = cache). `usage:update` handler(:1043-1045)
  TETAP. `renderUsage`(:103-151) TETAP (timestamp "Update:" sudah ada :149).
- (opsional req-4) tampilkan "Update: HH:MM" ringkas juga di HEADER (kini hanya di popover :149) —
  tambah 1 span kecil di `box.innerHTML` (main.ts:134).

### `src/renderer/styles.css`
- Dekat `.usage`(:74-96): tambah `.usage-refresh` (tombol kecil, transparan) + animasi putar:
  ```css
  .usage-refresh { background:transparent; border:none; color:var(--text-dim); cursor:pointer; font-size:13px; padding:0 4px; }
  .usage-refresh:hover { color:var(--accent); }
  .usage-refresh:disabled { opacity:.5; cursor:default; }
  .usage-refresh.spin { animation: usageSpin .8s linear infinite; }
  @keyframes usageSpin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .usage-refresh.spin { animation: none; } }
  ```

---

## Ringkas efek
- Fetch turun dari **±(tiap 60s + tiap 120s)** → **maks 2 fetch / 5 menit** + klik manual (cooldown 10s).
- Ganti sesi: 0 fetch (cache). Popover buka/tutup: 0 fetch (sudah begitu).
- Header/popover tak pernah blank (stale last-good + timestamp). 429 → tetap tampil terakhir, tak retry cepat.

## Risiko/keputusan
1. **Akun baru dipilih & belum ada cache → "—"** sampai tick 5-mnt / klik refresh. Diterima demi bebas-429;
   mitigasi = tombol refresh.
2. **Watchdog auto-switch kini 5-mnt** (bukan 120s) → deteksi kuota tinggi sedikit lebih lambat; jalur
   reaktif `onLimitHit` tetap menangkap limit saat benar-benar kena. Bila mau lebih rapat, watchdog boleh
   pakai interval sendiri (mis. 2-3 mnt) tapi tetap ≥ jauh di atas 60s — pilihan trade-off, default 5-mnt.
3. Hapus `getUsage` (ungated) menghilangkan foot-gun; tak ada pemakai di renderer.
