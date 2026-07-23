// Sub-worker buatan USER (klik 3× kartu sesi) → SessionManager.newWorker.
// Jalan di runtime Electron (SessionManager mengimpor `electron`), lihat scripts di package.json.
//
// Yang dibuktikan:
//  1. Worker lahir di POHON yang sama, sebagai anak kartu yang diklik, mewarisi folder kerja.
//  2. IDLE & tanpa riwayat: tidak ada giliran model yang dimulai (nol token sampai user mengetik).
//  3. Tak menyalin akun/model → tetap "ikut induk" (ganti akun di root menular).
//  4. Mode Lite diwarisi: pohon Lite tak diam-diam melahirkan worker berprotokol penuh.
//  5. Batas jumlah sesi per pohon ditegakkan, dan parent tak dikenal ditolak.
import { app } from 'electron'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import type { GroveEvent } from '../src/shared/types'

let failed = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'grove-worker-'))
  const board = new Board(join(dir, 'test.sqlite'))
  await board.init()
  const events: GroveEvent[] = []
  const mgr = new SessionManager(board, (e) => events.push(e))
  const acc = mgr.addAccount('AkunA', 'tok-A', 20)
  mgr.setDefaultAccount(acc.id)

  const root = await mgr.createRoot(dir, 'Root')

  // --- 1. anak dari kartu yang diklik, pohon & folder ikut induk ---
  const w1 = mgr.newWorker(root.id)
  check('worker jadi anak root', w1.parentId, root.id)
  check('worker di pohon yang sama', w1.treeId, root.treeId)
  check('worker role sub', w1.role, 'sub')
  check('worker mewarisi folder kerja', w1.cwd, root.cwd)
  check('judul default bernomor', w1.title, 'Worker 1')
  const tree = mgr.getSnapshot().trees.find((t) => t.id === root.id)
  check('muncul sebagai anak di pohon UI', tree?.children.map((c) => c.id), [w1.id])
  check('event session:new terkirim', events.filter((e) => e.channel === 'session:new').length, 2)

  // --- 2. idle & belum jalan: tak ada giliran model ---
  check('status idle', w1.status, 'idle')
  check('konteks masih 0', [w1.ctxInput, w1.ctxOutput], [0, 0])
  check('riwayat chat kosong (tak ada tugas terkirim)', mgr.getChat(w1.id).length, 0)

  // --- 3. akun & model tetap "ikut induk" ---
  check('worker tak menyimpan akun sendiri', w1.accountId ?? null, null)
  check('akun efektif = akun root', mgr.resolveAccountId(w1.id), acc.id)
  const accB = mgr.addAccount('AkunB', 'tok-B', 5)
  mgr.setSessionAccount(root.id, accB.id)
  check('ganti akun root menular ke worker', mgr.resolveAccountId(w1.id), accB.id)

  // --- 4. nomor urut & mode Lite diwarisi ---
  const w2 = mgr.newWorker(root.id)
  check('worker kedua bernomor 2', w2.title, 'Worker 2')
  check('worker root (non-lite) → non-lite', w2.lite ?? false, false)
  const chatDir = mkdtempSync(join(tmpdir(), 'grove-lite-'))
  const liteRoot = await mgr.createRoot(chatDir, 'Chat', true)
  const lw = mgr.newWorker(liteRoot.id)
  check('worker di pohon Lite → ikut lite', lw.lite, true)

  // worker bisa punya anak sendiri (klik 3× di kartu SUB)
  const w3 = mgr.newWorker(w1.id, 'Anak W1')
  check('worker boleh beranak', [w3.parentId, w3.treeId], [w1.id, root.treeId])

  // --- 5. batas & validasi ---
  let thrown = ''
  try {
    mgr.newWorker('tidak-ada')
  } catch (e) {
    thrown = String(e)
  }
  check('parent tak dikenal ditolak', /tidak ditemukan/.test(thrown), true)
  let capped = ''
  try {
    for (let i = 0; i < 20; i++) mgr.newWorker(root.id)
  } catch (e) {
    capped = String(e)
  }
  check('batas sesi per pohon ditegakkan', /Batas \d+ sesi per pohon/.test(capped), true)

  // --- 6. countRunning(): dasar konfirmasi "masih ada sesi bekerja" saat jendela ditutup ---
  check('tak ada sesi bekerja di awal', mgr.countRunning(), 0)
  // Tandai satu sesi seolah sedang bekerja (tanpa token, query tak bisa benar-benar start).
  const internal = mgr as unknown as { sessions: Map<string, { meta: { status: string } }> }
  internal.sessions.get(w1.id)!.meta.status = 'running'
  check('satu sesi bekerja terhitung', mgr.countRunning(), 1)
  internal.sessions.get(w2.id)!.meta.status = 'running'
  check('dua sesi bekerja terhitung', mgr.countRunning(), 2)
  internal.sessions.get(w1.id)!.meta.status = 'idle'
  internal.sessions.get(w2.id)!.meta.status = 'idle'
  check('kembali nol setelah selesai', mgr.countRunning(), 0)

  board.flush()
  await mgr.stopAll()
  for (const d of [dir, chatDir]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* Windows masih memegang file → folder temp, bukan kegagalan test. */
    }
  }
  console.log(failed ? `\n${failed} CHECK GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}

void app.whenReady().then(main)
