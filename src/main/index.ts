// Bootstrap Electron main process.
import { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import { Board } from './orchestrator/db'
import { SessionManager } from './orchestrator/SessionManager'
import { registerIpc } from './ipc'
import { fetchAccountEmail, fetchUsage, peekAccountEmail, peekUsage } from './usage'
import { loadWindowState, trackWindowState } from './windowState'
import { startOpenAiBridge } from './openaiBridge'
import { currentHolder, holdLock } from './dbLock'
import type { AccountProvider, GroveEvent, UsageSnapshot } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let managerRef: SessionManager | null = null
let quitting = false // app benar-benar diminta keluar (tray "Keluar", Cmd+Q, kill) → jangan tanya lagi
let closeConfirmed = false // user sudah menjawab dialog "masih ada sesi bekerja" untuk penutupan ini

/**
 * Keep-alive: tutup jendela ≠ keluar — sesi lanjut bekerja di background, jendela dibuka lagi lewat
 * tray. Berlaku DI DEV JUGA (dulu hanya di app terpaket).
 *
 * Kekhawatiran lama yang membuat dev dikecualikan: proses lama yang dibiarkan hidup bisa berebut
 * grove.sqlite dengan proses baru → DB ke-clobber. Yang menjaganya sekarang:
 *  - single-instance lock di bawah: instance kedua LANGSUNG keluar, jadi tak pernah ada dua penulis;
 *  - restart dari `electron-vite dev` MEMBUNUH proses lama (bukan menambah proses baru), jadi
 *    hot-reload tetap seperti biasa.
 * Butuh perilaku lama (tutup jendela = keluar)? Jalankan dengan GROVE_QUIT_ON_CLOSE=1.
 */
const KEEP_ALIVE = process.env.GROVE_QUIT_ON_CLOSE !== '1'

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
/**
 * SATU INSTANCE SAJA — tapi di DEV, yang menang harus yang BARU.
 *
 * Sejak keep-alive berlaku di dev, menutup jendela tidak mematikan prosesnya. Akibatnya
 * `run-dev.bat` berikutnya kalah lock lalu keluar, dan yang muncul justru jendela proses LAMA
 * dengan KODE LAMA — persis gejala "kok gak jalan versi baru". Karena itu instance dev yang baru
 * meminta ALIH TUGAS: yang lama (kalau ia juga dev) mundur, yang baru mengambil lock.
 *
 * App TERPAKET tidak pernah dipaksa mundur: di sana sesi user sedang bekerja sungguhan, dan
 * mematikannya karena seseorang menjalankan dev-build adalah kehilangan kerja yang nyata.
 */
const DEV = !app.isPackaged
function acquireLock(attempt = 0): void {
  if (app.requestSingleInstanceLock({ takeover: DEV })) {
    app.on('second-instance', (_e, _argv, _cwd, data) => {
      const wantsTakeover = DEV && !!(data as { takeover?: boolean } | undefined)?.takeover
      if (wantsTakeover) {
        console.log('[grove] Instance dev baru datang — instance ini mundur supaya kode terbaru yang jalan.')
        app.quit()
        return
      }
      showWindow()
    })
    return
  }
  if (DEV && attempt < 12) {
    // Yang lama sedang mundur (atau belum sempat membaca pesan) → coba lagi sebentar.
    if (attempt === 0) console.log('[grove] Instance lama terdeteksi — meminta ia mundur agar kode terbaru yang jalan…')
    setTimeout(() => acquireLock(attempt + 1), 300)
    return
  }
  console.log(
    DEV
      ? '[grove] Instance lama TIDAK mundur (kemungkinan app TERPAKET yang sedang bekerja). Keluar dari tray-nya dulu, lalu jalankan run-dev.bat lagi.'
      : '[grove] Grove sudah berjalan — jendelanya dimunculkan kembali.'
  )
  app.quit()
}
acquireLock()

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

  // KONFIRMASI TUTUP JENDELA saat masih ada sesi bekerja. Tanpa ini, "tutup jendela" punya dua arti
  // yang tak kelihatan bedanya (lanjut di background vs berhenti), dan turn yang sedang jalan bisa
  // hilang tanpa user sadar — untuk akun berbayar, token turn itu tetap tertagih.
  mainWindow.on('close', (e) => {
    if (closeConfirmed || quitting || !managerRef) return // Keluar lewat tray/quit: sudah eksplisit
    const running = managerRef.countRunning()
    if (running === 0) return // tak ada yang bekerja → tutup diam-diam
    e.preventDefault()
    const win = mainWindow
    if (!win) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Biarkan jalan di background', 'Stop semua lalu tutup', 'Batal'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'Masih ada sesi yang bekerja',
      message: `${running} sesi masih bekerja.`,
      detail: KEEP_ALIVE
        ? 'Grove tetap hidup di system tray kalau jendela ditutup — sesi lanjut bekerja, dan jendelanya bisa dibuka lagi dari ikon tray.\n\n"Stop semua lalu tutup" menghentikan turn yang sedang jalan (hasil turn itu hilang; token yang sudah terpakai tetap tertagih).'
        : 'GROVE_QUIT_ON_CLOSE=1 sedang aktif → menutup jendela MENGHENTIKAN aplikasi beserta semua sesinya.'
    })
    if (choice === 2) return // Batal → jendela tetap terbuka
    if (choice === 1) {
      void managerRef.stopAll().then(() => {
        closeConfirmed = true
        mainWindow?.close()
      })
      return
    }
    closeConfirmed = true
    win.close()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    closeConfirmed = false // jendela berikutnya dikonfirmasi lagi dari nol
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
  // SATU PENULIS SAJA untuk grove.sqlite. Lock bawaan Electron tak menjangkau lintas-binary (app
  // terpaket vs dev bisa jalan bersamaan) — dan karena DB ditulis ulang utuh dari memori, penulis
  // kedua akan MENIMPA pekerjaan yang pertama (akun/sesi bisa hilang). Jadi dicek eksplisit di sini.
  const userData = app.getPath('userData')
  const holder = currentHolder(userData)
  if (holder) {
    const mine = app.isPackaged ? 'terpaket' : 'dev'
    dialog.showErrorBox(
      'Grove sudah berjalan',
      `Sudah ada Grove lain yang memakai database yang sama (PID ${holder.pid}, mode ${holder.kind}).

` +
        `Menjalankan dua Grove sekaligus membuat perubahan salah satunya HILANG tertimpa — jadi yang ini (mode ${mine}) ditutup.

` +
        'Tutup Grove yang sedang jalan dari ikon tray (Keluar), lalu buka lagi yang ini.'
    )
    app.quit()
    return
  }
  const releaseLock = holdLock(userData, app.isPackaged ? 'terpaket' : 'dev')
  app.on('will-quit', releaseLock)

  // Jembatan Anthropic→OpenAI untuk akun gateway ber-format OpenAI (DZAX). Dinyalakan SEBELUM
  // manager: getSessionLaunch butuh port-nya untuk merakit ANTHROPIC_BASE_URL sesi DZAX.
  await startOpenAiBridge().catch((e) => console.error('[bridge] gagal menyala:', e))
  const board = new Board(join(app.getPath('userData'), 'grove.sqlite'))
  await board.init()

  const emit = (ev: GroveEvent): void => {
    mainWindow?.webContents.send('grove:event', ev)
  }
  const manager = new SessionManager(board, emit)
  managerRef = manager
  manager.loadFromDisk() // muat session lama (dormant) agar history & context tetap terlihat
  registerIpc(manager)
  manager.startProcWatch() // pid & RAM tiap proses CLI → panel LOG
  // Tray WAJIB ada begitu keep-alive menyala (termasuk di dev): tanpa ikon ini, jendela yang
  // ditutup meninggalkan proses yang cuma bisa dimatikan lewat Task Manager.
  if (KEEP_ALIVE) createTray()

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

  const usageTarget = (): { id: string | null; label: string; token: string | null; provider?: AccountProvider } =>
    manager.getSessionAccountInfo(usageSessionId)

  /** Snapshot lengkap untuk akun yang sedang dipilih: identitas + angka (atau alasan kosongnya). */
  const snapshotFor = async (
    t: { id: string | null; label: string; token: string | null; provider?: AccountProvider },
    live: boolean
  ): Promise<UsageSnapshot> => {
    // provider ikut → akun API-key ditanyakan ke API-nya sendiri (kredit/saldo), bukan ke Anthropic.
    const acct = { id: t.id, token: t.token, provider: t.provider }
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
      // SEMUA akun disapu — termasuk yang ber-API-key. Dulu akun non-Claude dilewati total, jadi
      // kredit/saldo OpenRouter & DeepSeek tak pernah terpantau sama sekali. Sekarang fetchUsage
      // yang provider-aware mengarahkan tiap akun ke API-nya sendiri (lihat usage.ts).
      // Akun terpilih baru saja di-fetch di atas → pakai cache, jangan tembak endpoint dua kali.
      const r =
        a.id === t.id
          ? peekUsage(a.id)
          : await fetchUsage({ id: a.id, token: manager.getAccountToken(a.id), provider: a.provider })
      // Akun Claude → utilisasi jendela 5-jam. Akun API-key → persen kredit terpakai (null bila key
      // memang tak berbatas: ambangnya jujur TIDAK bisa ditegakkan, bukan diam-diam dianggap 0%).
      const pct = r.usage?.credit ? r.usage.credit.utilization : (r.usage?.fiveHour?.utilization ?? null)
      // 'scope'/'unauthorized'/'unsupported' = permanen tak terbaca. 'rate-limited'/'error' = gangguan
      // sesaat → JANGAN divonis non-aktif, nanti UI bohong ke arah sebaliknya.
      if (r.reason === 'scope' || r.reason === 'unauthorized' || r.reason === 'unsupported')
        manager.noteUsageReadable(a.id, false)
      else if (pct != null) manager.noteUsageReadable(a.id, true)
      else if (r.usage?.credit) manager.noteUsageReadable(a.id, false) // kredit terbaca tapi tanpa batas → ambang mati
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
    quitting = true // keluar sungguhan (tray/Cmd+Q) → handler 'close' tak perlu bertanya lagi
    // JANGAN stopAll di sini: itu mengubah status running→idle & menghapus info "sesi ini tadi kerja"
    // yang dipakai auto-resume saat dibuka lagi. Proses yang mati sendiri sudah mematikan query-nya.
    if (usageTimer) clearInterval(usageTimer) // hentikan timer usage 5-menit
    board.flush() // pastikan DB (termasuk status 'running') tersimpan saat keluar
  })

  createWindow()

  app.on('activate', () => showWindow())
})

// Menutup jendela TIDAK mematikan app (sesi lanjut di background; keluar lewat tray) — kecuali
// dijalankan dengan GROVE_QUIT_ON_CLOSE=1, yang mengembalikan perilaku "tutup = keluar".
app.on('window-all-closed', () => {
  if (!KEEP_ALIVE) app.quit()
})
