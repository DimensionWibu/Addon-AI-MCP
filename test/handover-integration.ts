// Integrasi handover: buktikan JALUR NYATA-nya, bukan cuma penulisnya.
// compactSession()/notifyHighContext() → Session.compactWith() → host.beforeCompact() → file .md ada,
// dan ringkasan yang di-seed ke konteks baru MENUNJUK file itu.
// Jalan di runtime Electron (SessionManager mengimpor `electron`) — lihat scripts di package.json.
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import { handoverPath, handoverRel } from '../src/main/orchestrator/handover'
import type { GroveEvent } from '../src/shared/types'

let failed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : `\n        ${extra}`}`)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'grove-hoi-'))
  const board = new Board(join(dir, 'test.sqlite'))
  await board.init()
  const events: GroveEvent[] = []
  const mgr = new SessionManager(board, (e) => events.push(e))

  const work = join(dir, 'proyek')
  mkdirSync(work, { recursive: true })
  const root = await mgr.createRoot(work, 'Root')
  mgr.updateSummary(root.id, 'Membenahi panel kuota akun API.')
  mgr.reportProgress(root.id, 'menulis fetcher OpenRouter', 40)
  mgr.updateTodo(root.id, [
    { text: 'fetch /v1/key', done: true },
    { text: 'render panel kredit', done: false }
  ])

  // --- 1. Compact manual → file handover ADA & isinya dari papan ---
  const p = handoverPath(work, root.id)
  check('sebelum compact: file belum ada', !existsSync(p))
  mgr.compactSession(root.id)
  check('setelah compact: file handover ditulis', existsSync(p), p)
  const body = existsSync(p) ? readFileSync(p, 'utf8') : ''
  check('handover memuat ringkasan papan', body.includes('Membenahi panel kuota akun API.'), body.slice(0, 200))
  check('handover memuat todo yang belum selesai', body.includes('render panel kredit'))

  // --- 2. Chat sesi menyebut path handover (user & model sama-sama tahu ke mana harus melihat) ---
  const chat = mgr.getChat(root.id)
  const note = chat.filter((m) => m.role === 'system').map((m) => m.text).join('\n')
  check('nota compact menyebut path handover', note.includes(handoverRel(root.id)), note)

  // --- 3. Sub-worker punya FILE SENDIRI (root & sub berbagi cwd) ---
  const subId = await mgr.spawnWorker(root.id, { title: 'W1', task: 'noop' })
  mgr.updateSummary(subId, 'Tugas worker: parsing balasan /v1/credits.')
  mgr.notifyHighContext(subId) // jalur auto-compact untuk sub
  const ps = handoverPath(work, subId)
  check('sub menulis file handover sendiri', existsSync(ps), ps)
  check('nama file sub berbeda dari root', handoverRel(subId) !== handoverRel(root.id))
  const bodySub = existsSync(ps) ? readFileSync(ps, 'utf8') : ''
  check('handover sub memuat ringkasan sub', bodySub.includes('parsing balasan /v1/credits.'))
  check('handover sub TIDAK menimpa punya root', readFileSync(p, 'utf8').includes('Membenahi panel kuota akun API.'))

  // --- 4. Checkpoint SEGAR tulisan model dihormati (tidak ditimpa versi Grove) ---
  const marker = '## Key Decisions\n- MODEL YANG MENULIS INI\n'
  writeFileSync(p, marker, 'utf8')
  mgr.compactSession(root.id)
  check('checkpoint model yang segar tidak ditimpa', readFileSync(p, 'utf8') === marker, readFileSync(p, 'utf8').slice(0, 120))

  // --- 5. Checkpoint BASI (ditulis sebelum compact terakhir) → Grove menulis ulang, isi lama disimpan ---
  // File di atas kini lebih tua dari lastCompactAt sesi (compact barusan) → dianggap basi.
  mgr.compactSession(root.id)
  const after = readFileSync(p, 'utf8')
  check('checkpoint basi → Grove menulis ulang', after.includes('Ditulis OTOMATIS oleh Grove'), after.slice(0, 120))
  check('isi checkpoint lama tetap diselamatkan', after.includes('MODEL YANG MENULIS INI'))

  board.flush()
  await mgr.stopAll()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows masih memegang file DB → biarkan; folder temp. */
  }
  console.log(failed ? `\n${failed} CHECK GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}

void app.whenReady().then(main)
