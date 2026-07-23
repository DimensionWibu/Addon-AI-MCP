// PESAN ANTRIAN + COMPACT. Bug yang dijaga: pesan user yang menunggu dilepas LEBIH DULU, lalu
// compact memotong query yang baru saja menerimanya — pesannya tampil di chat tapi tak pernah
// dijawab ("konteks penuh, sesudah compact kok tidak dilanjut").
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Board } from '../src/main/orchestrator/db'
import { Session } from '../src/main/orchestrator/Session'
import { compactDecision } from '../src/main/orchestrator/wakePolicy'

let failed = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'grove-qc-'))
  const b = new Board(join(dir, 'q.sqlite'))
  await b.init()
  const now = Date.now()
  const meta = {
    id: 'q1', treeId: 'q1', parentId: null, role: 'root' as const, title: 'Antrian', cwd: dir,
    status: 'idle' as const, ctxInput: 0, ctxOutput: 0, ctxWindow: 200_000, createdAt: now, updatedAt: now
  }
  b.upsertSession(meta)

  const sent: string[] = []
  let compacted = 0
  const host = new Proxy({}, {
    get: (_t, p: string) => {
      if (p === 'getSessionLaunch') return () => ({ env: {}, model: 'x' })
      if (p === 'providerCachesPrompt') return () => true
      if (p === 'beforeCompact') return () => '.grove/checkpoint-q1.md'
      if (p === 'notifyHighContext') return (id: string) => {
        compacted++
        // Meniru SessionManager: menyusun ringkasan lalu memadatkan konteks sesi itu.
        ;(sess as unknown as { compactWith: (s: string) => void }).compactWith('ringkasan papan')
        void id
      }
      if (p === 'hasReferences' || p === 'perMessageUsageReliable') return () => true
      if (p === 'readBoard' || p === 'listWorkers' || p === 'readMessages') return () => []
      return () => undefined
    }
  }) as never

  const sess = new Session(meta, b, host, () => {})
  // Jangan benar-benar menyalakan query/SDK: cukup catat apa yang DIKIRIM ke model.
  const internal = sess as unknown as {
    started: boolean
    pushRequest: (c: unknown, k: string, t: string) => void
    handle: (m: Record<string, unknown>) => void
    queued: Array<{ qid: number; text: string }>
    meta: typeof meta
  }
  internal.pushRequest = (_c, _k, t) => sent.push(String(t))
  internal.started = true

  // 1. Turn sedang berjalan → pesan user MASUK ANTRIAN (bukan langsung dikirim).
  ;(sess as unknown as { meta: typeof meta }).meta.status = 'running'
  sess.sendUserMessage('lanjutkan analisanya dong')
  check('pesan saat sibuk masuk antrian', internal.queued.length, 1)
  check('belum ada yang dikirim ke model', sent.length, 0)

  // 2. Turn berakhir dengan konteks PENUH → harus compact, lalu pesan antrian DILANJUTKAN.
  internal.meta.ctxInput = 160_000 // > ambang root (70% dari 200k)
  check('ambang: konteks ini memang memicu compact', compactDecision('root', 160_000, 200_000, true, false).compact, true)
  internal.handle({ type: 'result', subtype: 'success' })
  await new Promise((r) => setTimeout(r, 50))

  check('compact benar-benar dijalankan', compacted, 1)
  check('pesan antrian AKHIRNYA dikirim (tidak hilang)', sent.length, 1)
  check('antrian kosong setelah dilepas', internal.queued.length, 0)
  check('isi pesan user utuh', /lanjutkan analisanya dong/.test(sent[0] ?? ''), true)
  check('dikirim BERSAMA reseed ringkasan pasca-compact', /MEMORI TERKOMPAK/.test(sent[0] ?? ''), true)

  await sess.stop()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows */ }
  console.log(failed ? `\n${failed} GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}
void app.whenReady().then(main)
