// Uji hapus session (main-process, tanpa SDK): pastikan state konsisten setelah delete + recreate.
// Jalankan: npx tsx test/delete.ts
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import type { GroveEvent } from '../src/shared/types'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TMP = join(process.cwd(), '.tmpdel')
let passed = 0
let failed = 0
const ok = (c: boolean, l: string): void => {
  c ? passed++ : failed++
  console.log(`  ${c ? '✓' : '✗'} ${l}`)
}

async function main(): Promise<void> {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const board = new Board(join(TMP, 'del.sqlite'))
  await board.init()
  const events: GroveEvent[] = []
  const mgr = new SessionManager(board, (ev) => events.push(ev))

  const A = mgr.createRoot(join(TMP, 'a'), 'A')
  ok(mgr.getSnapshot().trees.length === 1, 'setelah createRoot: 1 tree')

  const removed = await mgr.deleteSession(A.id)
  ok(removed.includes(A.id), 'deleteSession mengembalikan id yang dihapus')
  ok(mgr.getSnapshot().trees.length === 0, 'setelah delete: 0 tree')
  ok(
    events.some((e) => e.channel === 'session:removed' && (e.payload as { ids: string[] }).ids.includes(A.id)),
    'emit session:removed berisi id'
  )
  ok(mgr.getChat(A.id).length === 0, 'getChat sesi terhapus: kosong (tak crash)')

  // Race: kirim ke sesi yang sudah dihapus HARUS throw (renderer tak boleh menargetkan id basi).
  let threw = false
  try {
    mgr.sendChat(A.id, 'hi')
  } catch {
    threw = true
  }
  ok(threw, 'sendChat ke sesi terhapus → throw (bukan hang)')

  // Recreate + snapshot konsisten.
  const B = mgr.createRoot(join(TMP, 'b'), 'B')
  const snap = mgr.getSnapshot()
  ok(snap.trees.length === 1 && snap.trees[0].id === B.id, 'createRoot baru → snapshot benar')

  board.flush()
  console.log(`\n[delete] passed=${passed} failed=${failed}`)
  rmSync(TMP, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
void main()
