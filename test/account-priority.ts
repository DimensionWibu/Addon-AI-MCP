// URUTAN PRIORITAS ROTASI AKUN + "terapkan akun ke SEMUA sesi".
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'

let failed = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'grove-prio-'))
  const dbPath = join(dir, 'p.sqlite')
  const b = new Board(dbPath)
  await b.init()
  const mgr = new SessionManager(b, () => {})
  const kecil = mgr.addAccount('Kecil', 'tok-k', 5)
  const besar = mgr.addAccount('Besar', 'tok-b', 20)
  const mini = mgr.addAccount('Mini', 'tok-m', 1)

  // Tanpa urutan eksplisit: paket TERBESAR duluan (perilaku lama, tetap dipertahankan).
  check('tanpa urutan → paket terbesar duluan', mgr.pickAvailableAccount('x')?.label, 'Besar')

  // Dengan urutan: pilihan user menang atas ukuran paket.
  mgr.setAccountOrder([mini.id, kecil.id, besar.id])
  check('urutan user dihormati (Mini duluan)', mgr.pickAvailableAccount('x')?.label, 'Mini')
  check('akun sekarang dilewati (tak berputar ke diri sendiri)', mgr.pickAvailableAccount(mini.id)?.label, 'Kecil')
  check('urutan terbaca di listAccounts', mgr.listAccounts().accountOrder, [mini.id, kecil.id, besar.id])

  // Akun terhapus tak boleh menyumbat urutan.
  mgr.deleteAccount(mini.id)
  mgr.setAccountOrder(mgr.listAccounts().accountOrder)
  check('akun terhapus dibuang dari urutan', mgr.listAccounts().accountOrder, [kecil.id, besar.id])
  check('kandidat berikutnya ikut urutan tersisa', mgr.pickAvailableAccount('x')?.label, 'Kecil')

  // Terapkan ke semua sesi: menimpa pilihan per-sesi.
  const r1 = await mgr.createRoot(dir, 'S1')
  const r2 = await mgr.createRoot(dir, 'S2')
  mgr.setSessionAccount(r1.id, besar.id)
  mgr.setSessionAccount(r2.id, kecil.id)
  const n = mgr.applyAccountToAllSessions(kecil.id)
  check('jumlah sesi yang berubah', n, 1)
  check('sesi 1 ikut pindah', mgr.resolveAccountId(r1.id), kecil.id)
  check('sesi 2 tetap benar', mgr.resolveAccountId(r2.id), kecil.id)

  // Akun global OTOMATIS: ikut urutan prioritas, dan melewati akun yang sedang kena limit.
  mgr.setDefaultAccount('auto')
  mgr.setSessionAccount(r1.id, null) // kembali mengikuti global
  check('global auto → akun prioritas teratas', mgr.resolveAccountId(r1.id), kecil.id)
  ;(mgr as unknown as { markAccountLimited: (k: string) => void }).markAccountLimited(kecil.id)
  check('akun teratas kena limit → turun ke berikutnya', mgr.resolveAccountId(r1.id), besar.id)
  check('nilai auto terbaca di listAccounts', mgr.listAccounts().defaultAccountId, 'auto')

  // Urutan bertahan restart.
  b.flush()
  const b2 = new Board(dbPath)
  await b2.init()
  const mgr2 = new SessionManager(b2, () => {})
  mgr2.loadFromDisk()
  check('urutan bertahan setelah restart', mgr2.listAccounts().accountOrder, [kecil.id, besar.id])

  await mgr.stopAll()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows */ }
  console.log(failed ? `\n${failed} GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}
void app.whenReady().then(main)
