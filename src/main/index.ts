// Bootstrap Electron main process.
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import { Board } from './orchestrator/db'
import { SessionManager, USAGE_SWITCH_PCT } from './orchestrator/SessionManager'
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

  if (process.env.ELECTRON_RENDERER_URL) {
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

  // Limit paket langganan → poll adaptif + IPC on-demand, MENGIKUTI AKUN SESI YANG DIPILIH di UI.
  // Endpoint oauth/usage bisa membalas 429 (rate-limit); maka saat fetch gagal/stale kita
  // BACKOFF (mundur makin lama, sampai 5 menit) agar tidak makin memicu rate-limit — bukan
  // mempercepat. last-good tetap tampil selama ini. Begitu segar lagi, balik ke 60s.
  // Backoff disimpan PER AKUN: akun yang lagi kena 429 tak boleh menghukum akun lain.
  let usageSessionId: string | null = null // sesi yang sedang dipilih di UI
  let usageGen = 0 // penanda generasi; hasil fetch dari akun lama dibuang
  let usageTimer: NodeJS.Timeout | null = null
  const usageDelays = new Map<string, number>() // accountId ?? 'default' → jeda poll berikutnya

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

  const loopUsage = async (gen: number): Promise<void> => {
    const t = usageTarget()
    const key = t.id ?? 'default'
    const snap = await snapshotFor(t, true)
    if (gen !== usageGen) return // akun terlanjur berganti → hasil ini basi, jangan ditampilkan
    emit({ channel: 'usage:update', payload: snap })
    const ok = snap.usage && !snap.usage.stale
    // Akun yang ditolak permanen (scope/no-token) tak perlu dipoll cepat — langsung jeda maksimum.
    const permanent = snap.reason === 'scope' || snap.reason === 'no-token'
    const delay = ok ? 60_000 : permanent ? 300_000 : Math.min((usageDelays.get(key) ?? 60_000) * 2, 300_000)
    usageDelays.set(key, delay)
    usageTimer = setTimeout(() => void loopUsage(gen), delay)
  }

  /** Akun terpilih berubah → refetch SEGERA, jangan menunggu sisa backoff akun sebelumnya. */
  const restartUsage = (): void => {
    usageGen++
    if (usageTimer) clearTimeout(usageTimer)
    void loopUsage(usageGen)
  }

  ipcMain.handle('grove:getUsage', async (_e, arg?: { sessionId?: string | null }) => {
    if (arg && 'sessionId' in arg) usageSessionId = arg.sessionId ?? null
    return snapshotFor(usageTarget(), true)
  })

  // Renderer memberi tahu sesi mana yang dipilih. Balasannya dari cache (instan, tanpa nunggu
  // jaringan) supaya label+angka di header langsung jadi milik akun yang benar; fetch segarnya
  // menyusul lewat event usage:update. Kalau akunnya sama, jangan restart poll (hemat rate-limit).
  ipcMain.handle('grove:setUsageSession', async (_e, { sessionId }: { sessionId: string | null }) => {
    const before = usageTarget().id
    usageSessionId = sessionId ?? null
    const t = usageTarget()
    if (t.id !== before) restartUsage()
    return snapshotFor(t, false) // dari cache → header langsung benar tanpa nunggu jaringan
  })

  void loopUsage(usageGen)

  // Watchdog kuota: pantau akun DEFAULT (satu-satunya yang endpoint usage-nya bisa dibaca —
  // token `setup-token` membalas 403) lalu pindahkan sesinya ke akun lain SEBELUM kena limit.
  // Akun setup-token tetap terlindungi jalur reaktif onLimitHit (pindah begitu limit terdeteksi).
  const USAGE_WATCH_MS = 120_000
  const watchUsage = async (): Promise<void> => {
    try {
      const u = await fetchUsage({ id: null, token: null })
      const pct = u.usage?.fiveHour?.utilization ?? null
      if (pct != null && pct >= USAGE_SWITCH_PCT) {
        const moved = manager.onUsageHigh(null, pct)
        if (moved) console.log(`[usage] akun default ${Math.round(pct)}% → ${moved} sesi dipindah akun`)
      }
    } catch {
      /* jaringan gagal → coba lagi siklus berikutnya */
    }
    setTimeout(() => void watchUsage(), USAGE_WATCH_MS)
  }
  void watchUsage()

  app.on('before-quit', () => {
    // JANGAN stopAll di sini: itu mengubah status running→idle & menghapus info "sesi ini tadi kerja"
    // yang dipakai auto-resume saat dibuka lagi. Proses yang mati sendiri sudah mematikan query-nya.
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
