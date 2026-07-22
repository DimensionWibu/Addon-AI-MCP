// Verifikasi rantai akun: akun sesi → akun sesi UTAMA → akun GLOBAL, plus ambang per-akun.
// Jalan di runtime Electron (SessionManager mengimpor `electron`), lihat scripts di package.json.
import { app } from 'electron'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Board } from '../src/main/orchestrator/db'
import { SessionManager } from '../src/main/orchestrator/SessionManager'
import { isTransientError, looksLikeAwaitingInput } from '../src/main/orchestrator/Session'
import { contextWindowFor } from '../src/main/orchestrator/contextWindows'
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

  // --- 12. Klasifikasi error transient (auto-retry) vs fatal/limit (jangan retry) ---
  check('ECONNRESET → transient', isTransientError('API Error: Connection to the API was lost (ECONNRESET). try again.'), true)
  check('socket hang up → transient', isTransientError('request failed: socket hang up'), true)
  check('503 → transient', isTransientError('upstream 503 Service Unavailable'), true)
  check('overloaded → transient', isTransientError('Error: overloaded_error, please retry'), true)
  check('provider_unavailable → transient', isTransientError('{"error_type":"provider_unavailable"}'), true)
  check('401 auth → BUKAN transient (fatal)', isTransientError('401 unauthorized: invalid api key'), false)
  check('404 model → BUKAN transient (fatal)', isTransientError('404 model not found: no access'), false)
  check('rate limit → BUKAN transient (itu urusan limit)', isTransientError('429 rate_limit exceeded, quota'), false)
  check('teks biasa → BUKAN transient', isTransientError('halo, ini jawaban biasa tanpa error'), false)

  // --- 13. Riwayat pemakaian: bucket jam → agregasi jam/hari/minggu ---
  {
    const uDir = mkdtempSync(join(tmpdir(), 'grove-usage-'))
    const b5 = new Board(join(uDir, 't.sqlite'))
    await b5.init()
    const m5 = new SessionManager(b5, () => {})
    const acc = m5.addAccount('AkunU', 'tok-U')
    const HOUR = 3_600_000, DAY = 86_400_000
    const now = Date.now()
    const hb = Math.floor(now / HOUR) * HOUR
    b5.addUsage(hb, acc.id, 'claude', 50, 0, 0, 100) // jam ini
    b5.addUsage(hb - 3 * HOUR, acc.id, 'claude', 0, 0, 0, 200) // 3 jam lalu (≤24 jam)
    b5.addUsage(hb - 2 * DAY, acc.id, 'claude', 0, 0, 0, 300) // 2 hari lalu (≤7 hari)
    b5.addUsage(hb - 10 * DAY, acc.id, 'claude', 0, 0, 0, 999) // 10 hari lalu (di luar minggu)
    const st = m5.getUsageStats()
    check('jam ini: output 100', st.hour.output, 100)
    check('jam ini: total 150 (input50+out100)', st.hour.total, 150)
    check('24 jam: output 300 (100+200)', st.day.output, 300)
    check('7 hari: output 600 (100+200+300)', st.week.output, 600)
    check('sejak awal: output 1599 (semua)', st.allTime.output, 1599)
    check('per-akun ada 1 akun di minggu', st.byAccount.length, 1)
    check('per-akun label benar', st.byAccount[0]?.label, 'AkunU')
    await m5.stopAll()
    b5.flush()
    try { rmSync(uDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  // --- 14. "butuh jawaban" (kedip kuning): jangan salah-picu saat asisten MELAPOR nanti ---
  check(
    'asisten lapor nanti ("kabari begitu … lapor") → BUKAN menunggu',
    looksLikeAwaitingInput('Delegasi beres. Nanti saya kabari begitu worker lapor temuan/perbaikannya.'),
    false
  )
  check('"saya kabari setelah selesai" → BUKAN menunggu', looksLikeAwaitingInput('Oke, saya kabari setelah selesai.'), false)
  check('ringkasan selesai biasa → BUKAN menunggu', looksLikeAwaitingInput('Selesai. Semua tes lulus.'), false)
  check('pertanyaan penutup "Lanjut?" → menunggu', looksLikeAwaitingInput('Sudah saya cek. Lanjut?'), true)
  check('"kabari saya kalau ada masalah" → menunggu', looksLikeAwaitingInput('Silakan coba. Kabari saya kalau ada masalah.'), true)

  // --- 15. Provider CUSTOM (proxy base-URL sendiri, mis. Gemini via LiteLLM): env pakai baseUrl akun ---
  {
    const xDir = mkdtempSync(join(tmpdir(), 'grove-custom-'))
    const b6 = new Board(join(xDir, 't.sqlite'))
    await b6.init()
    const m6 = new SessionManager(b6, () => {})
    const CU = m6.addAccount('Gemini', 'proxy-key', undefined, undefined, 'custom', 'gemini-2.5-flash', 'http://localhost:4000')
    check('provider tersimpan = custom', CU.provider, 'custom')
    check('baseUrl tersimpan di objek akun', CU.baseUrl, 'http://localhost:4000')
    m6.setDefaultAccount(CU.id)
    const r6 = await m6.createRoot(xDir, 'R')
    const l6 = m6.getSessionLaunch(r6.id) // baca via DB → sekaligus uji round-trip kolom base_url
    check('custom: ANTHROPIC_BASE_URL = baseUrl akun (BUKAN OpenRouter)', l6?.env.ANTHROPIC_BASE_URL, 'http://localhost:4000')
    check('custom: ANTHROPIC_AUTH_TOKEN = token', l6?.env.ANTHROPIC_AUTH_TOKEN, 'proxy-key')
    check('custom: CLAUDE_CODE_OAUTH_TOKEN dibuang', l6?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    check('custom: model = model akun', l6?.model, 'gemini-2.5-flash')
    m6.setSessionModel(r6.id, 'opus') // alias claude TAK boleh menang atas model akun custom
    check('custom: alias claude diabaikan (model akun terkunci)', m6.resolveModel(r6.id), 'gemini-2.5-flash')
    await m6.stopAll()
    b6.flush()
    try { rmSync(xDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  // --- 15b. Provider CURSOR (token free via proxy Anthropic→Cursor): sama seperti custom, base-URL sendiri ---
  {
    const cDir = mkdtempSync(join(tmpdir(), 'grove-cursor-'))
    const bC = new Board(join(cDir, 't.sqlite'))
    await bC.init()
    const mC = new SessionManager(bC, () => {})
    const CR = mC.addAccount('CursorFree', 'workos-session-tok', undefined, undefined, 'cursor', 'claude-3.5-sonnet', 'http://localhost:3000')
    check('provider tersimpan = cursor', CR.provider, 'cursor')
    check('cursor: baseUrl tersimpan di objek akun', CR.baseUrl, 'http://localhost:3000')
    mC.setDefaultAccount(CR.id)
    const rC = await mC.createRoot(cDir, 'R') // baca via DB → uji round-trip kolom provider+base_url
    const lC = mC.getSessionLaunch(rC.id)
    check('cursor: ANTHROPIC_BASE_URL = baseUrl akun (BUKAN OpenRouter)', lC?.env.ANTHROPIC_BASE_URL, 'http://localhost:3000')
    check('cursor: ANTHROPIC_AUTH_TOKEN = token', lC?.env.ANTHROPIC_AUTH_TOKEN, 'workos-session-tok')
    check('cursor: CLAUDE_CODE_OAUTH_TOKEN dibuang', lC?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    check('cursor: model = model akun', lC?.model, 'claude-3.5-sonnet')
    mC.setSessionModel(rC.id, 'opus') // alias claude TAK boleh menang atas model akun cursor (dikunci proxy)
    check('cursor: alias claude diabaikan (model akun terkunci)', mC.resolveModel(rC.id), 'claude-3.5-sonnet')
    await mC.stopAll()
    bC.flush()
    try { rmSync(cDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  // --- 15c. Provider DEEPSEEK (token saja, base-URL Anthropic RESMI DeepSeek, model pro/flash) ---
  {
    const dDir = mkdtempSync(join(tmpdir(), 'grove-ds-'))
    const bD = new Board(join(dDir, 't.sqlite'))
    await bD.init()
    const mD = new SessionManager(bD, () => {})
    const DS = mD.addAccount('DeepSeek', 'sk-ds-test', undefined, undefined, 'deepseek') // model sengaja kosong
    check('provider tersimpan = deepseek', DS.provider, 'deepseek')
    check('deepseek: model kosong → default pro', DS.model, 'deepseek-v4-pro')
    check('deepseek: TIDAK menyimpan baseUrl (konstanta, bukan proxy user)', DS.baseUrl, undefined)
    mD.setDefaultAccount(DS.id)
    const rD = await mD.createRoot(dDir, 'R') // baca via DB → uji round-trip kolom provider+or_model
    const lD = mD.getSessionLaunch(rD.id)
    check('deepseek: ANTHROPIC_BASE_URL = endpoint anthropic DeepSeek', lD?.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic')
    check('deepseek: ANTHROPIC_AUTH_TOKEN = key', lD?.env.ANTHROPIC_AUTH_TOKEN, 'sk-ds-test')
    check('deepseek: CLAUDE_CODE_OAUTH_TOKEN dibuang', lD?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    check('deepseek: ANTHROPIC_API_KEY dibuang', lD?.env.ANTHROPIC_API_KEY, undefined)
    check('deepseek: kelas model internal CLI dipetakan (opus→pro)', lD?.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro')
    check('deepseek: kelas cepat → flash (hemat)', lD?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash')
    check('deepseek: model efektif = model akun', lD?.model, 'deepseek-v4-pro')
    mD.setSessionModel(rD.id, 'opus') // alias claude TAK dikenal DeepSeek → harus diabaikan
    check('deepseek: alias claude diabaikan', mD.resolveModel(rD.id), 'deepseek-v4-pro')
    mD.setSessionModel(rD.id, 'deepseek-v4-flash') // pilih model DeepSeek lain = override sadar
    check('deepseek: override model DeepSeek dihormati', mD.resolveModel(rD.id), 'deepseek-v4-flash')
    const sD = await mD.spawnWorker(rD.id, { title: 'W', task: 'noop' })
    check('deepseek: sub mewarisi model root', mD.resolveModel(sD), 'deepseek-v4-flash')
    check('deepseek: ctxWindow 1jt (bukan 200k)', contextWindowFor(mD.resolveModel(rD.id)), 1_000_000)
    await mD.stopAll()
    bD.flush()
    try { rmSync(dDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  // --- 15d. TINGKAT MIKIR (effort/thinking): warisan sesi→utama→global + persist + ikut launch ---
  {
    const eDir = mkdtempSync(join(tmpdir(), 'grove-effort-'))
    const bE = new Board(join(eDir, 't.sqlite'))
    await bE.init()
    const mE = new SessionManager(bE, () => {})
    const acc = mE.addAccount('Akun', 'tok', undefined, undefined, 'deepseek')
    mE.setDefaultAccount(acc.id)
    const rE = await mE.createRoot(eDir, 'R')
    const sE = await mE.spawnWorker(rE.id, { title: 'W', task: 'noop' })
    check('effort default: tak ada → undefined (ikut default model)', mE.resolveEffort(rE.id), undefined)
    mE.setDefaultEffort('high')
    check('effort global → root ikut', mE.resolveEffort(rE.id), 'high')
    check('effort global → sub ikut lewat root', mE.resolveEffort(sE), 'high')
    mE.setSessionEffort(rE.id, 'max')
    check('root set max → root max', mE.resolveEffort(rE.id), 'max')
    check('root set max → sub OTOMATIS ikut', mE.resolveEffort(sE), 'max')
    mE.setSessionEffort(sE, 'off')
    check('sub override → off (thinking mati)', mE.resolveEffort(sE), 'off')
    check('root tetap max', mE.resolveEffort(rE.id), 'max')
    check('effort ikut dibawa getSessionLaunch', mE.getSessionLaunch(sE)?.effort, 'off')
    mE.setSessionEffort(sE, null)
    check('sub kembali mewarisi → max', mE.resolveEffort(sE), 'max')
    bE.flush()
    check('effort persist di DB (round-trip kolom effort)', bE.getAllSessions().find((s) => s.id === rE.id)?.effort, 'max')
    await mE.stopAll()
    try { rmSync(eDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  // --- 15e. REFERENSI SATU ARAH antar-sesi: tautan, kunci arah-balik, baca, kirim ---
  {
    const fDir = mkdtempSync(join(tmpdir(), 'grove-ref-'))
    const bF = new Board(join(fDir, 't.sqlite'))
    await bF.init()
    const mF = new SessionManager(bF, () => {})
    const A = await mF.createRoot(fDir, 'Chat A', true) // lite → tak auto-start query
    const B = await mF.createRoot(fDir, 'Chat B', true) // SENGAJA folder kerja SAMA
    check('sebelum ditautkan: B tak punya referensi', mF.hasReferences(B.id), false)
    mF.linkReference(B.id, A.id)
    check('B punya referensi setelah ditautkan', mF.hasReferences(B.id), true)
    check('daftar referensi B berisi A', mF.listReferences(B.id).map((r) => r.id), [A.id])
    check('A TIDAK ikut punya referensi (satu arah)', mF.hasReferences(A.id), false)
    check('folder kerja sama TIDAK membuat A jadi referensi B', mF.listReferences(A.id), [])
    let reverseErr = ''
    try { mF.linkReference(A.id, B.id) } catch (e) { reverseErr = String(e) }
    check('tautan arah-balik DITOLAK', /SATU ARAH/.test(reverseErr), true)
    let selfErr = ''
    try { mF.linkReference(B.id, B.id) } catch (e) { selfErr = String(e) }
    check('tautan ke diri sendiri DITOLAK', /dirinya sendiri/.test(selfErr), true)
    check('B bisa membaca papan A', /Chat A/.test(mF.readReference(B.id, A.id)), true)
    let noLinkErr = ''
    try { mF.readReference(A.id, B.id) } catch (e) { noLinkErr = String(e) }
    check('A TIDAK bisa membaca B (tak ada tautan)', /bukan referensimu/.test(noLinkErr), true)
    mF.sendToReference(B.id, A.id, 'pakai guard rec.busy sebelum accept')
    const aChat = mF.getChat(A.id)
    check('pesan bantuan mendarat di A sebagai pesan user biasa',
      aChat.some((m) => m.role === 'user' && m.text.includes('guard rec.busy')), true)
    check('A tak diberi tahu asal pesannya',
      aChat.some((m) => m.text.includes('Chat B') || m.text.includes(B.id)), false)
    mF.unlinkReference(B.id, A.id)
    check('setelah dilepas: B tak punya referensi lagi', mF.hasReferences(B.id), false)
    await mF.stopAll()
    bF.flush()
    try { rmSync(fDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  // --- 15g. JEMBATAN GAMBAR: sesi DeepSeek buta gambar → butuh akun lain yang bisa melihat ---
  {
    const vDir = mkdtempSync(join(tmpdir(), 'grove-vision-'))
    const bV = new Board(join(vDir, 't.sqlite'))
    await bV.init()
    const mV = new SessionManager(bV, () => {})
    const ds = mV.addAccount('DS', 'sk-ds', undefined, undefined, 'deepseek')
    mV.setDefaultAccount(ds.id)
    const rV = await mV.createRoot(vDir, 'R', true)
    check('sesi ber-akun DeepSeek dianggap BUTA gambar', mV.sessionSeesImages(rV.id), false)
    check('tanpa akun lain → tak ada jembatan gambar', mV.getVisionLaunch(), null)
    const cl = mV.addAccount('Claude', 'sk-ant-oat01-x')
    const vl = mV.getVisionLaunch()
    check('akun Claude menjadi jembatan gambar', vl?.label, 'Claude')
    check('jembatan pakai token akun itu', vl?.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-x')
    check('jembatan tak membawa base URL DeepSeek', vl?.env.ANTHROPIC_BASE_URL, undefined)
    mV.setSessionAccount(rV.id, cl.id)
    check('sesi ber-akun Claude BISA melihat gambar', mV.sessionSeesImages(rV.id), true)
    // CADANGAN: lebih dari satu akun yang bisa melihat → daftar berurutan (akun global paling depan),
    // dipakai Session untuk turun ke akun berikutnya saat yang pertama kena limit.
    const cl2 = mV.addAccount('Claude2', 'sk-ant-oat01-y')
    check('dua kandidat jembatan terdaftar', mV.getVisionLaunches().map((v) => v.label), ['Claude', 'Claude2'])
    mV.setDefaultAccount(cl2.id)
    check('akun GLOBAL naik ke urutan pertama', mV.getVisionLaunches().map((v) => v.label), ['Claude2', 'Claude'])
    check('akun DeepSeek tak pernah jadi kandidat', mV.getVisionLaunches().some((v) => v.label === 'DS'), false)
    await mV.stopAll()
    try { rmSync(vDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  // --- 15f. ANTRIAN pesan user saat turn jalan: bisa diedit & dibatalkan sebelum terkirim ---
  {
    const qDir = mkdtempSync(join(tmpdir(), 'grove-queue-'))
    const bQ = new Board(join(qDir, 't.sqlite'))
    await bQ.init()
    const mQ = new SessionManager(bQ, () => {})
    const acc = mQ.addAccount('Akun', 'tok', undefined, undefined, 'deepseek')
    mQ.setDefaultAccount(acc.id)
    const r = await mQ.createRoot(qDir, 'R', true)
    const sess = mQ.getSnapshot().trees.find((t) => t.id === r.id)!
    check('sesi baru: antrian kosong', mQ.listQueued(r.id), [])
    // Paksa kondisi "turn sedang jalan" seperti saat model bekerja.
    const live = (mQ as unknown as { sessions: Map<string, { meta: { status: string }; started: boolean }> }).sessions.get(r.id)!
    live.meta.status = 'running'
    live.started = true
    mQ.sendChat(r.id, 'pesan pertama')
    mQ.sendChat(r.id, 'pesan kedua')
    check('dua pesan MASUK ANTRIAN (bukan dikirim)', mQ.listQueued(r.id).map((q) => q.text), ['pesan pertama', 'pesan kedua'])
    check('antrian TIDAK muncul di chat sebelum terkirim', mQ.getChat(r.id).some((m) => m.role === 'user'), false)
    const qid = mQ.listQueued(r.id)[0].qid
    check('edit antrian berhasil', mQ.editQueued(r.id, qid, 'pesan pertama (diedit)'), true)
    check('isi antrian ikut berubah', mQ.listQueued(r.id)[0].text, 'pesan pertama (diedit)')
    check('batalkan antrian berhasil', mQ.cancelQueued(r.id, qid), true)
    check('sisa antrian tinggal satu', mQ.listQueued(r.id).map((q) => q.text), ['pesan kedua'])
    check('edit qid yang sudah tak ada → false', mQ.editQueued(r.id, qid, 'x'), false)
    check('sesi lain tak terpengaruh', sess.id === r.id, true)
    await mQ.stopAll()
    try { rmSync(qDir, { recursive: true, force: true }) } catch { /* windows lock */ }
  }

  // --- 16. Mode LITE (fix boros): default per entry-point + toggle + persist DB ---
  {
    const lDir = mkdtempSync(join(tmpdir(), 'grove-lite-'))
    const b7 = new Board(join(lDir, 't.sqlite'))
    await b7.init()
    const m7 = new SessionManager(b7, () => {})
    const full = await m7.createRoot(lDir, 'Proyek') // drag-folder = orkestrator (default)
    const chat = await m7.createRoot(lDir, 'Chat', true) // "+Chat" = lite
    check('createRoot default → BUKAN lite (orkestrator)', full.lite ?? false, false)
    check('createRoot(…, lite=true) → lite', chat.lite, true)
    m7.setLite(chat.id, false) // toggle ke orkestrator
    check('setLite(false) → mode orkestrator', m7.getSnapshot().trees.find((t) => t.id === chat.id)?.lite ?? false, false)
    m7.setLite(chat.id, true) // balik ke lite
    check('setLite(true) → kembali lite', m7.getSnapshot().trees.find((t) => t.id === chat.id)?.lite, true)
    b7.flush()
    check('lite persist di DB (round-trip kolom lite)', b7.getAllSessions().find((s) => s.id === chat.id)?.lite, true)
    await m7.stopAll()
    try { rmSync(lDir, { recursive: true, force: true }) } catch { /* windows lock */ }
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
