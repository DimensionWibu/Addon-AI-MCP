// UKUR LAG KOLOM CHAT. Bundle renderer sungguhan + chat-log yang REALISTIS (ratusan pesan, blok
// tool, pohon LOG), lalu ketik 40 karakter dan ukur waktu per ketikan.
//
// Kenapa ini bisa lag: handler `input` memanggil autoGrow → set height='auto' lalu BACA scrollHeight.
// Membaca scrollHeight memaksa layout SINKRON untuk SELURUH dokumen; makin panjang chat-log, makin
// mahal tiap ketikan. Angka di bawah membuktikan efeknya, dan efek perbaikannya.
// Jalankan: npm run test:typing
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname ?? process.cwd(), '..')
const RENDERER = join(ROOT, 'out', 'renderer', 'index.html')
const TMP = join(ROOT, '.tmp')
const MSGS = Number(process.env.PERF_MSGS || 400)
const KEYS = 40

const STUB_PRELOAD = `
import { contextBridge } from 'electron'
const listeners = []
const meta = { id: 's1', treeId: 's1', parentId: null, role: 'root', title: 'Perf', cwd: 'C:/tmp',
  status: 'idle', ctxInput: 0, ctxOutput: 0, ctxWindow: 200000, createdAt: Date.now(), updatedAt: Date.now() }
const impl = {
  getSnapshot: async () => ({ trees: [{ ...meta, ctxPercent: 0, children: [] }], board: [], messages: [], memories: [] }),
  getChat: async () => [], listAccounts: async () => ({ accounts: [], autoSwitch: false, autoResume: false, defaultSwitchPct: 90, defaultAccountId: null, defaultModel: null, defaultEffort: null }),
  listQueued: async () => [], listReferences: async () => [], getDeepseekCosts: async () => [],
  getUsageStats: async () => ({ hour: {}, day: {}, week: {}, allTime: {}, daily: [], byAccount: [], todayVsAvg: null }),
  setUsageSession: async () => ({ accountId: null, accountLabel: 's', accountEmail: null, usage: null, reason: 'no-token' }),
  refreshUsage: async () => ({ accountId: null, accountLabel: 's', accountEmail: null, usage: null, reason: 'no-token' }),
  getPathForFile: () => '', onEvent: (cb) => { listeners.push(cb); return () => {} }
}
const NAMES = ['getPathForFile','dropFolder','newChat','newWorker','pickFolder','setSessionCwd','sendChat','askSide','getDeepseekCosts','listQueued','editQueued','cancelQueued','linkReference','unlinkReference','listReferences','stopSession','stopAll','reorderSessions','compactSession','setLoop','listAccounts','addAccount','deleteAccount','setAccountSwitchPct','setDefaultSwitchPct','setDefaultAccount','setDefaultModel','setSessionModel','setSessionEffort','setDefaultEffort','setLite','listOpenRouterModels','getUsageStats','setSessionAccount','setAutoSwitch','setAutoResume','interruptSession','deleteSession','getSnapshot','getChat','refreshUsage','setUsageSession','onEvent']
const api = {}
for (const n of NAMES) api[n] = (...a) => (impl[n] ? impl[n](...a) : Promise.resolve(null))
contextBridge.exposeInMainWorld('grove', api)
contextBridge.exposeInMainWorld('__probe', { emit: (ev) => { for (const cb of listeners) cb(ev) } })
`

async function main(): Promise<void> {
  if (!existsSync(RENDERER)) {
    console.log('jalankan "npm run build" dulu')
    app.exit(1)
    return
  }
  mkdirSync(TMP, { recursive: true })
  const preload = join(TMP, 'perf-preload.mjs')
  writeFileSync(preload, STUB_PRELOAD, 'utf8')
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    webPreferences: { preload, contextIsolation: true, sandbox: false, nodeIntegration: false }
  })
  await win.loadFile(RENDERER)
  await new Promise((r) => setTimeout(r, 700))
  const js = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code)

  const measure = async (): Promise<number> =>
    (await js(`(async () => {
    const ta = document.getElementById('chat-input')
    ta.focus(); ta.value = ''
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()))
    await nextFrame()
    let total = 0
    for (let i = 0; i < ${KEYS}; i++) {
      const t0 = performance.now()
      ta.value += 'x'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      window.__syncTotal = (window.__syncTotal || 0) + (performance.now() - t0) // kerja SINKRON handler
      await nextFrame()
      total += performance.now() - t0
    }
    ta.value = ''
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return total
  })()`)) as number

  const emptyMs = await measure() // baseline: chat kosong = lantai vsync mesin ini

  // Isi lewat JALUR ASLI aplikasi (event chat:message): markdown dirender penuh — tabel, blok kode,
  // inline code — dan pohon LOG ikut dibangun, persis seperti sesi panjang sungguhan.
  const md = (i: number): string =>
    [
      `Analisa bagian ${i} dari alur login DANA.`,
      '',
      '| Operasi | Nilai X-Public-ID |',
      '|---|---|',
      '| checkRegisteredUser | SHA256(phone) hash nomor HP (baris 1049) |',
      '| trust.risk.login | this.pref.publicUserId (baris 1052) |',
      '',
      'Kode terkait:',
      '',
      '```js',
      `this.pref.publicUserId = json.result.publicUserId // ${i}`,
      `const x = compute(${i})`,
      '```',
      '',
      'Jadi `X-Public-ID` diberikan server saat login pertama, lalu dipakai ulang.'
    ].join(String.fromCharCode(10))
  const msgs = Array.from({ length: MSGS }, (_, i) =>
    i % 3 === 0
      ? { role: 'tool', text: `Read E:/proyek/file${i}.js`, ts: Date.now(), detail: `function contoh() { return ${i} }`.repeat(12), toolUseId: `t${i}` }
      : { role: 'assistant', text: md(i), ts: Date.now() }
  )
  await js(`(async () => {
    const msgs = ${JSON.stringify(msgs)}
    for (let i = 0; i < msgs.length; i++) {
      window.__probe.emit({ channel: 'chat:message', payload: { id: 's1', message: msgs[i] } })
      if (i % 50 === 0) await new Promise((r) => setTimeout(r, 0))
    }
  })()`)
  await new Promise((r) => setTimeout(r, 400))

  // MODE STREAMING (PERF_STREAM=1): worker sedang membalas — event chat:delta mengalir terus
  // seperti sesi nyata. Inilah kondisi yang dikeluhkan: mengetik SAMBIL worker bekerja.
  if (process.env.PERF_STREAM === '1') {
    await js(`(() => {
      window.__stream = setInterval(() => {
        window.__probe.emit({ channel: 'chat:delta', payload: { id: 's1', delta: 'token berikutnya mengalir ' } })
      }, 30)
    })()`)
    await new Promise((r) => setTimeout(r, 600))
  }

  // KONTROL: biaya layout paksa MURNI (tanpa event input) = lantai yang tak bisa diperbaiki dari
  // sisi aplikasi. Selisih terhadap angka di bawahnya = biaya handler ketikan Grove yang sebenarnya.
  const baseMs = (await js(`(() => {
    const ta = document.getElementById('chat-input')
    const t0 = performance.now()
    for (let i = 0; i < ${KEYS}; i++) { ta.value += 'y'; void ta.offsetHeight }
    const dt = performance.now() - t0
    ta.value = ''
    return dt
  })()`)) as number

  await js(`window.__syncTotal = 0`)
  const ms = await measure() // dengan chat penuh
  const syncMs = (await js(`window.__syncTotal`)) as number

  if (process.env.PERF_STREAM === '1') await js(`clearInterval(window.__stream)`)
  const per = ms / KEYS
  const empty = emptyMs / KEYS
  const delta = per - empty
  console.log(`
chat-log ${MSGS} pesan markdown (tabel + blok kode + detail tool) - ${KEYS} ketikan`)
  console.log(`chat KOSONG   : ${empty.toFixed(2)} ms/ketikan  (lantai vsync mesin ini)`)
  console.log(`chat PENUH    : ${per.toFixed(2)} ms/ketikan`)
  console.log(`-> beban isi chat: ${delta.toFixed(2)} ms/ketikan`)
  console.log(`kerja SINKRON handler (yang membekukan UI): ${(syncMs / KEYS).toFixed(2)} ms/ketikan`)
  console.log(delta < 2 ? 'OK: isi chat nyaris tak menambah beban' : delta < 6 ? 'PERHATIAN: mulai terasa' : 'LAG: isi chat membebani tiap ketikan')
  app.exit(delta >= 6 ? 1 : 0)
}

void app.whenReady().then(main)
