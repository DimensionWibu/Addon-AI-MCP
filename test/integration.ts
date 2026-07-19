// Uji integrasi headless: memakai SessionManager + Board + SDK asli (bukan mock),
// meniru persis alur GUI. Jalankan: npx tsx test/integration.ts
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import type { GroveEvent } from '../src/shared/types'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TMP = join(process.cwd(), '.tmptest')
const DB = join(TMP, 'grove-test.sqlite')
const PROJ = join(TMP, 'proj')

const log = (...a: unknown[]): void => console.log('[test]', ...a)

type L = (ev: GroveEvent) => void
const listeners = new Set<L>()
const emit = (ev: GroveEvent): void => {
  for (const l of [...listeners]) l(ev)
}

function waitFor(pred: (ev: GroveEvent) => boolean, ms: number, label: string): Promise<GroveEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(l)
      reject(new Error(`timeout: ${label}`))
    }, ms)
    const l: L = (ev) => {
      if (pred(ev)) {
        clearTimeout(timer)
        listeners.delete(l)
        resolve(ev)
      }
    }
    listeners.add(l)
  })
}
const isUpdate = (ev: GroveEvent, id: string, status: string): boolean =>
  ev.channel === 'session:update' &&
  (ev.payload as { id: string }).id === id &&
  (ev.payload as { status?: string }).status === status
const waitIdle = (id: string, ms = 150000): Promise<GroveEvent> =>
  waitFor((ev) => isUpdate(ev, id, 'idle'), ms, `idle(${id.slice(0, 6)})`)

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    log('✅', msg)
  } else {
    failed++
    console.error('❌ FAIL:', msg)
  }
}

async function main(): Promise<void> {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(PROJ, { recursive: true })
  writeFileSync(
    join(PROJ, 'bug.js'),
    'function add(a, b) { return a - b } // harusnya a + b\nmodule.exports = { add }\n'
  )

  const board = new Board(DB)
  await board.init()
  const mgr = new SessionManager(board, emit)

  // ---- 1. root dormant + chat pertama (streaming, auto-title, persist, tools) ----
  log('--- 1. root + chat pertama ---')
  const root = mgr.createRoot(PROJ, 'Chat baru')
  let deltas = 0
  const dl: L = (ev) => {
    if (ev.channel === 'chat:delta' && ev.payload.id === root.id) deltas += ev.payload.delta.length
  }
  listeners.add(dl)
  mgr.sendChat(
    root.id,
    'Baca file bug.js, lalu dalam SATU kalimat sebutkan bug-nya. Panggil set_title juga. Setelah itu berhenti.'
  )
  await waitIdle(root.id)
  listeners.delete(dl)

  const hist = mgr.getChat(root.id)
  assert(
    hist.some((m) => m.role === 'assistant' && m.text.length > 0),
    'balasan assistant tersimpan ke DB'
  )
  assert(
    hist.some((m) => m.role === 'user'),
    'pesan user tersimpan ke DB'
  )
  assert(deltas > 0, `streaming delta diterima (${deltas} char)`)
  const rn = mgr.getSnapshot().trees.find((t) => t.id === root.id)!
  assert(rn.title !== 'Chat baru', `judul auto-ganti → "${rn.title}"`)
  assert(rn.ctxPercent > 0, `ctx% terisi → ${rn.ctxPercent}%`)
  assert(!!rn.sdkSessionId, `sdkSessionId tersimpan → ${rn.sdkSessionId?.slice(0, 8)}`)

  // ---- 2. spawn_worker + isolasi antar-pohon ----
  log('--- 2. spawn_worker + isolasi ---')
  const childId = await mgr.spawnWorker(root.id, { title: 'Sub uji', task: 'Diam saja.' })
  const rn2 = mgr.getSnapshot().trees.find((t) => t.id === root.id)!
  assert(
    rn2.children.some((c) => c.id === childId),
    'worker menjadi anak root (pohon berakar)'
  )
  const other = mgr.createRoot(PROJ, 'Chat baru') // pohon kedua, dormant
  const treeScope = mgr.readBoard(other.id, 'tree').map((b) => b.sessionId)
  assert(
    !treeScope.includes(root.id) && !treeScope.includes(childId),
    'isolasi: read_board scope=tree tak melihat pohon lain'
  )
  const allScope = mgr.readBoard(other.id, 'all').map((b) => b.sessionId)
  assert(allScope.includes(root.id), 'read_board scope=all melihat semua pohon')
  assert(
    !mgr.listWorkers(other.id).some((w) => w.id === root.id),
    'isolasi: list_workers hanya pohon sendiri'
  )
  await mgr.stopSession(childId)
  await mgr.stopSession(other.id)

  // ---- 3. restart: Board+Manager baru pada DB yang sama ----
  log('--- 3. restart (persist history + context) ---')
  board.flush()
  const board2 = new Board(DB)
  await board2.init()
  const mgr2 = new SessionManager(board2, emit)
  mgr2.loadFromDisk()
  const histAfter = mgr2.getChat(root.id)
  assert(histAfter.length === hist.length && histAfter.length > 0, 'history chat tetap ada setelah restart')
  const rn3 = mgr2.getSnapshot().trees.find((t) => t.id === root.id)!
  assert(rn3.status === 'idle', "status 'running' basi dinormalisasi → 'idle'")
  assert(rn3.ctxPercent > 0, `ctx% tetap tampil setelah restart → ${rn3.ctxPercent}%`)

  // ---- 4. resume: chat lagi → konteks nyambung ----
  log('--- 4. resume konteks ---')
  mgr2.sendChat(root.id, 'File apa yang tadi kamu baca? Jawab nama filenya saja.')
  await waitIdle(root.id)
  const last = [...mgr2.getChat(root.id)].reverse().find((m) => m.role === 'assistant')
  assert(!!last, 'ada balasan setelah resume')
  assert(/bug\.js/i.test(last?.text ?? ''), `resume nyambung konteks → "${(last?.text ?? '').slice(0, 50)}"`)

  // ---- 5. delete cascade ----
  log('--- 5. delete cascade ---')
  const removedEv = waitFor((ev) => ev.channel === 'session:removed', 15000, 'session:removed')
  const removed = await mgr2.deleteSession(root.id)
  await removedEv
  assert(removed.includes(root.id) && removed.includes(childId), 'delete cascade termasuk sub-worker')
  assert(!mgr2.getSnapshot().trees.some((t) => t.id === root.id), 'root hilang dari snapshot')
  assert(mgr2.getChat(root.id).length === 0, 'chat_messages ikut terhapus dari DB')

  await mgr2.stopSession(other.id).catch(() => {})
  board2.flush()
  console.log(`\n==== HASIL: ${passed} PASS, ${failed} FAIL ====`)
  process.exit(failed > 0 ? 1 : 0)
}

const guard = setTimeout(() => {
  console.error('GLOBAL TIMEOUT 5m')
  process.exit(2)
}, 300000)
main()
  .catch((e) => {
    console.error('TEST ERROR:', e)
    process.exit(1)
  })
  .finally(() => clearTimeout(guard))
