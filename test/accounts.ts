// Uji fitur multi-akun (main-process, tanpa SDK). Jalankan: npx tsx test/accounts.ts
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import type { GroveEvent } from '../src/shared/types'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TMP = join(process.cwd(), '.tmpacct')
let passed = 0
let failed = 0
const ok = (c: boolean, l: string): void => {
  c ? passed++ : failed++
  console.log(`  ${c ? '✓' : '✗'} ${l}`)
}

async function main(): Promise<void> {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const board = new Board(join(TMP, 'acct.sqlite'))
  await board.init()
  const events: GroveEvent[] = []
  const mgr = new SessionManager(board, (ev) => events.push(ev))
  mgr.loadFromDisk() // set autoSwitch dari settings (default false)

  ok(mgr.listAccounts().accounts.length === 0, 'awal: tak ada akun')
  ok(mgr.listAccounts().autoSwitch === false, 'awal: autoSwitch off')

  const a = mgr.addAccount('Kantor Max20', 'tok-KANTOR-secret')
  const b = mgr.addAccount('Pribadi Max5', 'tok-PRIBADI-secret')
  const list = mgr.listAccounts().accounts
  ok(list.length === 2, 'dua akun tersimpan')
  ok(list.every((x) => !('token' in x)), 'listAccounts TIDAK mengandung token (aman untuk UI)')
  ok(JSON.stringify(list).indexOf('secret') === -1, 'token tak bocor di listAccounts')

  ok(mgr.getAccountToken(a.id) === 'tok-KANTOR-secret', 'getAccountToken (main-only) benar')
  ok(mgr.getAccountToken(undefined) === null, 'getAccountToken tanpa id → null (login default)')

  const emitted = events.some((e) => e.channel === 'accounts:update')
  ok(emitted, 'emit accounts:update saat tambah akun')

  // Set akun ke session + tercermin di snapshot.
  const root = mgr.createRoot(join(TMP, 'proj'), 'Root')
  mgr.setSessionAccount(root.id, a.id)
  const node = mgr.getSnapshot().trees.find((t) => t.id === root.id)
  ok(node?.accountId === a.id, 'setSessionAccount tercermin di snapshot')
  mgr.setSessionAccount(root.id, null)
  ok(mgr.getSnapshot().trees[0].accountId === undefined, 'set null → kembali default')

  // autoSwitch persist.
  mgr.setAutoSwitch(true)
  ok(mgr.listAccounts().autoSwitch === true, 'setAutoSwitch(true) aktif')
  ok(board.getSetting('autoSwitch') === '1', 'autoSwitch tersimpan di settings DB')

  mgr.deleteAccount(b.id)
  ok(mgr.listAccounts().accounts.length === 1, 'hapus akun → sisa 1')

  board.flush()
  console.log(`\n[accounts] passed=${passed} failed=${failed}`)
  rmSync(TMP, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
void main()
