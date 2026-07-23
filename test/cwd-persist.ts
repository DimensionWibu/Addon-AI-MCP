// REGRESI: folder kerja sesi HARUS bertahan restart. Dulu kolom cwd tak ikut di-UPDATE, jadi setelah
// app dibuka lagi sesi kembali ke folder lama sementara sdk_session_id menunjuk percakapan folder
// baru → "No conversation found with session ID" dan sesi buntu.
import { app } from 'electron'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import { isStaleSdkSession } from '../src/main/orchestrator/Session'

let failed = 0
const check = (name: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'grove-cwd-'))
  const projectA = join(dir, 'proyek-A')
  const projectB = join(dir, 'proyek-B')
  mkdirSync(projectA); mkdirSync(projectB)
  const dbPath = join(dir, 'cwd.sqlite')

  const b1 = new Board(dbPath)
  await b1.init()
  const m1 = new SessionManager(b1, () => {})
  const root = await m1.createRoot(projectA, 'Pindah folder')
  // pura-pura sesi sudah punya percakapan SDK (seperti setelah giliran pertama)
  const s = m1.getSnapshot().trees[0]
  ;(m1 as unknown as { sessions: Map<string, { meta: { sdkSessionId?: string } }> }).sessions.get(root.id)!.meta.sdkSessionId = 'sdk-lama'
  m1.setSessionCwd(root.id, projectB)
  check('cwd berubah di memori', m1.getSnapshot().trees[0].cwd, projectB)
  check('sdk lama dilepas saat pindah folder', m1.getSnapshot().trees[0].sdkSessionId ?? null, null)
  b1.flush()

  // "tutup lalu buka lagi": muat ulang dari DB
  const b2 = new Board(dbPath)
  await b2.init()
  const m2 = new SessionManager(b2, () => {})
  m2.loadFromDisk()
  const after = m2.getSnapshot().trees.find((t) => t.id === root.id)
  check('cwd BERTAHAN setelah restart', after?.cwd, projectB)
  check('deteksi error sesi basi', isStaleSdkSession('Claude Code returned an error result: No conversation found with session ID: abc'), true)
  check('teks lain tidak salah dideteksi', isStaleSdkSession('rate_limit_error'), false)
  void s
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows */ }
  console.log(failed ? `\n${failed} GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}
void app.whenReady().then(main)
