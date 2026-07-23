// JEMBATAN GAMBAR: env tiap akun kandidat harus BENAR (dulu akun gateway diarahkan ke base URL
// OpenRouter dengan token gateway → "401 Missing Authentication header", lalu Grove mencoba akun
// berikutnya satu per satu sampai bermenit-menit).
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import { startOpenAiBridge } from '../src/main/openaiBridge'

let failed = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
}

async function main(): Promise<void> {
  await startOpenAiBridge()
  const dir = mkdtempSync(join(tmpdir(), 'grove-vis-'))
  const b = new Board(join(dir, 'v.sqlite'))
  await b.init()
  const mgr = new SessionManager(b, () => {})
  const gw = mgr.addAccount('Gateway', 'sk_live_gw', undefined, undefined, 'dzax', 'claude-sonnet-5, glm-5.2', 'https://shiteru.id/v1')
  const cl = mgr.addAccount('Langganan', 'sk-ant-oat-x', 20)
  const ds = mgr.addAccount('DeepSeek', 'sk-ds', undefined, undefined, 'deepseek', 'deepseek-v4-pro')

  const list = mgr.getVisionLaunches()
  const byLabel = (l: string) => list.find((x) => x.label === l)
  check('DeepSeek tak masuk kandidat (buta gambar)', byLabel('DeepSeek') === undefined, true)
  void ds

  const g = byLabel('Gateway')!
  check('akun gateway diarahkan ke JEMBATAN lokal', /^http:\/\/127\.0\.0\.1:\d+\/u\//.test(g.env.ANTHROPIC_BASE_URL), true)
  check('bukan base URL OpenRouter (penyebab 401)', g.env.ANTHROPIC_BASE_URL.includes('openrouter'), false)
  check('token gateway terpasang', g.env.ANTHROPIC_AUTH_TOKEN, 'sk_live_gw')
  check('token Claude dibuang dari env gateway', g.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, null)
  check('model = kandidat pertama (bukan seluruh daftar)', g.model, 'claude-sonnet-5')

  const c = byLabel('Langganan')!
  check('akun Claude pakai OAuth token', c.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-x')
  check('akun Claude tanpa base URL', c.env.ANTHROPIC_BASE_URL ?? null, null)

  // Akun yang gagal → turun prioritas pada percobaan berikutnya.
  const firstBefore = mgr.getVisionLaunches()[0].label
  mgr.noteVisionFailure(byLabel(firstBefore)!.id)
  const after = mgr.getVisionLaunches()
  check('akun yang baru gagal tak lagi jadi kandidat pertama', after[0].label === firstBefore, false)
  check('akun yang gagal tetap ada sebagai cadangan terakhir', after.some((x) => x.label === firstBefore), true)
  void gw
  void cl

  b.flush()
  await mgr.stopAll()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows */ }
  console.log(failed ? `\n${failed} GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}
void app.whenReady().then(main)
