// UBAH AKUN TERSIMPAN — jalur yang dipakai tombol ✎ di ⚙ Akun.
// Yang dijaga: token TIDAK hilang saat tak diisi, endpoint & daftar model bisa dikoreksi,
// dan id akun TETAP (kalau berubah, riwayat pemakaian akun itu terputus).
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
  const dir = mkdtempSync(join(tmpdir(), 'grove-edit-'))
  const b = new Board(join(dir, 'e.sqlite'))
  await b.init()
  const mgr = new SessionManager(b, () => {})
  const acc = mgr.addAccount('Raw lama', 'sk_lama', undefined, undefined, 'dzax', 'model-a', 'https://lama.id/v1')

  // 1. koreksi endpoint + daftar model, token dibiarkan
  const up = mgr.updateAccount(acc.id, { baseUrl: 'https://baru.id/v1', model: 'model-b, model-c' })
  check('endpoint terkoreksi', up.baseUrl, 'https://baru.id/v1')
  check('daftar model terkoreksi', up.model, 'model-b, model-c')
  check('id akun TETAP (riwayat tak terputus)', up.id, acc.id)
  check('token lama dipertahankan', mgr.getAccountToken(acc.id), 'sk_lama')
  check('provider tak berubah', up.provider, 'dzax')

  // 2. ganti token
  mgr.updateAccount(acc.id, { token: 'sk_baru' })
  check('token bisa diganti', mgr.getAccountToken(acc.id), 'sk_baru')
  check('endpoint tak ikut hilang saat hanya token diganti', mgr.listAccounts().accounts.find((x) => x.id === acc.id)?.baseUrl, 'https://baru.id/v1')

  // 3. ganti label
  mgr.updateAccount(acc.id, { label: 'Raw baru' })
  check('label berubah', mgr.listAccounts().accounts.find((x) => x.id === acc.id)?.label, 'Raw baru')

  // 4. akun Claude: model/baseUrl tak berlaku, jangan sampai terisi diam-diam
  const cl = mgr.addAccount('Langganan', 'sk-ant-oat', 20)
  mgr.updateAccount(cl.id, { model: 'ngawur', baseUrl: 'http://ngawur' })
  const after = mgr.listAccounts().accounts.find((x) => x.id === cl.id)!
  check('akun Claude tak menerima model', after.model ?? null, null)
  check('akun Claude tak menerima base URL', after.baseUrl ?? null, null)

  // 5. akun tak ada → ditolak, bukan diam-diam membuat baru
  let err = ''
  try {
    mgr.updateAccount('tidak-ada', { label: 'x' })
  } catch (e) {
    err = String(e)
  }
  check('akun tak dikenal ditolak', /tidak ditemukan/.test(err), true)

  // 6. bertahan restart
  b.flush()
  const b2 = new Board(join(dir, 'e.sqlite'))
  await b2.init()
  const reloaded = b2.getAccounts().find((x) => x.id === acc.id)!
  check('perubahan bertahan setelah restart', [reloaded.label, reloaded.baseUrl, reloaded.model], ['Raw baru', 'https://baru.id/v1', 'model-b, model-c'])
  check('token bertahan setelah restart', b2.getAccountToken(acc.id), 'sk_baru')

  await mgr.stopAll()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows */ }
  console.log(failed ? `\n${failed} GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}
void app.whenReady().then(main)
