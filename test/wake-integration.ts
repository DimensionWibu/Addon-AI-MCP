// Uji INTEGRASI jalur wake pada SessionManager NYATA (bukan model/simulator).
// Jalan di runtime Electron karena SessionManager mengimpor `electron` — lihat script test:wake di
// package.json. TIDAK memanggil API: sesi sengaja dibiarkan TANPA akun, sehingga Session.start()
// berhenti sendiri (butuh token) dan tak ada query SDK yang lahir. Yang diukur adalah SIAPA yang
// memanggil injectAutoTask (= satu giliran root) dan BERAPA KALI — itu inti seluruh perbaikan.
import { app } from 'electron'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import { WAKE } from '../src/main/orchestrator/wakePolicy'
import type { GroveEvent, SessionStatus } from '../src/shared/types'

let failed = 0
let passed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Rekaman satu wake: teks yang benar-benar disuntik ke konteks sesi. */
interface Wake { id: string; text: string }

async function main(): Promise<void> {
  // Timer dikecilkan ~250× supaya test selesai dalam hitungan detik. Ini SATU-SATUNYA alasan
  // WAKE bersifat mutable — perbandingan relatif antar-jendela tetap sama seperti produksi.
  WAKE.priorityMs = 20
  WAKE.coalesceMs = 150
  WAKE.rootStatusDebounceMs = 250

  const dir = mkdtempSync(join(tmpdir(), 'grove-wake-'))
  const board = new Board(join(dir, 'test.sqlite'))
  await board.init()
  const events: GroveEvent[] = []
  const mgr = new SessionManager(board, (e) => events.push(e))

  const root = mgr.createRoot(dir, 'ROOT UTAMA')
  const w1 = await mgr.spawnWorker(root.id, { title: 'Worker Satu', task: 'kerjakan A' })
  const w2 = await mgr.spawnWorker(root.id, { title: 'Worker Dua', task: 'kerjakan B' })

  // Sadap injectAutoTask pada tiap sesi = penghitung giliran. Sesi memang tak bisa start (tanpa
  // akun), tapi kita ingin menghitung PANGGILANNYA, bukan efek SDK-nya.
  const sessions = (mgr as unknown as { sessions: Map<string, { meta: { status: SessionStatus }; injectAutoTask(t: string): void }> }).sessions
  const wakes: Wake[] = []
  for (const [id, s] of sessions) s.injectAutoTask = (text: string): void => void wakes.push({ id, text })
  const setStatus = (id: string, st: SessionStatus): void => void (sessions.get(id)!.meta.status = st)
  const rootWakes = (): Wake[] => wakes.filter((w) => w.id === root.id)
  const reset = (): void => void (wakes.length = 0)

  // --- I1. Laporan progres NON-FINAL tidak boleh membangunkan root sama sekali (FIX 3) ---
  setStatus(w1, 'running')
  mgr.reportToParent(w1, { status: 'baca file', percent: 25 })
  mgr.reportToParent(w1, { status: 'analisa', percent: 50 })
  mgr.reportToParent(w1, { status: 'tulis fix', percent: 75 })
  await sleep(WAKE.coalesceMs + WAKE.rootStatusDebounceMs + 150)
  check(`I1. 3 laporan progres → 0 giliran root (dapat ${rootWakes().length})`, rootWakes().length === 0)
  check('I1b. board TETAP terupdate (percent 75 tersimpan)', board.getBoardEntry(w1)?.percent === 75)

  // --- I2. Worker selesai: lapor 100% DI TENGAH turn + turn berakhir → TEPAT SATU giliran (FIX 1) ---
  reset()
  mgr.reportToParent(w1, { status: 'beres', percent: 100 }) // masih running → ditahan (awaitTurnEnd)
  await sleep(WAKE.priorityMs + 40)
  check('I2a. lapor 100% di tengah turn belum membangunkan root', rootWakes().length === 0)
  setStatus(w1, 'idle')
  mgr.notifyTurnEnd(w1, { finalText: 'HASIL AKHIR w1: patch di src/foo.ts' })
  await sleep(WAKE.coalesceMs + WAKE.rootStatusDebounceMs + 200)
  check(`I2b. satu penutupan worker = 1 giliran root (dapat ${rootWakes().length})`, rootWakes().length === 1)
  check('I2c. giliran itu memuat hasil akhir worker', /HASIL AKHIR w1/.test(rootWakes()[0]?.text ?? ''))
  check('I2d. progres lama ikut menumpang, bukan giliran sendiri', /Worker Satu/.test(rootWakes()[0]?.text ?? ''))

  // --- I3. Turn-end ULANG dengan isi identik → tak ada giliran tambahan (FIX 6) ---
  reset()
  mgr.notifyTurnEnd(w1, { finalText: 'HASIL AKHIR w1: patch di src/foo.ts' })
  await sleep(WAKE.coalesceMs + WAKE.rootStatusDebounceMs + 200)
  check(`I3. laporan identik → 0 giliran tambahan (dapat ${rootWakes().length})`, rootWakes().length === 0)

  // --- I4. Dua worker selesai berdekatan → SATU giliran gabungan, bukan dua ---
  reset()
  setStatus(w2, 'running')
  mgr.reportToParent(w2, { status: 'beres', percent: 100 })
  setStatus(w2, 'idle')
  mgr.notifyTurnEnd(w2, { finalText: 'HASIL AKHIR w2: dokumentasi diperbarui' })
  mgr.notifyTurnEnd(w1, { finalText: 'HASIL AKHIR w1: revisi kedua' })
  await sleep(WAKE.coalesceMs + WAKE.rootStatusDebounceMs + 250)
  const combined = rootWakes()
  check(`I4a. dua worker selesai berbarengan = 1 giliran (dapat ${combined.length})`, combined.length === 1)
  check(
    'I4b. giliran gabungan memuat KEDUA worker',
    /Worker Satu/.test(combined[0]?.text ?? '') && /Worker Dua/.test(combined[0]?.text ?? '')
  )

  // --- I5. Ping board ke root: ringkas, tanpa baris root sendiri, larang read_board (FIX 4) ---
  reset()
  const g1 = await mgr.spawnWorker(w1, { title: 'Cucu Worker', task: 'sub-tugas' }) // cucu → ping board
  const gs = sessions.get(g1)!
  gs.injectAutoTask = (text: string): void => void wakes.push({ id: g1, text })
  sessions.get(w1)!.injectAutoTask = (text: string): void => void wakes.push({ id: w1, text })
  setStatus(g1, 'running')
  mgr.reportToParent(g1, { status: 'cucu jalan', percent: 40 })
  await sleep(WAKE.rootStatusDebounceMs + 250)
  const ping = rootWakes()[0]?.text ?? ''
  check(`I5a. worker cucu tetap membangunkan root lewat ping board (dapat ${rootWakes().length})`, rootWakes().length === 1)
  check('I5b. ping melarang read_board', /JANGAN read_board/.test(ping))
  check('I5c. ping TIDAK memuat baris root sendiri', !/ROOT UTAMA/.test(ping))
  check(`I5d. ping ringkas (${ping.length} char < 900)`, ping.length < 900)

  await mgr.stopAll().catch(() => 0)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* file DB masih dipegang → abaikan, ini folder temp */
  }
  console.log(`\n${failed === 0 ? '✅ SEMUA LULUS' : `❌ ${failed} GAGAL`}  (${passed} lulus)`)
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (e) {
    failed++
    console.error('ERROR:', e)
  }
  app.exit(failed === 0 ? 0 : 1)
})
