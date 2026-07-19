// Uji ISOLASI antar-pohon TANPA SDK (hanya jalur guard sinkron; tak ada query()).
// Buktikan: aksi satu session tak bisa nyasar ke root/UTAMA lain atau sub-session pohon lain.
// Jalankan: npx tsx test/isolation.ts
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import type { GroveEvent } from '../src/shared/types'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TMP = join(process.cwd(), '.tmpiso')
const DB = join(TMP, 'iso.sqlite')

let passed = 0
let failed = 0
function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++
    console.log('  ✓', label)
  } else {
    failed++
    console.error('  ✗', label)
  }
}
function throws(fn: () => void, label: string): void {
  try {
    fn()
    ok(false, `${label} (seharusnya throw, tapi tidak)`)
  } catch {
    ok(true, label)
  }
}

async function main(): Promise<void> {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const board = new Board(DB)
  await board.init()
  const emit = (_ev: GroveEvent): void => {}
  const mgr = new SessionManager(board, emit)

  // Dua pohon terpisah (dormant → tanpa SDK).
  const A = mgr.createRoot(join(TMP, 'projA'), 'Root A')
  const B = mgr.createRoot(join(TMP, 'projB'), 'Root B')
  ok(A.treeId !== B.treeId, 'dua root punya treeId berbeda')

  // 1) send_message lintas-pohon DITOLAK; sepohon (ke diri sendiri) DIIZINKAN.
  throws(() => mgr.sendMessage(A.id, B.id, 'halo pohon lain'), 'send_message A→B (beda pohon) ditolak')
  ok(
    (() => {
      try {
        mgr.sendMessage(A.id, A.id, 'catatan sendiri')
        return true
      } catch {
        return false
      }
    })(),
    'send_message sepohon diizinkan'
  )

  // 2) assign_worker lintas-pohon & ke diri sendiri DITOLAK (sebelum menyentuh SDK).
  throws(() => mgr.assignToWorker(A.id, B.id, 'kerjakan ini'), 'assign_worker A→B (beda pohon) ditolak')
  throws(() => mgr.assignToWorker(A.id, A.id, 'kerjakan ini'), 'assign_worker ke diri sendiri ditolak')

  // 3) Broadcast tak lintas-pohon: pesan broadcast dari A tak terbaca oleh pohon B.
  mgr.sendMessage(A.id, null, 'broadcast-pohon-A')
  const seenByB = mgr.readMessages(B.id, false)
  ok(seenByB.every((m) => m.body !== 'broadcast-pohon-A'), 'broadcast A tidak terbaca oleh root B')
  const seenByA = mgr.readMessages(A.id, false)
  ok(seenByA.some((m) => m.body === 'broadcast-pohon-A'), 'broadcast A terbaca oleh root A sendiri')

  // 4) list_workers hanya pohon caller.
  const wa = mgr.listWorkers(A.id)
  ok(wa.length === 1 && wa[0].id === A.id, 'list_workers A hanya berisi pohon A')

  // 5) report_to_parent oleh root (tak punya parent) = no-op aman (tak throw, tak wake).
  ok(
    (() => {
      try {
        mgr.reportToParent(A.id, { status: 'progress root', percent: 50 })
        return true
      } catch {
        return false
      }
    })(),
    'report_to_parent pada root aman (no parent → tak nyasar)'
  )

  // 6) Reorder manual (drag) dalam grup role sama (dua root) → set orderIndex; id asing ditolak.
  mgr.reorderSessions([B.id, A.id])
  const snap = mgr.getSnapshot()
  const bNode = snap.trees.find((t) => t.id === B.id)
  const aNode = snap.trees.find((t) => t.id === A.id)
  ok(bNode?.orderIndex === 0 && aNode?.orderIndex === 1, 'reorder: orderIndex B=0, A=1 (urutan berubah)')
  throws(() => mgr.reorderSessions([A.id, 'tidak-ada']), 'reorder dengan id tak dikenal ditolak')

  board.flush()
  console.log(`\n[isolation] passed=${passed} failed=${failed}`)
  rmSync(TMP, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}

void main()
