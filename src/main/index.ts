// Bootstrap Electron main process.
import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import { Board } from './orchestrator/db'
import { SessionManager } from './orchestrator/SessionManager'
import { registerIpc } from './ipc'
import { fetchUsage } from './usage'
import type { GroveEvent } from '../shared/types'

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
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
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

  // Limit paket langganan → poll adaptif + IPC on-demand.
  // Endpoint oauth/usage bisa membalas 429 (rate-limit); maka saat fetch gagal/stale kita
  // BACKOFF (mundur makin lama, sampai 5 menit) agar tidak makin memicu rate-limit — bukan
  // mempercepat. last-good tetap tampil selama ini. Begitu segar lagi, balik ke 60s.
  ipcMain.handle('grove:getUsage', () => fetchUsage())
  let usageDelay = 60_000
  const loopUsage = async (): Promise<void> => {
    const u = await fetchUsage()
    emit({ channel: 'usage:update', payload: u })
    usageDelay = u && !u.stale ? 60_000 : Math.min(usageDelay * 2, 300_000)
    setTimeout(() => void loopUsage(), usageDelay)
  }
  void loopUsage()

  app.on('before-quit', () => {
    void manager.stopAll() // hentikan turn yang jalan sebelum proses mati
    board.flush() // pastikan DB tersimpan saat keluar
  })

  createWindow()

  app.on('activate', () => showWindow())
})

// Produksi: menutup jendela TIDAK mematikan app (sesi lanjut di background; keluar via tray).
// Dev: quit bersih agar electron-vite bisa restart tanpa proses lama menyangkut & berebut DB.
app.on('window-all-closed', () => {
  if (!KEEP_ALIVE) app.quit()
})
