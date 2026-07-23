// AUTO-PINDAH MODEL saat gateway menolak (kuota model habis / tak diizinkan untuk key ini).
// Jalan di runtime Electron (SessionManager mengimpor `electron`).
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import { isModelRejected } from '../src/main/orchestrator/Session'
import { modelCandidates } from '../src/shared/types'
import { startOpenAiBridge } from '../src/main/openaiBridge'

let failed = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

async function main(): Promise<void> {
  await startOpenAiBridge() // env peluncuran akun gateway butuh port jembatan
  // --- detektor: hanya penolakan MODEL, bukan error lain ---
  check('deteksi kuota model habis', isModelRejected('{"error":{"code":"subscription_not_eligible"}}'), true)
  check('deteksi model tak diizinkan', isModelRejected('Key is not allowed to use model claude-opus-4-8'), true)
  check('deteksi model tak dikenal', isModelRejected('{"code":"model_not_found"}'), true)
  check('rate limit BUKAN penolakan model', isModelRejected('rate_limit_error: too many requests'), false)
  check('koneksi putus BUKAN penolakan model', isModelRejected('ECONNRESET'), false)

  // --- daftar kandidat ---
  check('daftar dipisah koma', modelCandidates('a, b ,c'), ['a', 'b', 'c'])
  check('kosong → tak ada kandidat', modelCandidates(''), [])

  // --- pindah kandidat lewat SessionManager ---
  const dir = mkdtempSync(join(tmpdir(), 'grove-mf-'))
  const b = new Board(join(dir, 'mf.sqlite'))
  await b.init()
  const mgr = new SessionManager(b, () => {})
  const acc = mgr.addAccount('Gateway', 'sk_live_x', undefined, undefined, 'dzax', 'claude-opus-4.8, claude-sonnet-5, glm-5.2', 'https://shiteru.id/v1')
  mgr.setDefaultAccount(acc.id)
  const root = await mgr.createRoot(dir, 'Uji')

  check('model efektif awal = kandidat pertama', mgr.getSessionModel(root.id), 'claude-opus-4.8')
  check('ditolak → pindah ke kandidat ke-2', mgr.nextModelCandidate(root.id), 'claude-sonnet-5')
  check('model sesi ikut berubah', mgr.getSessionModel(root.id), 'claude-sonnet-5')
  check('ditolak lagi → kandidat ke-3', mgr.nextModelCandidate(root.id), 'glm-5.2')
  check('kandidat habis → null (bukan berputar)', mgr.nextModelCandidate(root.id), null)

  // env peluncuran memakai model hasil pindah, bukan seluruh string daftar
  const launch = mgr.getSessionLaunch(root.id)
  check('ANTHROPIC_MODEL = model aktif', launch?.env.ANTHROPIC_MODEL, 'glm-5.2')
  check('model tak berisi koma', (launch?.env.ANTHROPIC_MODEL ?? '').includes(','), false)

  // akun dengan satu model saja → tak ada cadangan
  const solo = mgr.addAccount('Solo', 'sk_live_y', undefined, undefined, 'dzax', 'glm-5.2', 'https://shiteru.id/v1')
  const r2 = await mgr.createRoot(dir, 'Solo')
  mgr.setSessionAccount(r2.id, solo.id)
  check('satu model → tak ada cadangan', mgr.nextModelCandidate(r2.id), null)

  b.flush()
  await mgr.stopAll()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows */ }
  console.log(failed ? `\n${failed} GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}
void app.whenReady().then(main)
