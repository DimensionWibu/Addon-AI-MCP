// UJI KLIK 3× DI KARTU SESI — memuat BUNDLE RENDERER YANG SUDAH DI-BUILD (out/renderer) di dalam
// BrowserWindow sungguhan, dengan `window.grove` palsu (tanpa main-process, tanpa DB, tanpa token).
// Jalankan: npm run build && npm run test:triple
//
// Dua jalur klik diuji, karena keduanya nyata:
//  A. sendInputEvent — jalur input Chromium yang SEBENARNYA (persis klik manusia, detail 1/2/3).
//  B. MouseEvent sintetis ber-detail 1 tiga kali — meniru kasus yang bikin versi pertama gagal:
//     kartu dibangun ulang di tengah rentetan klik sehingga hitungan `detail` bawaan browser reset.
// Keduanya HARUS memanggil newWorker tepat sekali dengan id kartu yang diklik.
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname ?? process.cwd(), '..')
const RENDERER = join(ROOT, 'out', 'renderer', 'index.html')
const TMP = join(ROOT, '.tmp')

let failed = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

const SESSION_ID = 'sess-root-0001'

/** Preload palsu: window.grove yang mencatat panggilan, tanpa menyentuh main-process asli. */
const STUB_PRELOAD = `
import { contextBridge } from 'electron'
const calls = []
const listeners = []
const meta = {
  id: '${SESSION_ID}', sdkSessionId: undefined, treeId: '${SESSION_ID}', parentId: null, role: 'root',
  title: 'Root uji', cwd: 'C:/tmp/proyek', status: 'idle', ctxInput: 0, ctxOutput: 0, ctxWindow: 200000,
  createdAt: Date.now(), updatedAt: Date.now()
}
const workerMeta = { ...meta, id: 'sess-worker-0002', parentId: '${SESSION_ID}', role: 'sub', title: 'Worker 1' }
const impl = {
  getSnapshot: async () => ({ trees: [{ ...meta, ctxPercent: 0, children: [] }], board: [], messages: [], memories: [] }),
  getChat: async () => [],
  listAccounts: async () => ({ accounts: [], autoSwitch: false, autoResume: false, defaultSwitchPct: 90, defaultAccountId: null, defaultModel: null, defaultEffort: null }),
  listQueued: async () => [],
  listReferences: async () => [],
  getUsageStats: async () => ({ hour: {}, day: {}, week: {}, allTime: {}, daily: [], byAccount: [], todayVsAvg: null }),
  getDeepseekCosts: async () => [],
  setUsageSession: async () => ({ accountId: null, accountLabel: 'stub', accountEmail: null, usage: null, reason: 'no-token' }),
  refreshUsage: async () => ({ accountId: null, accountLabel: 'stub', accountEmail: null, usage: null, reason: 'no-token' }),
  newWorker: async (parentId, title) => { return workerMeta },
  cancelQueued: async () => true,
  interruptSession: async () => undefined,
  getPathForFile: () => '',
  onEvent: (cb) => { listeners.push(cb); return () => {} }
}
// contextBridge TIDAK bisa meng-clone Proxy → objek eksplisit. Nama diambil dari GroveApi;
// yang tak ada implementasinya cukup mencatat panggilan lalu balas null.
const NAMES = [
  'getPathForFile','dropFolder','newChat','newWorker','pickFolder','setSessionCwd','sendChat','askSide',
  'getDeepseekCosts','listQueued','editQueued','cancelQueued','linkReference','unlinkReference','listReferences',
  'stopSession','stopAll','reorderSessions','compactSession','setLoop','listAccounts','addAccount','deleteAccount',
  'setAccountSwitchPct','setDefaultSwitchPct','setDefaultAccount','setDefaultModel','setSessionModel',
  'setSessionEffort','setDefaultEffort','setLite','listOpenRouterModels','getUsageStats','setSessionAccount',
  'setAutoSwitch','setAutoResume','interruptSession','deleteSession','getSnapshot','getChat','refreshUsage',
  'setUsageSession','onEvent'
]
const api = {}
for (const name of NAMES) {
  api[name] = (...args) => {
    if (name !== 'onEvent') calls.push({ name, args })
    const f = impl[name]
    return f ? f(...args) : Promise.resolve(null)
  }
}
contextBridge.exposeInMainWorld('grove', api)
contextBridge.exposeInMainWorld('__probe', {
  calls: () => calls.map((c) => ({ name: c.name, args: c.args })),
  reset: () => { calls.length = 0 },
  // Dorong event grove:* seperti main-process sungguhan → bisa mensimulasikan sesi RUNNING & antrian.
  emit: (ev) => { for (const cb of listeners) cb(ev) }
})
`

async function main(): Promise<void> {
  if (!existsSync(RENDERER)) {
    console.log(`FAIL  bundle renderer belum ada di ${RENDERER} — jalankan "npm run build" dulu`)
    app.exit(1)
    return
  }
  mkdirSync(TMP, { recursive: true })
  const preload = join(TMP, 'stub-preload.mjs')
  writeFileSync(preload, STUB_PRELOAD, 'utf8')

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // Jendela HARUS tampil: pada window tersembunyi Chromium menunda layout, sehingga clientHeight/
    // scrollHeight tak mencerminkan keadaan nyata dan uji gulir jadi omong kosong.
    show: true,
    webPreferences: { preload, contextIsolation: true, sandbox: false, nodeIntegration: false }
  })
  const errors: string[] = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message) // 2 = warning, 3 = error
  })
  await win.loadFile(RENDERER)
  await new Promise((r) => setTimeout(r, 800)) // biarkan init renderer selesai

  const js = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code)

  // Kartu sesi harus sudah ter-render dari getSnapshot palsu.
  const cardCount = await js(`document.querySelectorAll('.node').length`)
  check('kartu sesi ter-render dari snapshot', cardCount, 1)
  if (cardCount !== 1) {
    console.log(errors.length ? `\nconsole renderer:\n${errors.join('\n')}` : '')
    app.exit(1)
    return
  }

  // --- A. jalur input Chromium yang sebenarnya (klik manusia) ---
  const box = (await js(
    `(() => { const r = document.querySelector('.node').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) } })()`
  )) as { x: number; y: number }
  await js(`window.__probe.reset()`)
  for (let i = 1; i <= 3; i++) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: i })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: i })
    await new Promise((r) => setTimeout(r, 60)) // ritme klik manusia yang cepat
  }
  await new Promise((r) => setTimeout(r, 300))
  let calls = (await js(`window.__probe.calls()`)) as Array<{ name: string; args: unknown[] }>
  const spawnA = calls.filter((c) => c.name === 'newWorker')
  check('A. klik 3× (input Chromium) → newWorker dipanggil sekali', spawnA.length, 1)
  check('A. parent-nya kartu yang diklik', spawnA[0]?.args?.[0], SESSION_ID)

  // --- B. tiga klik yang masing-masing "klik pertama" (detail 1) ---
  // Inilah kasus yang gagal di versi pertama: hitungan bawaan browser reset saat kartu dibangun
  // ulang di tengah rentetan klik.
  await js(`window.__probe.reset()`)
  await js(
    `(() => { const el = document.querySelector('.node');
       for (let i = 0; i < 3; i++) el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })()`
  )
  await new Promise((r) => setTimeout(r, 300))
  calls = (await js(`window.__probe.calls()`)) as Array<{ name: string; args: unknown[] }>
  const spawnB = calls.filter((c) => c.name === 'newWorker')
  check('B. 3 klik ber-detail 1 → tetap terdeteksi (sekali)', spawnB.length, 1)

  // --- C. klik tunggal biasa TIDAK boleh bikin worker ---
  await js(`window.__probe.reset()`)
  await js(`document.querySelector('.node').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`)
  await new Promise((r) => setTimeout(r, 900)) // lewat jendela 700ms → rentetan berakhir
  await js(`document.querySelector('.node').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`)
  await new Promise((r) => setTimeout(r, 200))
  calls = (await js(`window.__probe.calls()`)) as Array<{ name: string; args: unknown[] }>
  check('C. klik lambat/terpisah TIDAK bikin worker', calls.filter((c) => c.name === 'newWorker').length, 0)

  // --- D. AUTO-SCROLL: berhenti saat digulir ke atas, tombol muncul, nyala lagi saat kembali ---
  await js(
    `(() => { const log = document.getElementById('chat-log');
       for (let i = 0; i < 120; i++) { const d = document.createElement('div'); d.className = 'msg assistant'; d.textContent = 'baris ' + i; log.append(d) }
       log.scrollTop = log.scrollHeight })()`
  )
  await new Promise((r) => setTimeout(r, 150))
  check('D. di dasar → tombol lompat tersembunyi', await js(`document.getElementById('chat-jump').hidden`), true)
  await js(`(() => { const log = document.getElementById('chat-log'); log.scrollTop = 0; log.dispatchEvent(new Event('scroll')) })()`)
  await new Promise((r) => setTimeout(r, 150))
  check('D. digulir ke atas → tombol lompat muncul', await js(`document.getElementById('chat-jump').hidden`), false)
  // Diagnostik: apakah posisi bertahan TANPA ada pesan baru sama sekali?
  // Pesan baru datang saat user membaca di atas → JANGAN diseret ke bawah.
  await js(
    `(() => { const log = document.getElementById('chat-log'); const d = document.createElement('div'); d.className='msg assistant'; d.textContent='pesan baru'; log.append(d);
       window.__probe.emit({ channel: 'chat:message', payload: { id: '${SESSION_ID}', message: { role: 'assistant', text: 'pesan baru', ts: Date.now() } } }) })()`
  )
  await new Promise((r) => setTimeout(r, 250))
  // Yang wajib: pandangan TIDAK melompat ke dasar. (Chrome punya scroll-anchoring yang bisa
  // menggeser scrollTop beberapa piksel saat DOM tumbuh — itu bukan "diseret ke bawah".)
  const pos = (await js(
    `(() => { const l = document.getElementById('chat-log'); return { top: l.scrollTop, max: l.scrollHeight - l.clientHeight } })()`
  )) as { top: number; max: number }
  console.log(`        posisi gulir setelah pesan baru: ${pos.top}/${pos.max}`)
  check('D. pesan baru TIDAK menyeret pandangan ke dasar', pos.top < pos.max / 2, true)
  await js(`document.getElementById('chat-jump').click()`)
  await new Promise((r) => setTimeout(r, 250))
  check('D. tombol lompat → kembali ke dasar', await js(`(() => { const l = document.getElementById('chat-log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 60 })()`), true)
  check('D. tombol tersembunyi lagi setelah di dasar', await js(`document.getElementById('chat-jump').hidden`), true)

  // --- D2. PESAN BARU HARUS MENDARAT DI DASAR SEJATI (regresi: content-visibility membuat tinggi
  // item di luar layar cuma taksiran, jadi "paling bawah" meleset dan tiap prompt tampak naik) ---
  await js(`(() => { const l = document.getElementById('chat-log'); l.scrollTop = l.scrollHeight })()`)
  await new Promise((r) => setTimeout(r, 200))
  for (let i = 0; i < 5; i++) {
    await js(
      `window.__probe.emit({ channel: 'chat:message', payload: { id: '${SESSION_ID}', message: { role: 'user', text: 'prompt baru ' + ${i}, ts: Date.now() } } })`
    )
    await new Promise((r) => setTimeout(r, 120))
  }
  await new Promise((r) => setTimeout(r, 400)) // beri waktu pengendapan (settleBottom)
  const gap = (await js(
    `(() => { const l = document.getElementById('chat-log'); return Math.round(l.scrollHeight - l.scrollTop - l.clientHeight) })()`
  )) as number
  console.log(`        jarak ke dasar setelah 5 pesan baru: ${gap}px`)
  check('D2. pesan baru mendarat di dasar sejati (<=2px)', gap <= 2, true)

  // --- E. ESC: batalkan pesan terakhir & kembalikan ke kolom ketik ---
  await js(`window.__probe.reset()`)
  await js(
    `window.__probe.emit({ channel: 'queue:update', payload: { id: '${SESSION_ID}', items: [{ qid: 7, text: 'tugas yang mau dibatalkan' }] } })`
  )
  await new Promise((r) => setTimeout(r, 150))
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await new Promise((r) => setTimeout(r, 300))
  calls = (await js(`window.__probe.calls()`)) as Array<{ name: string; args: unknown[] }>
  const cancels = calls.filter((c) => c.name === 'cancelQueued')
  check('E. Esc membatalkan pesan yang masih antri', cancels.length, 1)
  check('E. qid yang dibatalkan = pesan terakhir', cancels[0]?.args?.[1], 7)
  check(
    'E. teksnya dikembalikan ke kolom ketik',
    await js(`document.getElementById('chat-input').value`),
    'tugas yang mau dibatalkan'
  )

  if (errors.length) console.log(`\ncatatan console renderer (${errors.length}):\n${errors.slice(0, 8).join('\n')}`)
  console.log(failed ? `\n${failed} CHECK GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}

void app.whenReady().then(main)
