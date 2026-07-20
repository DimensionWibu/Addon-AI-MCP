// Verifikasi rantai akun: akun sesi → akun sesi UTAMA → akun GLOBAL, plus ambang per-akun.
// Jalan di runtime Electron (SessionManager mengimpor `electron`), lihat scripts di package.json.
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
  const dir = mkdtempSync(join(tmpdir(), 'grove-acct-'))
  const board = new Board(join(dir, 'test.sqlite'))
  await board.init()
  const events: GroveEvent[] = []
  const mgr = new SessionManager(board, (e) => events.push(e))

  const A = mgr.addAccount('AkunA', 'tok-A', 20)
  const B = mgr.addAccount('AkunB', 'tok-B', 5)

  // --- 1. Tanpa akun global & tanpa akun sesi → tak ada token (sesi tak boleh jalan) ---
  const root = await mgr.createRoot(dir, 'Root')
  check('tanpa apa-apa → akun efektif null', mgr.resolveAccountId(root.id), null)
  check('tanpa apa-apa → token null', mgr.getSessionToken(root.id), null)

  // --- 2. Akun GLOBAL jadi dasar rantai ---
  mgr.setDefaultAccount(A.id)
  check('global A → root ikut A', mgr.resolveAccountId(root.id), A.id)
  check('global A → token A', mgr.getSessionToken(root.id), 'tok-A')

  // --- 3. Sub-sesi mewarisi dari sesi utama, BUKAN menyalin saat lahir ---
  const subId = await mgr.spawnWorker(root.id, { title: 'W1', task: 'noop' })
  check('sub baru tak menyimpan akun sendiri', mgr.getSnapshot().trees[0].children[0].accountId ?? null, null)
  check('sub ikut global lewat root', mgr.resolveAccountId(subId), A.id)

  // Ganti akun di sesi UTAMA → sub HARUS ikut, tanpa disentuh satu per satu.
  mgr.setSessionAccount(root.id, B.id)
  check('root diubah ke B', mgr.resolveAccountId(root.id), B.id)
  check('sub OTOMATIS ikut root (B)', mgr.resolveAccountId(subId), B.id)
  check('sub pakai token B', mgr.getSessionToken(subId), 'tok-B')

  // --- 4. Sub boleh menimpa sendiri, dan itu menang atas root ---
  mgr.setSessionAccount(subId, A.id)
  check('sub override → A', mgr.resolveAccountId(subId), A.id)
  check('root tetap B', mgr.resolveAccountId(root.id), B.id)
  // Kembali mewarisi.
  mgr.setSessionAccount(subId, null)
  check('sub kembali mewarisi → B', mgr.resolveAccountId(subId), B.id)

  // --- 5. Akun terhapus tidak boleh menyumbat rantai ---
  mgr.setSessionAccount(root.id, A.id)
  mgr.deleteAccount(A.id) // root menunjuk akun yang sudah tiada
  check('akun root terhapus → jatuh ke global', mgr.resolveAccountId(root.id), mgr.listAccounts().defaultAccountId)

  // --- 6. Ambang per akun ---
  check('ambang default awal', mgr.switchPctFor(B.id), 90)
  mgr.setDefaultSwitchPct(80)
  check('ambang default diubah → akun tanpa ambang ikut', mgr.switchPctFor(B.id), 80)
  mgr.setAccountSwitchPct(B.id, 95)
  check('ambang khusus akun menang', mgr.switchPctFor(B.id), 95)
  mgr.setAccountSwitchPct(B.id, 999) // di luar rentang → di-clamp, bukan diterima mentah
  check('ambang di-clamp ke 99', mgr.switchPctFor(B.id), 99)
  mgr.setAccountSwitchPct(B.id, null)
  check('ambang dikosongkan → ikut default lagi', mgr.switchPctFor(B.id), 80)

  // --- 7. onUsageHigh menghormati ambang (tak pindah di bawah ambang) ---
  mgr.setAutoSwitch(true)
  const C = mgr.addAccount('AkunC', 'tok-C', 20)
  mgr.setDefaultAccount(B.id)
  mgr.setSessionAccount(root.id, null)
  mgr.setAccountSwitchPct(B.id, 90)
  check('di bawah ambang → tidak pindah', mgr.onUsageHigh(B.id, 85), 0)
  const moved = mgr.onUsageHigh(B.id, 93)
  check('di atas ambang → sesi dipindah', moved > 0, true)
  check('tujuan pindah bukan akun yang penuh', mgr.resolveAccountId(root.id) !== B.id, true)
  void C

  // --- 8. Tanpa akun sama sekali: sesi BERHENTI + event notif, tapi manager tetap hidup ---
  mgr.setDefaultAccount(null)
  const orphan = await mgr.createRoot(dir, 'Tanpa akun')
  mgr.setSessionAccount(orphan.id, null)
  events.length = 0
  mgr.sendChat(orphan.id, 'halo')
  const missing = events.find((e) => e.channel === 'auth:missing')
  check('event auth:missing terkirim', Boolean(missing), true)
  check('notif menandai bukan sekadar token hilang', missing?.channel === 'auth:missing' && missing.payload.tokenMissing, false)
  check('sesi ditandai error (tidak diam-diam jalan)', mgr.getSnapshot().trees.find((t) => t.id === orphan.id)?.status, 'error')
  // Yang penting: manager TIDAK crash — sesi lain masih bisa dilayani.
  check('manager tetap hidup setelah sesi gagal', mgr.listAccounts().accounts.length > 0, true)

  // --- 9. BUG restore: auto-switch OFF → restorePinnedAccounts TIDAK memindahkan apa pun ---
  {
    const bDir = mkdtempSync(join(tmpdir(), 'grove-restore-'))
    const b2 = new Board(join(bDir, 't.sqlite'))
    await b2.init()
    const m2 = new SessionManager(b2, () => {})
    const X = m2.addAccount('X', 'tok-X')
    const Y = m2.addAccount('Y', 'tok-Y')
    m2.setDefaultAccount(X.id)
    const r2 = await m2.createRoot(bDir, 'R')
    m2.setSessionAccount(r2.id, Y.id) // user pin ke Y → ada entri pin
    m2.setSessionAccount(r2.id, X.id) // lalu pindah ke X; pin masih menunjuk Y (beda dari sekarang)
    m2.setAutoSwitch(false) // pastikan OFF (default juga false)
    const moved = m2.restorePinnedAccounts()
    check('auto-switch OFF → restore tidak memindahkan (bug pindah-sendiri)', moved, 0)
    check('akun sesi tetap X (tidak ditarik ke pin Y)', m2.resolveAccountId(r2.id), X.id)
    await m2.stopAll()
    b2.flush()
    try { rmSync(bDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  // --- 10. Model: rantai resolusi & pewarisan (paralel dgn akun) ---
  {
    const cDir = mkdtempSync(join(tmpdir(), 'grove-model-'))
    const b3 = new Board(join(cDir, 't.sqlite'))
    await b3.init()
    const m3 = new SessionManager(b3, () => {})
    const root3 = await m3.createRoot(cDir, 'R')
    check('model default: tak ada → undefined (default SDK)', m3.resolveModel(root3.id), undefined)
    m3.setDefaultModel('sonnet')
    check('model global → root ikut', m3.resolveModel(root3.id), 'sonnet')
    const sub3 = await m3.spawnWorker(root3.id, { title: 'W', task: 'noop' })
    check('sub baru tak simpan model sendiri', m3.getSnapshot().trees[0].children[0].model ?? null, null)
    check('sub ikut global lewat root', m3.resolveModel(sub3), 'sonnet')
    m3.setSessionModel(root3.id, 'opus')
    check('root set opus → sub OTOMATIS ikut', m3.resolveModel(sub3), 'opus')
    m3.setSessionModel(sub3, 'haiku')
    check('sub override → haiku', m3.resolveModel(sub3), 'haiku')
    check('root tetap opus', m3.resolveModel(root3.id), 'opus')
    m3.setSessionModel(sub3, null)
    check('sub kembali mewarisi → opus', m3.resolveModel(sub3), 'opus')
    await m3.stopAll()
    b3.flush()
    try { rmSync(cDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  // --- 11. Provider OpenRouter: env + model dipaksa oleh akun ---
  {
    const oDir = mkdtempSync(join(tmpdir(), 'grove-or-'))
    const b4 = new Board(join(oDir, 't.sqlite'))
    await b4.init()
    const m4 = new SessionManager(b4, () => {})
    const OR = m4.addAccount('OR-Nemotron', 'sk-or-test', undefined, undefined, 'openrouter', 'nvidia/nemotron-3-super-120b-a12b:free')
    check('provider tersimpan = openrouter', OR.provider, 'openrouter')
    m4.setDefaultAccount(OR.id)
    const r4 = await m4.createRoot(oDir, 'R')
    const launch = m4.getSessionLaunch(r4.id)
    check('launch ada', Boolean(launch), true)
    check('env pakai ANTHROPIC_BASE_URL OpenRouter', launch?.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api')
    check('env pakai ANTHROPIC_AUTH_TOKEN = key', launch?.env.ANTHROPIC_AUTH_TOKEN, 'sk-or-test')
    check('CLAUDE_CODE_OAUTH_TOKEN dibuang (bukan akun Claude)', launch?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    check('model dipaksa ke id OpenRouter akun', launch?.model, 'nvidia/nemotron-3-super-120b-a12b:free')
    // Alias claude di sesi TIDAK boleh menang atas model OpenRouter akun.
    m4.setSessionModel(r4.id, 'opus')
    check('alias claude diabaikan untuk akun OpenRouter', m4.resolveModel(r4.id), 'nvidia/nemotron-3-super-120b-a12b:free')
    // Tapi id OpenRouter lain (ber-"/") boleh jadi override sadar.
    m4.setSessionModel(r4.id, 'nvidia/nemotron-3-ultra-550b-a55b:free')
    check('override id OpenRouter dihormati', m4.resolveModel(r4.id), 'nvidia/nemotron-3-ultra-550b-a55b:free')
    await m4.stopAll()
    b4.flush()
    try { rmSync(oDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  board.flush()
  await mgr.stopAll() // hentikan query yang terlanjur start (spawnWorker start:true) sebelum bersih-bersih
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows masih memegang file DB → biarkan; ini folder temp, bukan kegagalan test. */
  }
  console.log(failed ? `\n${failed} CHECK GAGAL` : '\nSEMUA CHECK LULUS')
  app.exit(failed ? 1 : 0)
}

void app.whenReady().then(main)
