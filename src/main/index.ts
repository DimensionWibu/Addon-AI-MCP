// Bootstrap Electron main process.
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import { Board } from './orchestrator/db'
import { SessionManager } from './orchestrator/SessionManager'
import { registerIpc } from './ipc'
import { fetchAccountEmail, fetchUsage, peekAccountEmail, peekUsage } from './usage'
import { loadWindowState, trackWindowState } from './windowState'
import type { GroveEvent, UsageSnapshot } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let managerRef: SessionManager | null = null

// Keep-alive (tutup jendela ≠ keluar, sesi lanjut di background) HANYA di app terpaket.
// Di `electron-vite dev`, tiap edit file main memicu restart main-process; kalau proses lama
// dibiarkan hidup, dua Electron berebut grove.sqlite → DB bisa ke-clobber jadi kosong.
// Maka di dev kita restart bersih (quit saat window-all-closed), di produksi baru keep-alive.
const KEEP_ALIVE = app.isPackaged

/** Tampilkan jendela (buat ulang bila sudah ditutup — proses tetap hidup di background). */
function showWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

// Cegah >1 instance menulis grove.sqlite yang sama (penyebab data ke-clobber).
// Bonus: saat GUI ditutup tapi proses masih jalan, menjalankan .exe lagi hanya
// membuka kembali jendelanya (bukan proses baru) → nyambung ke sesi yang masih hidup.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

function createWindow(): void {
  const st = loadWindowState() // ukuran + posisi terakhir (atau default)
  mainWindow = new BrowserWindow({
    width: st.width,
    height: st.height,
    ...(st.x != null && st.y != null ? { x: st.x, y: st.y } : {}),
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b1220',
    title: 'Grove',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  if (st.maximized) mainWindow.maximize()
  trackWindowState(mainWindow) // simpan otomatis saat resize/move/close

  // Guard app.isPackaged: kalau mesin user kebetulan punya ELECTRON_RENDERER_URL
  // ter-set, app terpaket akan memuat dev server yang tidak ada → jendela putih.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** Ikon tray 16×16 (kotak coral #d97757) tanpa file aset — dari bitmap BGRA. */
function trayIcon(): Electron.NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let p = 0; p < size * size; p++) {
    buf[p * 4] = 0x57 // B
    buf[p * 4 + 1] = 0x77 // G
    buf[p * 4 + 2] = 0xd9 // R
    buf[p * 4 + 3] = 0xff // A
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

/** Tray icon: penanda "masih jalan di background" + cara buka lagi / stop / keluar. */
function createTray(): void {
  if (tray) return
  tray = new Tray(trayIcon())
  tray.setToolTip('Grove — sesi tetap jalan di background')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Buka Grove', click: () => showWindow() },
      { label: 'Stop semua sesi', click: () => void managerRef?.stopAll() },
      { type: 'separator' },
      { label: 'Keluar (hentikan semua)', click: () => app.quit() }
    ])
  )
  tray.on('double-click', () => showWindow())
}

app.whenReady().then(async () => {
  const board = new Board(join(app.getPath('userData'), 'grove.sqlite'))
  await board.init()

  const emit = (ev: GroveEvent): void => {
    mainWindow?.webContents.send('grove:event', ev)
  }
  const manager = new SessionManager(board, emit)
  managerRef = manager
  manager.loadFromDisk() // muat session lama (dormant) agar history & context tetap terlihat
  registerIpc(manager)
  if (KEEP_ALIVE) createTray() // hanya di produksi: sesi lanjut jalan meski jendela ditutup

  // Limit paket langganan → SATU timer 5-menit di main (BUKAN realtime) + refresh MANUAL ber-cooldown.
  // Endpoint oauth/usage membalas 429 bila di-hammer; maka TIDAK ada poll cepat/per-sesi. Nilai sukses
  // terakhir di-cache per-akun (usage.ts lastGood) & tetap tampil (stale) saat fetch gagal → header
  // TAK PERNAH blank. Ganti sesi = cache-only (0 request). Watchdog auto-switch ikut irama 5-menit.
  const USAGE_INTERVAL_MS = 5 * 60_000 // auto-cek tiap 5 menit — TIDAK ada yang lebih sering
  const USAGE_MANUAL_COOLDOWN_MS = 10_000 // guard anti-spam tombol refresh (cegah 429 dari klik beruntun)
  let usageSessionId: string | null = null // sesi yang sedang dipilih di UI
  let usageGen = 0 // penanda generasi; hasil fetch dari akun lama dibuang
  let usageTimer: NodeJS.Timeout | null = null // interval 5-menit (di-clear saat quit)
  let lastManualAt = 0 // waktu fetch manual terakhir (untuk cooldown)

  const usageTarget = (): { id: string | null; label: string; token: string | null } =>
    manager.getSessionAccountInfo(usageSessionId)

  /** Snapshot lengkap untuk akun yang sedang dipilih: identitas + angka (atau alasan kosongnya). */
  const snapshotFor = async (
    t: { id: string | null; label: string; token: string | null },
    live: boolean
  ): Promise<UsageSnapshot> => {
    const acct = { id: t.id, token: t.token }
    const r = live ? await fetchUsage(acct) : peekUsage(t.id)
    // Email diambil dari /oauth/profile (endpoint usage tak memuat identitas). Hasilnya di-cache
    // per akun; akun yang tokennya tak ber-scope user:profile permanen null → UI pakai label saja.
    const email = live ? await fetchAccountEmail(acct) : peekAccountEmail(t.id)
    return { accountId: t.id, accountLabel: t.label, accountEmail: email, usage: r.usage, reason: r.reason }
  }

  /**
   * Satu putaran: akun terpilih (untuk header UI) + SEMUA akun GUI (untuk watchdog ambang per-akun),
   * dengan DEDUP sehingga tiap akun paling banyak di-fetch sekali. Dipakai timer 5-menit & refresh
   * manual (tak ada pemicu lain). Guard generasi: bila akun terpilih keburu berganti saat fetch
   * berjalan, hasil basi tidak di-emit.
   *
   * Watchdog kini menyapu SETIAP akun tersimpan, bukan hanya login default — karena setelah Grove
   * berjalan murni dengan token akun GUI, tidak ada lagi "akun default" yang menjalankan pekerjaan.
   * Akun yang usage-nya tak terbaca (403 tanpa scope user:profile) dicatat lewat noteUsageReadable()
   * supaya UI bisa jujur bilang ambangnya non-aktif, bukan diam-diam tak pernah memicu.
   */
  const runUsageFetch = async (): Promise<UsageSnapshot> => {
    const gen = ++usageGen
    const t = usageTarget()
    const snap = await snapshotFor(t, true) // fetchUsage → update cache + stale-safe (tak pernah blank)
    if (gen === usageGen) emit({ channel: 'usage:update', payload: snap })

    for (const a of manager.listAccounts().accounts) {
      // Akun OpenRouter tak punya kuota gaya Claude & endpoint /oauth/usage-nya beda → memfetch-nya
      // ke Anthropic hanya buang request + memunculkan "non-aktif" palsu. Lewati.
      if (a.provider === 'openrouter') continue
      // Akun terpilih baru saja di-fetch di atas → pakai cache, jangan tembak endpoint dua kali.
      const r = a.id === t.id ? peekUsage(a.id) : await fetchUsage({ id: a.id, token: manager.getAccountToken(a.id) })
      const pct = r.usage?.fiveHour?.utilization ?? null
      // 'scope'/'unauthorized' = permanen tak terbaca. 'rate-limited'/'error' = gangguan sesaat →
      // JANGAN divonis non-aktif, nanti UI bohong ke arah sebaliknya.
      if (r.reason === 'scope' || r.reason === 'unauthorized') manager.noteUsageReadable(a.id, false)
      else if (pct != null) manager.noteUsageReadable(a.id, true)
      if (pct == null) continue
      // Ambang ditegakkan di dalam onUsageHigh (per akun) — di sini cukup laporkan angkanya.
      const moved = manager.onUsageHigh(a.id, pct)
      if (moved) console.log(`[usage] akun "${a.label}" ${Math.round(pct)}% → ${moved} sesi dipindah akun`)
    }
    // Akun PILIHAN user yang sempat di-auto-switch karena limit → kembalikan begitu akunnya bisa
    // dipakai lagi, supaya billing tidak menetap di akun lain (mis. nyangkut di login default).
    const back = manager.restorePinnedAccounts()
    if (back) console.log(`[usage] ${back} sesi dikembalikan ke akun pilihan user`)
    return snap
  }

  // Refresh MANUAL (tombol ↻ di header). Cooldown: klik saat masih cooldown → balikan cache TERAKHIR
  // TANPA fetch (anti-429). Di luar cooldown → fetch sekarang.
  ipcMain.handle('grove:refreshUsage', async () => {
    const now = Date.now()
    if (now - lastManualAt < USAGE_MANUAL_COOLDOWN_MS) return snapshotFor(usageTarget(), false)
    lastManualAt = now
    return runUsageFetch()
  })

  // Renderer memberi tahu sesi mana yang dipilih. CACHE-ONLY: TANPA fetch (0 request saat klik-klik sesi)
  // → header langsung jadi milik akun yang benar dari cache; angka segar ikut tick 5-menit / refresh manual.
  ipcMain.handle('grove:setUsageSession', async (_e, { sessionId }: { sessionId: string | null }) => {
    usageSessionId = sessionId ?? null
    // ATRIBUSI: batalkan emit dari fetch akun SEBELUMNYA yang masih in-flight. Tanpa ini, hasil
    // akun lama mendarat setelah user pindah sesi → angka akun A tampil untuk akun B ("kebagi").
    usageGen++
    return snapshotFor(usageTarget(), false)
  })

  usageTimer = setInterval(() => void runUsageFetch(), USAGE_INTERVAL_MS) // auto-cek 5 menit (satu timer global)
  void runUsageFetch() // sekali di startup → header terisi (bukan blank); bukan poll cepat

  app.on('before-quit', () => {
    // JANGAN stopAll di sini: itu mengubah status running→idle & menghapus info "sesi ini tadi kerja"
    // yang dipakai auto-resume saat dibuka lagi. Proses yang mati sendiri sudah mematikan query-nya.
    if (usageTimer) clearInterval(usageTimer) // hentikan timer usage 5-menit
    board.flush() // pastikan DB (termasuk status 'running') tersimpan saat keluar
  })

  createWindow()

  app.on('activate', () => showWindow())
})

// Produksi: menutup jendela TIDAK mematikan app (sesi lanjut di background; keluar via tray).
// Dev: quit bersih agar electron-vite bisa restart tanpa proses lama menyangkut & berebut DB.
app.on('window-all-closed', () => {
  if (!KEEP_ALIVE) app.quit()
})
