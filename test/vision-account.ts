// AKUN PEMBACA GAMBAR (OCR) yang DIPILIH USER harus benar-benar dipakai duluan — termasuk saat akun
// itu baru saja gagal (pilihan user tak boleh diam-diam digeser Grove) — dan bertahan setelah restart.
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import { startOpenAiBridge } from '../src/main/openaiBridge'

let failed = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

async function main(): Promise<void> {
  await startOpenAiBridge()
  const dir = mkdtempSync(join(tmpdir(), 'grove-va-'))
  const dbPath = join(dir, 'va.sqlite')
  const b = new Board(dbPath)
  await b.init()
  const mgr = new SessionManager(b, () => {})
  const gw = mgr.addAccount('Gateway', 'sk_live_x', undefined, undefined, 'dzax', 'claude-sonnet-5', 'https://shiteru.id/v1')
  const cl = mgr.addAccount('Langganan', 'sk-ant-oat', 20)
  mgr.setDefaultAccount(gw.id) // akun global = gateway (kasus user: yang kuota gambarnya habis)

  check('tanpa setelan: akun GLOBAL yang dicoba duluan', mgr.getVisionLaunches()[0].label, 'Gateway')

  mgr.setVisionAccount(cl.id)
  check('setelah dipilih: akun OCR yang duluan', mgr.getVisionLaunches()[0].label, 'Langganan')
  check('akun lain tetap jadi cadangan', mgr.getVisionLaunches().length, 2)

  // Pilihan user TIDAK boleh digeser oleh cooldown kegagalan.
  mgr.noteVisionFailure(cl.id)
  check('pilihan user tetap pertama walau baru gagal', mgr.getVisionLaunches()[0].label, 'Langganan')

  // Akun yang dihapus → setelan kembali otomatis, bukan menunjuk akun hantu.
  check('terbaca di listAccounts', mgr.listAccounts().visionAccountId, cl.id)
  mgr.deleteAccount(cl.id)
  check('akun OCR dihapus → kembali otomatis', mgr.listAccounts().visionAccountId, null)

  // Bertahan restart.
  const cl2 = mgr.addAccount('Langganan2', 'sk-ant-oat2', 20)
  mgr.setVisionAccount(cl2.id)
  b.flush()
  const b2 = new Board(dbPath)
  await b2.init()
  const mgr2 = new SessionManager(b2, () => {})
  mgr2.loadFromDisk()
  check('setelan bertahan setelah restart', mgr2.listAccounts().visionAccountId, cl2.id)
  check('dan tetap jadi kandidat pertama', mgr2.getVisionLaunches()[0].label, 'Langganan2')

  await mgr.stopAll()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows */ }
  console.log(failed ? `\n${failed} GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}
void app.whenReady().then(main)
