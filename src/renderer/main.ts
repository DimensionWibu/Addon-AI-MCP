import type {
  Account,
  BoardEntry,
  ChatMessage,
  CreditInfo,
  DeepseekAccountCost,
  EffortSetting,
  GroveEvent,
  ImageAttachment,
  InboxMessage,
  Memory,
  OpenRouterModel,
  SessionMeta,
  TreeNode,
  UsageSnapshot,
  UsageStats,
  UsageUnavailable,
  UsageWindow
} from '../shared/types'
import {
  CURSOR_BASE_URL_DEFAULT,
  CURSOR_MODEL_SUGGESTIONS,
  CUSTOM_BASE_URL_DEFAULT,
  CUSTOM_MODEL,
  CUSTOM_MODEL_SUGGESTIONS,
  DEEPSEEK_MODEL_DEFAULT,
  DEEPSEEK_MODEL_SUGGESTIONS,
  DZAX_BASE_URL_DEFAULT,
  DZAX_MODEL_SUGGESTIONS,
  deepseekCostUsd,
  deepseekPriceLabel,
  EFFORT_OPTIONS,
  effortLabel,
  isDeepSeekModel,
  MODEL_OPTIONS,
  modelLabel,
  OPENROUTER_MODEL_SUGGESTIONS,
  usesOwnBaseUrl
} from '../shared/types'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'

let pendingImages: ImageAttachment[] = []
let pendingRefs: string[] = [] // path file/folder referensi

// Draft compose PER-SESI (Bug 2): teks + lampiran yang belum terkirim, disimpan per sessionId supaya
// tiap sesi punya kolom ketiknya sendiri — tak ada teks/lampiran satu sesi yang nyasar ke sesi lain.
// Map ini hanya menyimpan draft sesi NON-aktif; draft sesi aktif "hidup" di textarea (di-load keluar
// dari map saat sesi dipilih, di-save balik ke map saat sesi ditinggalkan).
type Draft = { text: string; images: ImageAttachment[]; refs: string[] }
const drafts = new Map<string, Draft>()

type Node = SessionMeta & { ctxPercent: number; tokensTotal: number; loopActive?: boolean; apiStopped?: boolean; ctxPending?: boolean; awaitingInput?: boolean }

const turnStart = new Map<string, number>() // kapan turn 'running' dimulai
const lastElapsed = new Map<string, number>() // durasi turn terakhir (ms)

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

const nodes = new Map<string, Node>()
const board = new Map<string, BoardEntry>()
const memories: Memory[] = [] // hasil compact per pohon
let accounts: Account[] = [] // akun Claude tersimpan (tanpa token)
let autoSwitch = false // pindah akun otomatis saat limit
let autoResume = false // lanjutkan sesi yang tadi kerja saat app dibuka lagi
let defaultSwitchPct = 90 // ambang untuk akun yang tak punya ambang sendiri
let defaultAccountId: string | null = null
let visionAccountId: string | null = null // akun pembaca gambar (null = otomatis)
let accountOrder: string[] = [] // urutan prioritas rotasi akun (kosong = pakai ukuran paket) // akun global (dipakai pohon yang tak menentukan sendiri)
let defaultModel: string | null = null // model global (dipakai sesi yang tak menentukan sendiri)
let defaultEffort: EffortSetting | null = null // tingkat mikir global (null = default model)
let orModels: OpenRouterModel[] = [] // daftar model OpenRouter (dukung tools) untuk sesi ber-akun OR
let activeId: string | null = null
let pendingEl: HTMLElement | null = null
let pendingTextNode: Text | null = null // B4: node teks streaming → append-only (hindari O(n²) set-ulang)
let pendingText = '' // target teks penuh yang terkumpul
let shownLen = 0 // berapa char sudah ditampilkan (efek ketik)

// Aktivitas live per session ("lagi ngapain": tool/berpikir/idle).
const activities = new Map<string, string>()

// Panel detail tool (untuk update saat output tool tiba) — key = toolUseId, di sesi aktif.
const toolDetailEls = new Map<string, HTMLElement>()

// ---- panel REQUEST (bekas panel LOG) state ---------------------------------
// Daftar teks MENTAH yang Grove kirim ke query() per giliran, untuk SESI AKTIF. Murni renderer.
type LogChild = Record<string, never>

// Nomor call API dalam giliran berjalan → dipakai baris metrik inline di chat ("↳ call 3 · ctx …").
let chatCallSeq = 0
// Panel bawah TIDAK LAGI menyalin isi chat (dulu tiap tool/respons tampil dua kali: di chat DAN di
// LOG). Sekarang ia hanya menampung yang TAK ADA di chat: teks REQUEST mentah yang Grove kirim ke
// query() — termasuk auto-task & recycle yang memang tak pernah direkam ke chat. Metrik per-call
// (ctx/fresh/cache/out) pindah jadi baris inline di chat.
type LogTurn = {
  wrap: HTMLElement
  caret: HTMLElement
  body: HTMLElement // container node REQUEST
  meta: HTMLElement // label jam + penanda selesai
  usageEl: HTMLElement // ringkasan token per-turn (n× call · Σout · ctx▲) di header
  children: LogChild[]
  done: boolean
  calls: number // jumlah respons API (call) di turn ini
  outSum: number // total token output turn ini
  ctxMax: number // konteks call terbesar (bukti "berat": tokens yang dikirim tiap call)
}
const logTurns: LogTurn[] = []
let logCollapsed = true // panel diagnosa → tertutup secara default (isi chat sudah lengkap)
const MAX_LOG_TURNS = 60 // batasi node → anti-lag (mirip MAX_CHAT_DOM)

// Kapan tiap sesi terakhir aktif — dipakai menampilkan jam kerja terakhir untuk idle/done.
const lastActive = new Map<string, number>()
function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Referensi elemen DOM per node → update incremental tanpa rebuild seluruh pohon.
const nodeEls = new Map<
  string,
  {
    wrap: HTMLElement
    dot: HTMLElement
    badge: HTMLElement
    title: HTMLElement
    act: HTMLElement
    time: HTMLElement
    cwd: HTMLElement
  }
>()

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function ufillClass(v?: number | null): string {
  const x = v ?? 0
  return x >= 90 ? 'u-err' : x >= 70 ? 'u-warn' : ''
}
function fmtResetIn(iso: string | null): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'reset segera'
  const mins = Math.floor(ms / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `reset ${h}j ${m}m` : `reset ${m}m`
}
/** Statistik pemakaian LOKAL (token tercatat di PC ini), di-cache 60 detik. */
let statsCache: { at: number; s: UsageStats } | null = null
async function localStats(): Promise<UsageStats | null> {
  if (statsCache && Date.now() - statsCache.at < 60_000) return statsCache.s
  try {
    const s = await window.grove.getUsageStats()
    statsCache = { at: Date.now(), s }
    return s
  } catch {
    return null
  }
}

/** Penjelasan jujur kenapa angka akun ini kosong (bukan diam-diam menampilkan akun lain). */
function usageReasonText(r?: UsageUnavailable): string {
  switch (r) {
    case 'no-token':
      return 'Akun ini belum punya token tersimpan.'
    case 'scope':
      return 'Token akun ini (hasil `claude setup-token`) tidak punya scope user:profile, jadi endpoint limit menolaknya (403). Pemakaian akun ini memang tidak bisa dibaca dari Grove.'
    case 'unauthorized':
      return 'Token akun ini ditolak (401) — kemungkinan sudah kedaluwarsa.'
    case 'rate-limited':
      return 'Server sedang membatasi permintaan (429). Dicoba lagi otomatis.'
    case 'unsupported':
      return 'Gateway/proxy akun ini tidak menyediakan API kuota yang bisa Grove tanyakan (sudah dicek: /usage, /credits, /key, /me semuanya tidak ada). Yang bisa ditampilkan adalah pemakaian yang TERCATAT DI PC INI — angkanya di bawah — sedangkan sisa saldo sebenarnya ada di dashboard provider.'
    default:
      return 'Gagal menghubungi server limit. Dicoba lagi otomatis.'
  }
}

/**
 * Panel & header untuk akun ber-API-KEY (OpenRouter/DeepSeek): KREDIT/SALDO, bukan jendela waktu.
 * Angkanya datang dari API provider itu sendiri. Bila provider tak memberi batas (key free-tier
 * OpenRouter, saldo DeepSeek), persen sengaja ditulis "—" + alasannya — jangan mengarang 0%.
 */
function renderCreditUsage(
  box: HTMLElement,
  panel: HTMLElement,
  acct: string,
  label: string,
  c: CreditInfo,
  stale?: boolean
): void {
  const v = c.utilization
  const val = v != null ? Math.round(v) : 0
  const money = (n: number | null): string => (n == null ? '—' : c.currency === 'USD' ? fmtUsd(n) : `${n} ${c.currency}`)
  box.innerHTML =
    acct +
    `<span class="ubar-mini"><span class="ulabel">kredit</span><span class="ubar"><span class="ufill ${ufillClass(v)}" style="width:${val}%"></span></span><span class="uval">${
      v != null ? val + '%' : c.remaining != null ? money(c.remaining) : '—'
    }</span></span>`
  let html = `<div class="up-title">KREDIT API · ${label} (${c.provider})</div>`
  if (v != null) {
    html += `<div class="up-row"><div class="up-head"><span class="up-name">Kredit terpakai</span><span class="up-pct">${val}% terpakai</span></div><div class="up-bar"><span class="up-fill ${ufillClass(v)}" style="width:${val}%"></span></div></div>`
  }
  const rows: Array<[string, string]> = []
  if (c.used != null) rows.push(['Terpakai', money(c.used)])
  if (c.limit != null) rows.push(['Batas kredit', money(c.limit)])
  if (c.remaining != null) rows.push([c.limit != null ? 'Sisa' : 'Saldo', money(c.remaining)])
  if (c.freeTier) rows.push(['Tier', 'free'])
  for (const [k, val2] of rows) {
    html += `<div class="up-row"><div class="up-head"><span class="up-name">${escapeHtml(k)}</span><span class="up-pct">${escapeHtml(val2)}</span></div></div>`
  }
  if (c.note) html += `<div class="up-empty">${escapeHtml(c.note)}</div>`
  if (v == null)
    html += `<div class="up-empty">Ambang auto-switch tidak bisa ditegakkan untuk akun ini (tak ada angka batas), jadi proteksi yang berlaku hanya reaksi saat provider menolak.</div>`
  html += `<div class="up-updated">Update: ${new Date(c.fetchedAt).toLocaleTimeString()}${stale ? ' · data terakhir (refresh gagal)' : ''}</div>`
  panel.innerHTML = html
}

/**
 * Angka usage SELALU diberi identitas akun pemiliknya (email kalau bisa didapat, kalau
 * tidak label) — tanpa itu user tak bisa tahu "5-jam 19%" milik akun mana. usage null =
 * tak diketahui untuk akun tsb; kita tampilkan "—" + alasannya, BUKAN angka akun
 * sebelumnya (itu bug lamanya).
 */
function renderUsage(snap: UsageSnapshot): void {
  const box = $('usage')
  const panel = $('usage-limits') // hanya bagian LIMIT; riwayat ada di #usage-history (persist)
  const u = snap.usage
  const label = escapeHtml(snap.accountLabel)
  // Email lebih informatif daripada label bebas; kalau tak bisa didapat untuk akun ini,
  // JANGAN pakai email login utama — mundur ke label saja.
  const who = escapeHtml(snap.accountEmail ?? snap.accountLabel)
  const whoTitle = snap.accountEmail
    ? `${snap.accountLabel} · ${snap.accountEmail}`
    : `${snap.accountLabel} — email tak tersedia untuk akun ini`
  const acct = `<span class="uacct" title="${escapeHtml(whoTitle)}">${who}</span>`
  box.classList.toggle('stale', !!u?.stale)

  if (!u) {
    box.title = `${whoTitle} — pemakaian tak bisa dibaca dari provider. Klik untuk detail.`
    box.innerHTML = `${acct}<span class="ubar-mini"><span class="ulabel">usage</span><span class="uval">—</span></span>`
    panel.innerHTML =
      `<div class="up-title">BATAS PEMAKAIAN · ${who}</div>` +
      `<div class="up-empty">${escapeHtml(usageReasonText(snap.reason))}<br><br>Angka akun lain sengaja TIDAK ditampilkan di sini agar tidak menyesatkan.</div>`
    // Provider tanpa API kuota (gateway OpenAI-compatible / proxy) → tampilkan yang Grove BENAR-BENAR
    // tahu: token yang tercatat di PC ini untuk akun tersebut. Lebih berguna daripada "—" kosong.
    if (snap.reason === 'unsupported' && snap.accountId) {
      void localStats().then((st) => {
        if (!st || $('usage') !== box) return
        const row = st.byAccount.find((a) => a.accountId === snap.accountId)
        if (!row) return
        box.innerHTML = `${acct}<span class="ubar-mini"><span class="ulabel">lokal 7hr</span><span class="uval">${fmtTok(row.week.total)}</span></span>`
        box.title = `${whoTitle} — provider tak punya API kuota; ini token yang TERCATAT DI PC INI selama 7 hari terakhir.`
        panel.innerHTML +=
          `<div class="up-row"><div class="up-head"><span class="up-name">Tercatat di PC ini (7 hari)</span>` +
          `<span class="up-pct">${fmtTok(row.week.total)} token</span></div></div>` +
          `<div class="up-row"><div class="up-head"><span class="up-name">— input / output</span>` +
          `<span class="up-pct">${fmtTok(row.week.input + row.week.cacheRead + row.week.cacheCreation)} / ${fmtTok(row.week.output)}</span></div></div>` +
          `<div class="up-row"><div class="up-head"><span class="up-name">— jumlah respons API</span>` +
          `<span class="up-pct">${row.week.calls}</span></div></div>`
      })
    }
    return
  }
  box.title = u.stale
    ? `${whoTitle} — data terakhir (refresh gagal, token mungkin sedang di-refresh). Klik untuk detail.`
    : `${whoTitle} — klik untuk detail limit`
  // top bar: label akun + mini bars 5-jam + minggu
  const mini = (label: string, w?: UsageWindow): string => {
    const v = w?.utilization ?? null
    const val = v != null ? Math.round(v) : 0
    return `<span class="ubar-mini"><span class="ulabel">${label}</span><span class="ubar"><span class="ufill ${ufillClass(v)}" style="width:${val}%"></span></span><span class="uval">${v != null ? val + '%' : '—'}</span></span>`
  }
  // AKUN API-KEY: kuotanya berupa KREDIT/SALDO dari API providernya sendiri, bukan jendela
  // 5-jam/7-hari. Menampilkan dua bar Claude yang selalu "—" untuk akun begini cuma menyesatkan.
  if (u.credit) {
    renderCreditUsage(box, panel, acct, label, u.credit, u.stale)
    return
  }
  box.innerHTML = acct + mini('5-jam', u.fiveHour) + mini('minggu', u.sevenDay)

  // panel detail (ala halaman Usage web)
  const row = (name: string, w?: UsageWindow): string => {
    const v = w?.utilization ?? null
    if (v == null) return ''
    const val = Math.round(v)
    return `<div class="up-row"><div class="up-head"><span class="up-name">${name}<span class="up-reset">${fmtResetIn(w?.resetsAt ?? null)}</span></span><span class="up-pct">${val}% terpakai</span></div><div class="up-bar"><span class="up-fill ${ufillClass(v)}" style="width:${val}%"></span></div></div>`
  }
  let html = `<div class="up-title">BATAS PEMAKAIAN · ${label}</div>`
  html += row('Sesi saat ini (5 jam)', u.fiveHour)
  html += row('Mingguan — semua model', u.sevenDay)
  html += row('Mingguan — Opus', u.sevenDayOpus)
  html += row('Mingguan — Sonnet', u.sevenDaySonnet)
  if (u.monthly?.enabled) html += row('Bulanan (kredit)', { utilization: u.monthly.utilization, resetsAt: null })
  html += `<div class="up-updated">Update: ${new Date(u.fetchedAt).toLocaleTimeString()}${u.stale ? ' · data terakhir (refresh gagal)' : ''}</div>`
  panel.innerHTML = html
}

/** Angka token ringkas: 1234 → "1.2K", 3.4e6 → "3.4M". */
function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

/** Uang: kecil-kecil tetap harus kelihatan (biaya per hari bisa < 1 sen). */
function fmtUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(3)}`
  return `$${n.toFixed(4)}`
}

/**
 * Riwayat pemakaian token TERCATAT DI PC INI (jam/hari/minggu + tren harian), dari DB lokal.
 * Ini AKUMULASI token nyata tiap respons API — beda dari "BATAS PEMAKAIAN" di atas yang merupakan
 * utilisasi rolling-window dari server. Tujuannya: lihat pola boros/normal lintas hari.
 */
async function renderUsageHistory(): Promise<void> {
  const box = $('usage-history')
  box.innerHTML = '<div class="up-title">PEMAKAIAN PC INI</div><div class="up-empty">memuat…</div>'
  let s
  try {
    s = await window.grove.getUsageStats()
  } catch {
    box.innerHTML = '<div class="up-title">PEMAKAIAN PC INI</div><div class="up-empty">gagal memuat.</div>'
    return
  }
  if (!s.allTime.total) {
    box.innerHTML =
      '<div class="up-title">PEMAKAIAN PC INI</div><div class="up-empty">Belum ada pemakaian tercatat. Angka akan terkumpul otomatis tiap sesi berjalan, dan tersimpan untuk dicek besok-besok.</div>'
    return
  }
  // Cache = konteks dibaca-ulang tiap langkah tool (murah). "Setara-biaya" memberi bobot mendekati
  // penagihan: input baru 1×, tulis-cache 1.25×, baca-cache 0.1× (murah), output 5× (paling mahal).
  // Tanpa ini, cache-read (yang jumlahnya raksasa tapi murah) mendominasi & bikin angka terlihat seram.
  const cacheOf = (t: typeof s.hour): number => t.cacheRead + t.cacheCreation
  const eff = (t: typeof s.hour): number =>
    Math.round(t.input + 1.25 * t.cacheCreation + 0.1 * t.cacheRead + 5 * t.output)

  // Satu baris jendela: PECAH jujur — output (kerja nyata) · input baru · cache (baca-ulang, murah).
  const win = (name: string, t: typeof s.hour): string => {
    const tip = `output ${fmtTok(t.output)} · input baru ${fmtTok(t.input)} · baca-cache ${fmtTok(
      t.cacheRead
    )} · tulis-cache ${fmtTok(t.cacheCreation)} · ${t.calls} panggilan · setara-biaya ${fmtTok(eff(t))}`
    return `<div class="uh-row" title="${escapeHtml(name + ' — ' + tip)}"><span class="uh-name">${name}</span><span class="uh-val"><b>${fmtTok(
      t.output
    )}</b> out<span class="uh-out"> · ${fmtTok(t.input)} in · ${fmtTok(cacheOf(t))} cache</span></span></div>`
  }
  // Susunan SENGAJA menonjolkan 2 hal yang dipakai user:
  //   (1) seberapa dekat limit → ada di section BATAS PEMAKAIAN (di atas panel ini).
  //   (2) tren pemakaian lintas hari → VONIS + TREN, ditaruh PALING ATAS di sini.
  // Rincian token (jam/24h/7d/all) turun ke bawah sebagai pendukung — bukan headline yang bikin panik.
  const effDaily = s.daily.map((d) => ({ label: d.label, dayStart: d.dayStart, e: eff(d.tokens), out: d.tokens.output }))
  const todayStart = effDaily.length ? effDaily[effDaily.length - 1].dayStart : 0
  const todayE = effDaily.find((d) => d.dayStart === todayStart)?.e ?? 0
  const prior = effDaily.filter((d) => d.dayStart < todayStart)
  const avgE = prior.length ? prior.reduce((s2, d) => s2 + d.e, 0) / prior.length : 0

  let html = '<div class="up-title">TREN PEMAKAIAN PC INI</div>'

  // (2a) VONIS boros/normal — headline. Butuh ≥1 hari pembanding; kalau belum ada, beri tahu jujur.
  if (avgE > 0) {
    const ratio = todayE / avgE
    const pct = Math.round(ratio * 100)
    const cls = ratio >= 1.3 ? 'u-err' : ratio >= 1.05 ? 'u-warn' : 'ok'
    const verdict = ratio >= 1.3 ? 'BOROS' : ratio >= 1.05 ? 'agak tinggi' : 'normal/hemat'
    html += `<div class="uh-verdict ${cls}" title="setara-biaya hari ini vs rata-rata harian 7 hari sebelumnya">Hari ini ${pct}% dari rata-rata → ${verdict}</div>`
  } else {
    html += `<div class="uh-verdict ok" title="belum ada hari pembanding">Hari ini ${fmtTok(todayE)} (setara-biaya) — belum ada hari lain untuk dibandingkan (boros/normal muncul besok).</div>`
  }

  // (2c) TRAFFIC — jumlah request (panggilan API) dari DB + konteks/call. Inilah metrik yang benar
  // untuk "boros langkah": cache besar = konteks/call × JUMLAH call. Kalau req melonjak tapi output
  // tetap kecil, itu tanda banyak langkah agentic (worker/tool-loop), bukan kerja tulis yang besar.
  const trafficRow = (name: string, t: typeof s.hour): string => {
    const perCall = t.calls ? Math.round(cacheOf(t) / t.calls) : 0
    return `<div class="uh-row" title="${escapeHtml(
      `${name}: ${t.calls} request · rata-rata konteks/request ${fmtTok(perCall)} · output ${fmtTok(t.output)}`
    )}"><span class="uh-name">${name}</span><span class="uh-val"><b>${fmtTok(
      t.calls
    )}</b> req<span class="uh-out"> · ~${fmtTok(perCall)}/call</span></span></div>`
  }
  html += '<div class="uh-head">Traffic (request API)</div>'
  html += trafficRow('Jam ini', s.hour)
  html += trafficRow('24 jam', s.day)
  html += trafficRow('7 hari', s.week)
  html += trafficRow('Sejak awal', s.allTime)

  // (2b) TREN harian (setara-biaya, dinormalisasi ke hari tertinggi). Tooltip juga sebut req/hari.
  if (effDaily.length) {
    const callsByDay = new Map(s.daily.map((d) => [d.dayStart, d.tokens.calls]))
    const max = Math.max(...effDaily.map((d) => d.e), 1)
    html += '<div class="uh-head">Per hari (setara-biaya)</div>'
    for (const d of effDaily.slice(-14)) {
      const w = Math.round((d.e / max) * 100)
      html += `<div class="uh-day" title="${escapeHtml(
        `${d.label}: setara-biaya ${fmtTok(d.e)} · output ${fmtTok(d.out)} · ${callsByDay.get(d.dayStart) ?? 0} request`
      )}"><span class="uh-daylbl">${d.label}</span><span class="uh-daybar"><span class="uh-dayfill" style="width:${w}%"></span></span><span class="uh-dayval">${fmtTok(
        d.e
      )}</span></div>`
    }
  }

  // Per akun (7 hari) — setara-biaya (bukan cache mentah).
  if (s.byAccount.length > 1) {
    html += '<div class="uh-head">Per akun (7 hari · setara-biaya)</div>'
    for (const a of s.byAccount) {
      const tag =
        a.provider === 'custom'
          ? ' ⟨GM⟩'
          : a.provider === 'cursor'
            ? ' ⟨CR⟩'
            : a.provider === 'openrouter'
              ? ' ⟨OR⟩'
              : a.provider === 'deepseek'
                ? ' ⟨DS⟩'
                : ''
      // Akun DeepSeek: tampilkan DOLAR NYATA — "setara-biaya" itu bobot ala Claude, tak berlaku di sini.
      const dsUsd =
        a.provider === 'deepseek'
          ? deepseekCostUsd(a.week, accounts.find((x) => x.id === a.accountId)?.model)
          : null
      html += `<div class="uh-row" title="${escapeHtml(
        `output ${fmtTok(a.week.output)} · cache ${fmtTok(cacheOf(a.week))}${
          dsUsd != null ? ` · biaya nyata ${fmtUsd(dsUsd)}` : ''
        }`
      )}"><span class="uh-name">${escapeHtml(a.label)}${tag}</span><span class="uh-val">${
        dsUsd != null ? fmtUsd(dsUsd) : fmtTok(eff(a.week))
      }</span></div>`
    }
  }

  // SALDO & BIAYA DeepSeek — disisipkan setelah render utama (butuh fetch ke platform, jangan
  // menahan panel). Saldo = angka OTORITATIF dari DeepSeek; biaya per-jendela = perkiraan lokal.
  html += '<div id="uh-deepseek"></div>'

  // RINCIAN token per window — pendukung, di bawah. Diberi keterangan supaya "cache besar" tak bikin panik.
  html += '<div class="uh-head">Rincian token (jam/hari/minggu)</div>'
  html += win('Jam ini', s.hour)
  html += win('24 jam', s.day)
  html += win('7 hari', s.week)
  html += win('Sejak awal', s.allTime)
  html +=
    '<div class="up-empty" style="margin-top:6px"><b>cache</b> = konteks dibaca-ulang tiap langkah tool (murah, ~10× lebih ringan dari input baru) — wajar besar untuk multi-agent. Yang menandakan kerja = <b>output</b>. Sisa kuota → lihat BATAS PEMAKAIAN di atas.</div>'
  box.innerHTML = html
  void renderDeepseekCosts()
}

/**
 * Blok DeepSeek di panel usage: SALDO dari platform (otoritatif) + biaya terpakai per jendela waktu
 * (perkiraan lokal: token tercatat × harga publik model akun).
 *
 * Dua angka itu SENGAJA dipisah dan diberi label berbeda. Saldo tahu segalanya (promo, harga jam
 * sibuk, pemakaian dari aplikasi LAIN dengan key yang sama); perkiraan lokal hanya tahu apa yang
 * Grove kirim. Menyatukannya jadi satu angka akan menyesatkan begitu keduanya berbeda.
 */
async function renderDeepseekCosts(): Promise<void> {
  const slot = document.getElementById('uh-deepseek')
  if (!slot) return
  let rows: DeepseekAccountCost[]
  try {
    rows = await window.grove.getDeepseekCosts()
  } catch {
    return
  }
  if (!rows.length || !document.getElementById('uh-deepseek')) return
  let h = '<div class="uh-head">DeepSeek — saldo &amp; biaya</div>'
  for (const r of rows) {
    const bal = r.balance
    const balTxt = bal
      ? `${bal.currency === 'USD' ? fmtUsd(bal.total) : `${bal.total} ${bal.currency}`}${bal.available ? '' : ' ⚠️'}`
      : '—'
    const balTitle = bal
      ? `Saldo platform DeepSeek (otoritatif)\ntop-up ${bal.toppedUp} · kredit hadiah ${bal.granted} ${bal.currency}\n` +
        `${bal.available ? 'akun aktif' : '⚠️ saldo habis / akun tak bisa dipakai'}\ndiambil ${new Date(bal.fetchedAt).toLocaleTimeString()}`
      : `Saldo tak terbaca: ${r.error ?? 'tak diketahui'}`
    h += `<div class="uh-row" title="${escapeHtml(balTitle)}"><span class="uh-name">${escapeHtml(
      r.label
    )} <span class="uh-out">· saldo</span></span><span class="uh-val"><b>${balTxt}</b></span></div>`
    const c = r.cost
    const costTitle =
      `Perkiraan biaya dari token yang TERCATAT DI PC INI × harga publik ${r.model}.\n` +
      `${deepseekPriceLabel(r.model)}\n` +
      'Bukan tagihan resmi: promo, harga jam sibuk, dan pemakaian key ini di aplikasi lain tak terlihat dari sini — saldo di atas yang otoritatif.'
    h += `<div class="uh-row" title="${escapeHtml(costTitle)}"><span class="uh-name uh-sub">${escapeHtml(
      r.model
    )} · terpakai</span><span class="uh-val"><span class="uh-out">jam ${fmtUsd(c.hour)} · 24j ${fmtUsd(
      c.day
    )} · 7h ${fmtUsd(c.week)} · total </span><b>${fmtUsd(c.allTime)}</b></span></div>`
  }
  slot.innerHTML = h
}

// Beri tahu main sesi mana yang dipilih → usage di header ikut akun sesi itu.
// Guard `usageReq`: pindah sesi cepat-cepat bisa membuat balasan lama datang belakangan;
// hanya balasan permintaan TERAKHIR yang boleh dirender.
let usageReq = 0
function syncUsageSession(): void {
  const my = ++usageReq
  void window.grove
    .setUsageSession(activeId)
    .then((snap) => {
      if (my === usageReq) renderUsage(snap)
    })
    .catch(() => {})
}

// ---- markdown ringan (aman: escape dulu) → tampil ala Claude Code CLI ------

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
  )
}

function mdInline(s: string): string {
  let r = escapeHtml(s)
  r = r.replace(/`([^`]+)`/g, '<code>$1</code>')
  r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  r = r.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) =>
    /^https?:\/\//i.test(u) ? `<a href="${u}" target="_blank" rel="noreferrer">${t}</a>` : m
  )
  return r
}

function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let code: string[] | null = null
  const closeList = (): void => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (code === null) {
        closeList()
        code = []
      } else {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
        code = null
      }
      continue
    }
    if (code !== null) {
      code.push(raw)
      continue
    }
    const h = raw.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      closeList()
      out.push(`<div class="md-h md-h${Math.min(h[1].length, 3)}">${mdInline(h[2])}</div>`)
      continue
    }
    const ul = raw.match(/^\s*[-*+]\s+(.*)$/)
    if (ul) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${mdInline(ul[1])}</li>`)
      continue
    }
    const ol = raw.match(/^\s*\d+\.\s+(.*)$/)
    if (ol) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${mdInline(ol[1])}</li>`)
      continue
    }
    if (/^\s*---+\s*$/.test(raw)) {
      closeList()
      out.push('<hr>')
      continue
    }
    if (raw.trim() === '') {
      closeList()
      out.push('<div class="md-sp"></div>')
      continue
    }
    closeList()
    out.push(`<div class="md-p">${mdInline(raw)}</div>`)
  }
  closeList()
  if (code !== null) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
  return out.join('')
}

// rAF batching untuk hindari jank.
let boardRaf = 0
let scrollRaf = 0
let pendingRaf = 0

// Batasi jumlah node DOM di chat-log → mencegah lag saat sesi panjang/aktif (riwayat penuh tetap di DB).
const MAX_CHAT_DOM = 400
function capChatLog(): void {
  const log = $('chat-log')
  while (log.childElementCount > MAX_CHAT_DOM) log.removeChild(log.firstElementChild as ChildNode)
}

function scheduleBoard(): void {
  if (boardRaf) return
  boardRaf = requestAnimationFrame(() => {
    boardRaf = 0
    renderBoard()
  })
}

/**
 * AUTO-SCROLL YANG TAHU DIRI. Dulu tiap pesan/token baru menyeret pandangan ke bawah, jadi mustahil
 * membaca bagian atas selagi worker bekerja. Sekarang: begitu kamu menggulir menjauh dari dasar,
 * auto-scroll BERHENTI (dan tombol "↓ pesan terbaru" muncul); begitu kamu kembali ke dasar — lewat
 * tombol itu atau menggulir sendiri — auto-scroll menyala lagi.
 */
let autoScroll = true
const SCROLL_BOTTOM_SLACK = 60 // px; masih dianggap "di dasar" (toleransi sub-pixel & baris tumbuh)

function chatAtBottom(): boolean {
  const log = $('chat-log')
  return log.scrollHeight - log.scrollTop - log.clientHeight <= SCROLL_BOTTOM_SLACK
}

/** Sinkronkan tombol lompat + status auto-scroll dari posisi gulir sekarang. */
function syncChatScrollState(): void {
  const atBottom = chatAtBottom()
  autoScroll = atBottom
  const btn = document.getElementById('chat-jump')
  if (btn) btn.hidden = atBottom
}

/**
 * ENDAPKAN posisi di dasar selama beberapa frame.
 *
 * Pesan di luar layar dilewati layout-nya (content-visibility) sehingga tingginya masih TAKSIRAN;
 * begitu browser merender item itu, tinggi aslinya menggeser scrollHeight dan posisi yang tadinya
 * "paling bawah" jadi meleset ke atas — persis bug "pesan terbaru tidak sampai ke bawah, tiap prompt
 * malah naik sendiri". Karena itu dasar ditegakkan ulang beberapa frame sampai benar-benar diam.
 */
function settleBottom(framesLeft: number): void {
  if (framesLeft <= 0) return
  requestAnimationFrame(() => {
    if (!autoScroll) return // user menggulir ke atas di tengah pengendapan → hormati
    const log = $('chat-log')
    if (log.scrollHeight - log.scrollTop - log.clientHeight > 1) log.scrollTop = log.scrollHeight
    settleBottom(framesLeft - 1)
  })
}

/** `force` = permintaan eksplisit user (tombol/ganti sesi) → selalu turun & nyalakan lagi. */
let scrollForce = false
function scrollChatToBottom(force = false): void {
  if (force) {
    autoScroll = true
    scrollForce = true
    const btn = document.getElementById('chat-jump')
    if (btn) btn.hidden = true
  } else if (!autoScroll) {
    return // user sedang membaca di atas — jangan diseret
  }
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const wantForce = scrollForce
    scrollForce = false
    // PERIKSA ULANG DI DALAM FRAME. requestAnimationFrame bisa tertunda lama (jendela tersembunyi/
    // minimize → rAF di-throttle), dan saat akhirnya jalan, user mungkin SUDAH menggulir ke atas.
    // Tanpa cek kedua ini, keputusan basi dari beberapa detik lalu tetap menyeret pandangannya.
    if (!wantForce && !autoScroll) return
    const log = $('chat-log')
    log.scrollTop = log.scrollHeight
    settleBottom(4)
  })
}

// Efek ketik: ungkap teks menuju pendingText secara halus (SDK kirim ~50 char/500ms).
function flushPending(): void {
  pendingRaf = 0
  if (!pendingEl || !pendingTextNode) {
    shownLen = 0
    return
  }
  if (shownLen < pendingText.length) {
    const remaining = pendingText.length - shownLen
    // kecepatan ungkap menyesuaikan backlog (min 1/frame → selalu mengalir & tak tertinggal)
    const next = Math.min(pendingText.length, shownLen + Math.max(1, Math.ceil(remaining / 12)))
    // B4: APPEND hanya substring yang baru terungkap (O(char baru)) — bukan menyalin ulang
    // seluruh string yang tumbuh tiap frame (dulu `textContent = slice(0,n)` → O(n²)).
    pendingTextNode.appendData(pendingText.slice(shownLen, next))
    shownLen = next
    scrollChatToBottom()
    pendingRaf = requestAnimationFrame(flushPending)
  }
}

// ---- helpers ---------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (HTMLElement | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const { class: cls, ...rest } = props
  if (cls) node.className = cls
  Object.assign(node, rest)
  for (const c of children) node.append(c)
  return node
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const shortId = (id: string) => id.slice(0, 6)

function badgeClass(pct: number): string {
  if (pct >= 85) return 'badge err'
  if (pct >= 60) return 'badge warn'
  return 'badge ok'
}

/** Teks badge ctx: '·' saat pending (konteks baru di-reset/compact), selain itu 'NN%'. */
function ctxBadgeText(n: { ctxPercent: number; ctxPending?: boolean }): string {
  return n.ctxPending ? '·' : `${n.ctxPercent}%`
}

/** Kelas badge ctx: netral (abu) saat pending, selain itu warna sesuai ambang. */
function ctxBadgeClass(n: { ctxPercent: number; ctxPending?: boolean }): string {
  return n.ctxPending ? 'badge' : badgeClass(n.ctxPercent)
}

// ---- tree ------------------------------------------------------------------

/** Kunci urut dalam grup: orderIndex manual bila ada, jika tidak createdAt. */
function orderKey(n: Node): number {
  return n.orderIndex ?? n.createdAt
}
function orderCmp(a: Node, b: Node): number {
  return orderKey(a) - orderKey(b) || a.id.localeCompare(b.id)
}

/** Grup reorder = role + parent yang sama. Hanya sesama grup boleh saling geser. */
function groupKeyOf(n: Node): string {
  return `${n.role}|${n.parentId ?? 'ROOT'}`
}

// ---- drag reorder (tekan-tahan ~200ms untuk menggenggam, lalu geser) --------
const HOLD_MS = 200
let drag: {
  id: string
  group: string
  pointerId: number
  startY: number
  active: boolean
  holdTimer: number | null
} | null = null
let dropTargetId: string | null = null
let dropPos: 'above' | 'below' = 'above'
let suppressClickUntil = 0 // klik dalam jendela waktu ini (pasca-drag) tak memilih session

function clearDropMarks(): void {
  for (const { wrap } of nodeEls.values()) wrap.classList.remove('drop-above', 'drop-below')
}

function cancelDrag(): void {
  if (drag?.holdTimer) clearTimeout(drag.holdTimer)
  if (drag) nodeEls.get(drag.id)?.wrap.classList.remove('dragging')
  document.body.classList.remove('reordering')
  clearDropMarks()
  drag = null
  dropTargetId = null
}

/** Anggota grup yang sama dengan node yang sedang diseret, urut visual. */
function groupMembers(group: string): Node[] {
  return [...nodes.values()].filter((n) => groupKeyOf(n) === group).sort(orderCmp)
}

function onNodePointerDown(e: PointerEvent, node: Node): void {
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest('.node-del')) return // jangan mulai drag dari tombol hapus
  // Hanya berguna bila ada ≥2 anggota segrup untuk saling ditukar.
  if (groupMembers(groupKeyOf(node)).length < 2) return
  drag = { id: node.id, group: groupKeyOf(node), pointerId: e.pointerId, startY: e.clientY, active: false, holdTimer: null }
  drag.holdTimer = window.setTimeout(() => {
    if (!drag) return
    drag.active = true
    drag.holdTimer = null
    nodeEls.get(drag.id)?.wrap.classList.add('dragging')
    document.body.classList.add('reordering')
  }, HOLD_MS)
}

function onDragMove(e: PointerEvent): void {
  if (!drag) return
  if (!drag.active) {
    // Gerak sebelum hold selesai → batalkan (biar bisa scroll / klik biasa).
    if (Math.abs(e.clientY - drag.startY) > 6) cancelDrag()
    return
  }
  e.preventDefault()
  clearDropMarks()
  const members = groupMembers(drag.group).filter((m) => m.id !== drag!.id)
  if (!members.length) return
  // Cari anggota yang titik-tengahnya pertama kali di bawah kursor → sisip sebelum dia.
  let target: Node | null = null
  for (const m of members) {
    const r = nodeEls.get(m.id)?.wrap.getBoundingClientRect()
    if (!r) continue
    if (e.clientY < r.top + r.height / 2) {
      target = m
      break
    }
  }
  if (target) {
    dropTargetId = target.id
    dropPos = 'above'
    nodeEls.get(target.id)?.wrap.classList.add('drop-above')
  } else {
    const last = members[members.length - 1]
    dropTargetId = last.id
    dropPos = 'below'
    nodeEls.get(last.id)?.wrap.classList.add('drop-below')
  }
}

function onDragEnd(): void {
  if (!drag) return
  const wasActive = drag.active
  const dragId = drag.id
  const group = drag.group
  const targetId = dropTargetId
  const pos = dropPos
  cancelDrag()
  if (!wasActive) return // cuma tekan singkat → biarkan klik memilih session
  suppressClickUntil = performance.now() + 350 // ada drag → tekan klik berikutnya tak memilih
  if (!targetId || targetId === dragId) {
    renderTree()
    return
  }
  // Susun urutan baru: keluarkan dragId, sisipkan relatif ke target.
  const orderIds = groupMembers(group).map((m) => m.id)
  const without = orderIds.filter((id) => id !== dragId)
  let idx = without.indexOf(targetId)
  if (pos === 'below') idx += 1
  without.splice(idx, 0, dragId)
  // Terapkan optimistis ke state lokal lalu render + persist.
  without.forEach((id, i) => {
    const n = nodes.get(id)
    if (n) n.orderIndex = i
  })
  renderTree()
  void window.grove.reorderSessions(without).catch((err) => alert(`Gagal ubah urutan: ${String(err)}`))
}

// ---- kunci folder kerja per-sesi (drag-drop folder) ------------------------

/** Drag membawa FILE dari luar (bukan drag/seleksi internal)? */
const dragHasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')

/**
 * Sudah ditangani sebagai "drop FOLDER" (kartu sesi / zona sidebar)? Dipakai supaya handler drop
 * global tidak ikut memperlakukan folder itu sebagai "referensi chat". Sengaja TIDAK memakai
 * stopPropagation: handler global-lah yang membereskan overlay & counter dragenter, jadi ia tetap
 * harus jalan — hanya bagian "jadikan referensi" yang dilewati.
 */
let folderDropHandled = false

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Label folder untuk badge kartu: basename saja. Sesi scratch otomatis (…/grove/scratch/<uuid>)
 * ditampilkan netral sebagai "scratch" — jangan pamerkan UUID panjang ke user.
 */
function folderLabel(cwd: string): string {
  const base = (cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  if (!base) return 'scratch'
  return UUID_RE.test(base) || base.toLowerCase() === 'scratch' ? 'scratch' : base
}

/**
 * Ambil path FOLDER dari sebuah drop.
 * Electron 43 sudah MENGHAPUS `File.path`, jadi path wajib diambil lewat
 * `webUtils.getPathForFile(file)` yang di-expose preload sebagai `window.grove.getPathForFile`.
 * `webkitGetAsEntry().isDirectory` dipakai untuk menyaring file biasa lebih awal; validasi
 * otoritatif (ada + benar-benar direktori) tetap dilakukan main lewat statSync.
 * Mengembalikan null bila yang di-drop jelas bukan folder.
 */
function folderPathFromDrop(e: DragEvent): string | null {
  const fileItems = Array.from(e.dataTransfer?.items ?? []).filter((it) => it.kind === 'file')
  if (fileItems.length) {
    for (const it of fileItems) {
      const entry = it.webkitGetAsEntry?.()
      if (entry && !entry.isDirectory) continue // file biasa → bukan kandidat folder
      const f = it.getAsFile()
      if (f) return window.grove.getPathForFile(f)
    }
    return null // ada yang di-drop, tapi tak satu pun folder
  }
  const f = e.dataTransfer?.files?.[0]
  return f ? window.grove.getPathForFile(f) : null
}

/** Drop folder ke KARTU sesi → kunci sesi itu ke folder tersebut. */
async function lockSessionToFolder(id: string, e: DragEvent): Promise<void> {
  const path = folderPathFromDrop(e)
  if (!path) {
    alert('Drop sebuah FOLDER (bukan file) untuk mengunci folder kerja sesi.')
    return
  }
  try {
    const meta = await window.grove.setSessionCwd(id, path)
    const cur = nodes.get(id)
    if (cur) {
      cur.cwd = meta.cwd
      updateNodeVisual(id)
    }
    if (id === activeId) updateChatHeader()
  } catch (err) {
    alert(`Gagal mengunci folder: ${String(err)}`)
  }
}

/** Drop folder ke area KOSONG sidebar → sesi BARU yang langsung terkunci di folder itu. */
async function createSessionInFolder(e: DragEvent): Promise<void> {
  const path = folderPathFromDrop(e)
  if (!path) {
    alert('Drop sebuah FOLDER (bukan file) untuk membuat sesi project baru.')
    return
  }
  try {
    const meta = await window.grove.dropFolder(path) // jalur yang sama dengan tombol "+ Folder"
    ensureNode(meta)
    void selectSession(meta.id)
  } catch (err) {
    alert(`Gagal membuat sesi dari folder: ${String(err)}`)
  }
}

// ---- ZONA drop: kolom SESSIONS vs kolom CHAT (arti berbeda) ----------------

/**
 * Dua zona dengan SEMANTIK berbeda:
 *  - 'sidebar' (kolom SESSIONS) → folder = KUNCI FOLDER KERJA (setara tombol "+ Folder")
 *  - 'chat'    (kolom percakapan) → file/folder = REFERENSI chat ini, gambar = lampiran
 *
 * Zona ditentukan dari elemen yang sedang di-hover. Ini hanya mungkin karena `.drop-overlay`
 * memakai `pointer-events: none`: tanpa itu overlay full-screen tersebut MENELAN semua event drag,
 * `e.target` selalu si overlay, dan kartu sesi tak akan pernah menerima dragover/drop sama sekali.
 */
type DropZone = 'sidebar' | 'chat'

const ZONE_HINT: Record<DropZone, string> = {
  sidebar: '📁 Lepas FOLDER → kunci folder kerja sesi (fokus)',
  chat: '📎 Lepas file/folder → jadi referensi chat ini · gambar → lampiran'
}

function zoneOf(e: DragEvent): DropZone {
  const t = e.target as Element | null
  return t?.closest?.('.sidebar') ? 'sidebar' : 'chat'
}

/** Bersihkan SEMUA penanda drag-over (zona + kartu) — dipanggil saat drop / drag selesai. */
function clearDropAffordance(): void {
  document.querySelector('.sidebar')?.classList.remove('drop-target')
  document.querySelector('.chat')?.classList.remove('drop-target')
  for (const { wrap } of nodeEls.values()) wrap.classList.remove('drop-folder', 'drop-reject')
}

/** Judul root sebuah node — dipakai mengarahkan user saat ia salah-drop ke kartu SUB. */
function rootTitleOf(node: Node): string {
  let cur: Node | undefined = node
  const seen = new Set<string>()
  while (cur?.parentId && !seen.has(cur.id)) {
    seen.add(cur.id)
    cur = nodes.get(cur.parentId)
  }
  return cur?.title ?? 'UTAMA'
}

/**
 * Drop folder di kolom SESSIONS tapi DI LUAR kartu mana pun → sesi BARU terkunci di folder itu.
 * Dipasang pada `.sidebar` (bukan `#tree`) agar area kosong termasuk header kolom ikut menerima.
 * Kartu sesi menangani dropnya lebih dulu lalu menyalakan `folderDropHandled`, jadi di sini cukup
 * mengecek flag itu — TANPA stopPropagation, supaya handler global tetap membereskan overlay.
 */
function setupSidebarFolderDrop(): void {
  const sidebar = document.querySelector<HTMLElement>('.sidebar')
  if (!sidebar) return
  sidebar.addEventListener('drop', (e) => {
    if (!dragHasFiles(e)) return
    if (folderDropHandled) return // sudah ditangani kartu sesi
    e.preventDefault()
    folderDropHandled = true
    void createSessionInFolder(e)
  })
}

function renderTree(): void {
  const tree = $('tree')
  tree.textContent = ''
  nodeEls.clear()
  const roots = [...nodes.values()].filter((n) => !n.parentId || !nodes.has(n.parentId))
  roots.sort(orderCmp)
  if (roots.length === 0) {
    tree.append(
      el(
        'div',
        { class: 'empty' },
        'Klik "+ Chat" atau langsung ketik untuk mulai. "+ Folder" — atau DROP sebuah folder ke sini — untuk sesi proyek. Drop folder ke kartu sesi = kunci folder kerjanya. Drag file ke jendela = tambah referensi.'
      )
    )
    return
  }
  for (const r of roots) renderNode(r, 0, tree)
}

/**
 * HITUNGAN KLIK BERUNTUN PER KARTU — sengaja TIDAK memakai `MouseEvent.detail`.
 *
 * `detail` dihitung browser terhadap ELEMEN/posisi yang sama, sementara kartu sesi bisa dibangun
 * ulang (renderTree) tepat di tengah rentetan klik — mis. saat sesi lain melapor. Begitu elemennya
 * diganti, hitungannya balik ke 1 dan klik ke-3 tak pernah terlihat sebagai klik ke-3. State di
 * sini di-key oleh ID SESI, jadi ia kebal terhadap rebuild DOM.
 */
const TRIPLE_CLICK_MS = 700
let clickRun = { id: '', n: 0, at: 0 }

function countCardClick(id: string): number {
  const now = performance.now()
  if (clickRun.id !== id || now - clickRun.at > TRIPLE_CLICK_MS) clickRun = { id, n: 0, at: now }
  clickRun.n++
  clickRun.at = now
  return clickRun.n
}

/**
 * Sub-worker baru di bawah sebuah kartu (klik 3×). Worker lahir IDLE tanpa tugas — nol token
 * sampai user mengetik — lalu langsung dipilih & kursor pindah ke kolom ketik supaya tinggal
 * menuliskan tugasnya.
 */
async function createWorkerUnder(parentId: string): Promise<void> {
  try {
    const meta = await window.grove.newWorker(parentId)
    ensureNode(meta) // daftarkan segera → tidak race dengan event session:new
    await selectSession(meta.id)
    document.getElementById('chat-input')?.focus()
  } catch (err) {
    alert(`Gagal membuat worker: ${String(err)}`)
  }
}

function renderNode(node: Node, depth: number, container: HTMLElement): void {
  // Bug 1: sertakan status blink/stop/draft SAAT rebuild. Tanpa ini, renderTree() (mis. saat sesi
  // baru muncul / dihapus / reorder — sering terjadi tepat setelah satu sesi dijawab lalu pohonnya
  // berubah) menghapus kelas .awaiting-input dari SEMUA kartu, jadi kartu LAIN yang masih menunggu
  // jawaban ikut berhenti berkedip walau baru satu sesi yang benar-benar dibalas. State per-kartu
  // (node.awaitingInput/apiStopped) tetap utuh di `nodes`, jadi cukup dipetakan ulang ke kelas di sini.
  const wrap = el('div', {
    class:
      `node${depth > 0 ? ' child' : ''}${activeId === node.id ? ' active' : ''}` +
      `${node.awaitingInput ? ' awaiting-input' : ''}${node.apiStopped ? ' api-stopped' : ''}` +
      `${drafts.has(node.id) ? ' has-draft' : ''}`
  })
  wrap.style.marginLeft = `${depth * 14}px`
  wrap.dataset.id = node.id
  wrap.onclick = () => {
    if (performance.now() < suppressClickUntil) return // klik pasca-drag → jangan pilih
    // KLIK 3× (dalam 700ms) = bikin sub-worker di bawah kartu ini. Klik ke-1 & ke-2 tetap memilih
    // sesinya — itu memang diinginkan: worker lahir di pohon yang sedang dilihat.
    if (countCardClick(node.id) >= 3) {
      clickRun.n = 0 // klik ke-4/5 jangan memberondong worker baru
      window.getSelection()?.removeAllRanges() // klik beruntun menyeleksi teks kartu — bersihkan
      void createWorkerUnder(node.id)
      return
    }
    void selectSession(node.id)
  }
  wrap.addEventListener('pointerdown', (e) => onNodePointerDown(e, node)) // tekan-tahan → geser
  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault() // klik-kanan → menu akun/model per-chat (bukan menu bawaan browser)
    showSessionMenu(node, e.clientX, e.clientY)
  })

  // Drop FOLDER ke kartu ini (zona SESSIONS). HANYA kartu ROOT yang boleh mengunci folder:
  // sub-worker MEWARISI folder kerja dari root-nya, jadi drop ke kartu SUB sengaja DITOLAK dengan
  // petunjuk — ini menghapus risiko tak sengaja mereset konteks sebuah sub yang sedang bekerja.
  // (Reorder antar-kartu memakai pointer event, bukan HTML5 drag → kedua mekanisme tak bertabrakan.)
  const isRoot = node.role === 'root'
  wrap.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    wrap.classList.add(isRoot ? 'drop-folder' : 'drop-reject')
  })
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-folder', 'drop-reject'))
  wrap.addEventListener('drop', (e) => {
    wrap.classList.remove('drop-folder', 'drop-reject')
    if (!dragHasFiles(e)) return
    e.preventDefault()
    folderDropHandled = true // handler global melewati "jadikan referensi", tapi tetap bereskan overlay
    if (isRoot) {
      void lockSessionToFolder(node.id, e)
    } else {
      alert(
        `Sub-worker mengikuti folder kerja root-nya ("${rootTitleOf(node)}") — folder TIDAK diubah.\n\n` +
          'Drop folder ke kartu UTAMA milik pohon ini untuk memindahkan seluruh pohon.'
      )
    }
  })

  const dot = el('span', { class: `dot s-${node.status}` })
  const title = el('span', { class: 'node-title' }, node.title)
  const badge = el('span', { class: ctxBadgeClass(node) }, ctxBadgeText(node))
  const del = el('button', { class: 'node-del', title: 'Hapus session' }, '×')
  del.onclick = (e) => {
    e.stopPropagation()
    confirmDelete(node.id)
  }
  const row = el('div', { class: 'node-row' }, dot, title, badge, del)
  const act = el('span', { class: 'node-act' }, activities.get(node.id) ?? '')
  const time = el('span', { class: 'node-time' }, '')
  // Badge folder kerja: basename saja (full path di tooltip) supaya user bisa MEMVERIFIKASI
  // sesi ini terkunci di mana tanpa menebak.
  const cwdEl = el(
    'span',
    { class: 'node-cwd', title: `Folder kerja: ${node.cwd}\n(drop sebuah folder ke kartu ini untuk memindahkannya)` },
    `📁 ${folderLabel(node.cwd)}`
  )
  const meta = el(
    'div',
    { class: 'node-meta' },
    el('span', { class: `role-tag ${node.role}` }, node.role === 'root' ? 'UTAMA' : 'SUB'),
    el('span', { class: 'node-id' }, shortId(node.id)),
    cwdEl,
    act,
    time
  )
  wrap.append(row, meta)
  container.append(wrap)
  nodeEls.set(node.id, { wrap, dot, badge, title, act, time, cwd: cwdEl })
  if (!lastActive.has(node.id) && node.updatedAt) lastActive.set(node.id, node.updatedAt) // seed dari DB
  updateNodeTime(node.id)

  const children = [...nodes.values()].filter((n) => n.parentId === node.id)
  children.sort(orderCmp)
  for (const c of children) renderNode(c, depth + 1, container)
}

/** Update tampilan satu node (dot/badge/title/active) tanpa rebuild pohon. */
function updateNodeVisual(id: string): void {
  const refs = nodeEls.get(id)
  const n = nodes.get(id)
  if (!refs || !n) return
  refs.dot.className = `dot s-${n.status}`
  refs.title.textContent = n.title
  refs.badge.textContent = ctxBadgeText(n)
  refs.badge.className = ctxBadgeClass(n)
  refs.wrap.classList.toggle('active', activeId === id)
  refs.wrap.classList.toggle('api-stopped', !!n.apiStopped) // dihentikan API Claude → judul merah
  refs.wrap.classList.toggle('awaiting-input', !!n.awaitingInput) // menunggu jawaban user/parent → kedip kuning
  refs.wrap.classList.toggle('has-draft', drafts.has(id)) // ada teks/lampiran compose belum terkirim → tanda ✎
  refs.cwd.textContent = `📁 ${folderLabel(n.cwd)}` // folder bisa berubah (drop folder ke kartu)
  refs.cwd.title = `Folder kerja: ${n.cwd}\n(drop sebuah folder ke kartu ini untuk memindahkannya)`
}

function updateActiveHighlight(): void {
  for (const [id, refs] of nodeEls) refs.wrap.classList.toggle('active', activeId === id)
}

function updateNodeActivity(id: string): void {
  const refs = nodeEls.get(id)
  if (refs) refs.act.textContent = activities.get(id) ?? ''
}

/** Untuk sesi non-running (idle/done/error): tampilkan jam kerja terakhir "· HH:MM". */
function updateNodeTime(id: string): void {
  const refs = nodeEls.get(id)
  const n = nodes.get(id)
  if (!refs?.time || !n) return
  const active = n.status === 'running'
  const ts = lastActive.get(id)
  refs.time.textContent = !active && ts ? `· ${fmtClock(ts)}` : ''
}

/** Catat sesi baru saja aktif → simpan waktu + refresh label jam. */
function touchActive(id: string): void {
  lastActive.set(id, Date.now())
  updateNodeTime(id)
}

function countDescendants(id: string): number {
  let c = 0
  for (const n of nodes.values()) if (n.parentId === id) c += 1 + countDescendants(n.id)
  return c
}

/**
 * Konfirmasi DALAM HALAMAN — pengganti window.confirm bawaan.
 *
 * BUG YANG DIPERBAIKI: dialog native Electron (confirm/alert) sering membuat jendela kehilangan
 * fokus keyboard di level OS setelah ditutup. Gejalanya persis seperti yang dilaporkan — sesudah
 * menghapus chat, kolom ketik tampak normal (caret ada) dan PASTE tetap jalan (itu lewat accelerator
 * menu Edit), tapi ketikan tak masuk sama sekali. Dialog HTML tak pernah meninggalkan fokus di luar
 * halaman, dan di akhir kita kembalikan fokus ke kolom chat secara eksplisit.
 */
function uiConfirm(message: string, okLabel = 'Ya, lanjut'): Promise<boolean> {
  return new Promise((resolve) => {
    const no = el('button', { class: 'modal-btn' }, 'Batal')
    const yes = el('button', { class: 'modal-btn danger' }, okLabel)
    const box = el(
      'div',
      { class: 'modal-box' },
      el('div', { class: 'modal-text' }, message),
      el('div', { class: 'modal-actions' }, no, yes)
    )
    const back = el('div', { class: 'modal-back' }, box)
    const done = (v: boolean): void => {
      document.removeEventListener('keydown', onKey, true)
      back.remove()
      const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
      input?.focus() // fokus balik ke kolom ketik — jangan tinggalkan halaman tanpa target ketik
      resolve(v)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        done(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        done(true)
      }
    }
    document.addEventListener('keydown', onKey, true)
    no.addEventListener('click', () => done(false))
    yes.addEventListener('click', () => done(true))
    back.addEventListener('click', (e) => {
      if (e.target === back) done(false)
    })
    document.body.append(back)
    yes.focus()
  })
}

async function confirmDelete(id: string): Promise<void> {
  const n = nodes.get(id)
  const kids = countDescendants(id)
  const extra = kids ? ` beserta ${kids} sub-session` : ''
  if (!(await uiConfirm(`Hapus session "${n?.title ?? id}"${extra}?`, 'Hapus'))) return
  // Terapkan segera dari id yang dikembalikan (jangan tunggu event) → tutup race "target basi".
  try {
    applyRemoved(await window.grove.deleteSession(id))
  } catch (err) {
    appendChatMessage({ role: 'system', text: `⚠️ Gagal hapus: ${String(err)}`, ts: Date.now() })
  }
  ;(document.getElementById('chat-input') as HTMLTextAreaElement | null)?.focus()
}

/** Bersihkan sesi yang dihapus dari state; bila sesi AKTIF ikut terhapus, pindah ke sesi lain. */
function applyRemoved(ids: string[]): void {
  let activeRemoved = false
  for (const id of ids) {
    nodes.delete(id)
    board.delete(id)
    nodeEls.delete(id)
    activities.delete(id)
    lastActive.delete(id)
    drafts.delete(id) // sesi dihapus → buang draft-nya (jangan bocor ke sesi lain / memori nyangkut)
    if (id === activeId) activeRemoved = true
  }
  renderTree()
  scheduleBoard()
  if (!activeRemoved) return
  activeId = null
  const next = [...nodes.values()].sort(orderCmp)[0] // auto-pilih sesi tersisa biar bisa lanjut chat
  if (next) {
    void selectSession(next.id)
  } else {
    pendingEl = null
    pendingTextNode = null
    pendingText = ''
    $('chat-log').textContent = ''
    toolDetailEls.clear()
    logReset()
    renderMemories()
    updateChatHeader()
  }
}

// ---- chat ------------------------------------------------------------------

/** Simpan isi kolom ketik (teks + lampiran) sebagai draft milik sesi `id`; kosong → hapus draft. */
function saveDraft(id: string): void {
  const text = $<HTMLTextAreaElement>('chat-input').value
  if (text.trim() || pendingImages.length || pendingRefs.length) {
    drafts.set(id, { text, images: pendingImages.slice(), refs: pendingRefs.slice() })
  } else {
    drafts.delete(id)
  }
  updateNodeVisual(id) // segarkan penanda ✎ "ada draft belum terkirim" pada kartu
}

/**
 * Muat draft sesi `id` ke kolom ketik (kosong bila belum ada) lalu KELUARKAN dari map — draft sesi
 * aktif kini "hidup" di textarea, bukan di map, sehingga penanda ✎ hanya muncul di sesi non-aktif.
 */
function loadDraft(id: string): void {
  const d = drafts.get(id)
  drafts.delete(id)
  const input = $<HTMLTextAreaElement>('chat-input')
  input.value = d?.text ?? ''
  pendingImages = d ? d.images : []
  pendingRefs = d ? d.refs : []
  autoGrow(input)
  renderAttachStrip()
  updateNodeVisual(id)
}

async function selectSession(id: string): Promise<void> {
  // Bug 2: pindah sesi → SIMPAN draft sesi lama, MUAT draft sesi baru. Hanya saat benar-benar ganti
  // sesi (bukan re-select sesi yang sama, supaya teks yang sedang diketik tak ikut terhapus).
  if (activeId !== id) {
    if (activeId) saveDraft(activeId)
    activeId = id
    loadDraft(id)
  }
  syncUsageSession() // usage di header ikut akun sesi yang baru dipilih
  void refreshReferences(id) // daftar referensi sesi ini (untuk menu klik-kanan)
  // Antrian & riwayat prompt milik SESI INI (jangan bawa punya sesi sebelumnya).
  resetHistoryNav()
  queueItems = []
  sentPrompts = []
  renderQueueStrip()
  void window.grove
    .listQueued(id)
    .then((items) => {
      if (activeId !== id) return
      queueItems = items
      renderQueueStrip()
    })
    .catch(() => {})
  pendingEl = null
  pendingTextNode = null
  pendingText = ''
  shownLen = 0
  updateChatHeader()
  const input = $<HTMLInputElement>('chat-input')
  const send = $<HTMLButtonElement>('chat-send')
  input.disabled = false
  send.disabled = false
  input.focus()

  const log = $('chat-log')
  log.textContent = ''
  toolDetailEls.clear() // panel detail milik sesi lama tak relevan lagi
  logReset() // pohon LOG ikut di-rebuild untuk sesi baru
  const history = await window.grove.getChat(id)
  // Balapan async: kalau pilihan berubah selama getChat berjalan (klik sesi lain, ATAU sesi ini
  // dihapus lalu applyRemoved auto-pindah ke sesi lain), JANGAN tempel riwayat basi ke chat-log
  // yang kini menampilkan sesi berbeda. Tanpa guard ini, menghapus sesi (yang memicu auto-pindah)
  // bisa "menyuntik" riwayat sesi lama/terhapus ke chat sesi aktif → chat tampak rusak lintas-sesi.
  if (activeId !== id) return
  sentPrompts = history.filter((m) => m.role === 'user').map((m) => m.text) // bahan riwayat ↑
  for (const m of history.slice(-MAX_CHAT_DOM)) {
    appendChatMessage(m, false) // hanya N terakhir → anti-lag
    logIngest(m, false) // bangun pohon LOG dari riwayat yang sama
  }
  log.scrollTop = log.scrollHeight
  scrollChatToBottom(true) // pindah sesi = mulai dari pesan terbaru + auto-scroll menyala lagi
  const lt = document.getElementById('log-tree')
  if (lt) lt.scrollTop = lt.scrollHeight
  updateActiveHighlight()
  renderMemories() // memori pohon sesi ini
}

function updateChatBadge(): void {
  const badge = $('chat-badge')
  const node = activeId ? nodes.get(activeId) : null
  if (!node) {
    badge.textContent = ''
    badge.className = 'badge'
    return
  }
  badge.textContent = `ctx ${ctxBadgeText(node)}`
  badge.className = ctxBadgeClass(node)
}

/** Isi <select> model Claude. `current` = nilai terpasang (bila id custom/lama → ditampilkan sbg opsi). */
function fillModelOptions(sel: HTMLSelectElement, inheritLabel?: string, current?: string): void {
  sel.textContent = ''
  for (const m of MODEL_OPTIONS) {
    const o = document.createElement('option')
    o.value = m.value
    // Untuk per-sesi, opsi kosong berarti "mewarisi", bukan "Default SDK" — beri tahu warisannya apa.
    o.textContent = m.value === '' && inheritLabel ? inheritLabel : m.label
    sel.append(o)
  }
  // Model terpasang yang TAK ada di daftar (mis. id lama yang diketik) → tampilkan agar terpilih benar.
  if (current && !MODEL_OPTIONS.some((m) => m.value === current)) {
    const o = document.createElement('option')
    o.value = current
    o.textContent = current
    sel.append(o)
  }
  // Escape hatch: ketik id model apa pun (versi lama, dsb) — backend menerima string apa pun.
  const cust = document.createElement('option')
  cust.value = CUSTOM_MODEL
  cust.textContent = '✎ Model lain…'
  sel.append(cust)
}

/** Minta id model dari user (untuk pilihan "✎ Model lain…"). null = batal; '' = kembali ke default. */
function promptCustomModel(current?: string | null): string | null {
  const seed = current && !MODEL_OPTIONS.some((m) => m.value === current) ? current : ''
  const v = prompt('ID model Claude (mis. claude-opus-4-6, claude-opus-4-7, atau alias opus/sonnet/haiku):', seed)
  return v == null ? null : v.trim()
}

/** Dropdown model GLOBAL di topbar → set nilai dari state. */
function syncGlobalModel(): void {
  const sel = $<HTMLSelectElement>('global-model')
  const onchange = (): void => {
    if (sel.value === CUSTOM_MODEL) {
      const m = promptCustomModel(defaultModel)
      sel.value = defaultModel ?? '' // pulihkan tampilan; re-render mengikuti hasil set
      if (m == null) return // batal
      void window.grove.setDefaultModel(m || null).catch((e) => alert(`Gagal set model global: ${String(e)}`))
      return
    }
    void window.grove.setDefaultModel(sel.value || null).catch((e) => alert(`Gagal set model global: ${String(e)}`))
  }
  sel.onchange = onchange
  fillModelOptions(sel, undefined, defaultModel ?? undefined)
  sel.value = defaultModel ?? ''
}

/** Isi <select> tingkat mikir. inheritLabel diisi untuk dropdown per-sesi (opsi '' = mewarisi). */
function fillEffortOptions(sel: HTMLSelectElement, inheritLabel?: string): void {
  sel.textContent = ''
  for (const e of EFFORT_OPTIONS) {
    const o = document.createElement('option')
    o.value = e.value
    o.textContent = e.value === '' && inheritLabel ? inheritLabel : e.label
    sel.append(o)
  }
}

/** Tingkat mikir EFEKTIF sebuah node bila ia mewarisi (label "ikut …"): node → root → global. */
function inheritedEffortFor(node: Node): string {
  const root = node.role === 'sub' ? nodes.get(node.treeId) : null
  const eff = root?.effort ?? defaultEffort ?? null
  return `🧠 ikut ${node.role === 'sub' ? 'sesi utama' : 'global'}: ${effortLabel(eff)}`
}

/** Dropdown tingkat mikir GLOBAL di topbar → set nilai dari state. */
function syncGlobalEffort(): void {
  const sel = $<HTMLSelectElement>('global-effort')
  fillEffortOptions(sel)
  sel.value = defaultEffort ?? ''
  sel.onchange = (): void => {
    void window.grove
      .setDefaultEffort((sel.value || null) as EffortSetting | null)
      .catch((e) => alert(`Gagal set tingkat mikir global: ${String(e)}`))
  }
}

/** Model EFEKTIF sebuah node bila ia mewarisi (untuk label "ikut …"): node → root → global. */
function inheritedModelFor(node: Node): string {
  const root = node.role === 'sub' ? nodes.get(node.treeId) : null
  const eff = (root?.model as string | undefined) ?? defaultModel ?? null
  const src = node.role === 'sub' ? 'sesi utama' : 'global'
  return `— ikut ${src}: ${modelLabel(eff)} —`
}

/** Nama pendek model OpenRouter untuk label ("nvidia/nemotron-3-super-…:free" → "nemotron-3-super…"). */
function orShort(id?: string): string {
  if (!id) return '?'
  return id.split('/').pop()!.replace(/:free$/, '')
}

/** Isi <select> model sesuai PROVIDER akun efektif: OpenRouter → daftar model OR; Claude → alias. */
function fillSessionModelSelect(sel: HTMLSelectElement, node: Node): void {
  sel.textContent = ''
  sel.disabled = false
  const eff = effectiveAccountOf(node)
  if (usesOwnBaseUrl(eff?.provider)) {
    // Akun custom/cursor (proxy): nama model ditentukan proxy → tampil sebagai info terkunci, bukan pilihan.
    const o = document.createElement('option')
    o.value = ''
    o.textContent = `model: ${eff!.model ?? '?'}`
    sel.append(o)
    sel.value = ''
    sel.disabled = true
    return
  }
  if (eff?.provider === 'dzax') {
    // Akun GATEWAY: daftar model diisi dari daftar milik akun (boleh beberapa, dipisah koma) DIGABUNG
    // dengan hasil GET <base>/models. Gabungan itu perlu karena gateway kadang melaporkan daftar yang
    // tak lengkap — Shiteru hanya mengembalikan 1 model padahal 4 lainnya sah dipakai key yang sama.
    const own = (eff.model ?? '').split(',').map((m) => m.trim()).filter(Boolean)
    const inherit = document.createElement('option')
    inherit.value = ''
    inherit.textContent = `— default akun: ${own[0] ?? '?'}${own.length > 1 ? ` (+${own.length - 1} cadangan)` : ''} —`
    sel.append(inherit)
    const fill = (ids: string[]): void => {
      for (const id of ids) {
        const o = document.createElement('option')
        o.value = id
        o.textContent = own.indexOf(id) === 0 ? `${id} · utama` : own.includes(id) ? `${id} · cadangan` : id
        sel.append(o)
      }
      const extra = document.createElement('option')
      extra.value = CUSTOM_MODEL
      extra.textContent = '✎ ketik model lain…'
      sel.append(extra)
      sel.value = node.model && ids.includes(node.model) ? node.model : ''
    }
    fill(own)
    // Segarkan dengan daftar live (async) tanpa menahan render.
    void window.grove
      .listGatewayModels(eff.id)
      .then((ids) => {
        if (!ids?.length || sel.dataset.acct !== eff.id) return
        const keep = sel.value
        sel.textContent = ''
        sel.append(inherit.cloneNode(true))
        fill(ids)
        if (keep) sel.value = keep
      })
      .catch(() => {})
    sel.dataset.acct = eff.id
    return
  }
  if (eff?.provider === 'deepseek') {
    // Akun DeepSeek: daftar model tertutup (pro/flash). Opsi kosong = pakai model default akun.
    const inherit = document.createElement('option')
    inherit.value = ''
    inherit.textContent = `— default akun: ${eff.model ?? DEEPSEEK_MODEL_DEFAULT} —`
    sel.append(inherit)
    for (const m of DEEPSEEK_MODEL_SUGGESTIONS) {
      const o = document.createElement('option')
      o.value = m.id
      o.textContent = m.label
      sel.append(o)
    }
    // Model warisan yang BUKAN DeepSeek (mis. alias "opus" dari global) tak sah di sini → tampil kosong.
    sel.value = isDeepSeekModel(node.model) ? node.model! : ''
    return
  }
  if (eff?.provider === 'openrouter') {
    // Akun OpenRouter: model BEBAS dipilih dari daftar OR. Opsi kosong = pakai model default akun.
    const inherit = document.createElement('option')
    inherit.value = ''
    inherit.textContent = `— default akun: ${orShort(eff.model)} —`
    sel.append(inherit)
    const list = orModels.length ? orModels : OPENROUTER_MODEL_SUGGESTIONS.map((m) => ({ id: m.id, name: m.label, paramB: '', context: 0, free: true }))
    for (const m of list) {
      const o = document.createElement('option')
      o.value = m.id
      const ctx = m.context >= 1e6 ? `${m.context / 1e6}M` : m.context ? `${Math.round(m.context / 1000)}K` : ''
      o.textContent = `${m.name}${m.paramB ? ` · ${m.paramB}` : ''}${ctx ? ` · ${ctx}` : ''}`
      sel.append(o)
    }
    // node.model dipakai hanya bila ia id OpenRouter (ber-"/"); kalau tidak → pakai default akun.
    sel.value = node.model && node.model.includes('/') ? node.model : ''
  } else {
    fillModelOptions(sel, inheritedModelFor(node), node.model ?? undefined)
    sel.value = node.model ?? ''
  }
}

function updateChatHeader(): void {
  const node = activeId ? nodes.get(activeId) : null
  $('chat-title').textContent = node ? `${node.title} · ${shortId(activeId!)}` : 'Belum ada session'
  updateChatBadge()
  const telem = $('chat-telem')
  const stopBtn = $('btn-stop')
  const compactBtn = $('btn-compact')
  const loopBtn = $('btn-loop')
  const liteBtn = $<HTMLButtonElement>('btn-lite')
  const modelSel = $<HTMLSelectElement>('chat-model')
  const effortSel = $<HTMLSelectElement>('chat-effort')
  if (node) {
    const act = activities.get(activeId!) || node.status
    const elapsed = fmtDuration(lastElapsed.get(activeId!) ?? 0)
    telem.textContent = `⏱ ${elapsed} · ↓ ${fmtTokens(node.tokensTotal ?? 0)} tokens · ${act}`
    stopBtn.style.display = node.status === 'running' ? 'inline-block' : 'none'
    // Toggle mode (root only). Compact & Auto-check hanya relevan untuk orkestrator (ada worker/board)
    // → sembunyikan saat lite.
    liteBtn.style.display = node.role === 'root' ? 'inline-block' : 'none'
    liteBtn.classList.toggle('on', !node.lite) // "on" = mode orkestrator (penuh)
    liteBtn.textContent = node.lite ? '⚡ Chat' : '🌳 Orkestrator'
    compactBtn.style.display = node.role === 'root' && !node.lite ? 'inline-block' : 'none' // hanya UTAMA orkestrator
    loopBtn.style.display = node.role === 'root' && !node.lite ? 'inline-block' : 'none' // hanya UTAMA orkestrator
    loopBtn.classList.toggle('on', !!node.loopActive)
    loopBtn.textContent = node.loopActive ? '🔁 Auto ON' : '🔁 Auto'
    // Dropdown model per-sesi, PROVIDER-AWARE: akun OpenRouter → daftar model OR (bisa dipilih bebas),
    // akun Claude → alias + warisan. Opsi kosong = ikut warisan / default akun.
    modelSel.style.display = 'inline-block'
    fillSessionModelSelect(modelSel, node)
    // Tingkat mikir per-sesi — satu dropdown di sebelah model, berlaku untuk Claude & DeepSeek.
    effortSel.style.display = 'inline-block'
    fillEffortOptions(effortSel, inheritedEffortFor(node))
    effortSel.value = node.effort ?? ''
    effortSel.onchange = (): void => {
      void window.grove
        .setSessionEffort(node.id, (effortSel.value || null) as EffortSetting | null)
        .catch((e) => alert(`Gagal ganti tingkat mikir: ${String(e)}`))
    }
    modelSel.onchange = (): void => {
      if (modelSel.value === CUSTOM_MODEL) {
        const m = promptCustomModel(node.model)
        modelSel.value = node.model ?? '' // pulihkan; re-render mengikuti hasil set
        if (m == null) return
        void window.grove.setSessionModel(node.id, m || null).catch((e) => alert(`Gagal ganti model: ${String(e)}`))
        return
      }
      void window.grove
        .setSessionModel(node.id, modelSel.value || null)
        .catch((e) => alert(`Gagal ganti model: ${String(e)}`))
    }
  } else {
    telem.textContent = ''
    stopBtn.style.display = 'none'
    compactBtn.style.display = 'none'
    loopBtn.style.display = 'none'
    liteBtn.style.display = 'none'
    modelSel.style.display = 'none'
    effortSel.style.display = 'none'
  }
}

function ensureNode(meta: SessionMeta, ctxPercent = 0): void {
  if (!nodes.has(meta.id)) {
    nodes.set(meta.id, { ...meta, ctxPercent, tokensTotal: 0 })
    renderTree()
  }
}

/**
 * Isi detail tool dengan PEWARNAAN diff: baris "- " merah (dibuang), "+ " hijau (ditambah),
 * "@@ … @@" aksen (penanda hunk), sisanya netral. Dipakai saat baris dibuka DAN saat output tool
 * menyusul (chat:detail) — satu jalur render supaya warnanya tak hilang setelah di-patch.
 */
function renderToolDetail(pre: HTMLElement, detail: string): void {
  pre.textContent = ''
  for (const line of detail.split('\n')) {
    const cls = line.startsWith('- ')
      ? 'd-del'
      : line.startsWith('+ ')
        ? 'd-add'
        : line.startsWith('@@')
          ? 'd-hunk'
          : line.startsWith('--- OUTPUT')
            ? 'd-out'
            : ''
    pre.append(el('span', cls ? { class: cls } : {}, `${line}\n`))
  }
}

/** Pratinjau saat baris tool BELUM diklik: beberapa baris yang benar-benar berubah saja. */
const PREVIEW_LINES = 6
function renderDiffPreview(pre: HTMLElement, detail: string): void {
  const changed = detail.split('\n').filter((l) => l.startsWith('- ') || l.startsWith('+ '))
  pre.textContent = ''
  if (!changed.length) {
    pre.hidden = true // tool non-edit (Read/Bash/…) → tak ada yang perlu dipratinjau
    return
  }
  for (const line of changed.slice(0, PREVIEW_LINES)) {
    pre.append(el('span', { class: line.startsWith('- ') ? 'd-del' : 'd-add' }, `${clip1(line, 160)}\n`))
  }
  if (changed.length > PREVIEW_LINES) {
    pre.append(el('span', { class: 'd-more' }, `… ${changed.length - PREVIEW_LINES} baris lagi — klik untuk lihat lengkap\n`))
  }
}

function appendChatMessage(m: ChatMessage, scroll = true): HTMLElement {
  const node = document.createElement('div')
  node.className = `msg ${m.role}`
  if (m.role === 'system' && m.text.startsWith('⟲')) {
    // Penanda reset konteks (recycle / compact) → garis pembatas jelas di chat.
    node.className = 'msg divider'
    node.append(
      el('span', { class: 'divider-line' }),
      el('span', { class: 'divider-label' }, m.text.replace(/^⟲\s*/, '')),
      el('span', { class: 'divider-line' })
    )
    $('chat-log').append(node)
    capChatLog()
    if (scroll) scrollChatToBottom()
    return node
  }
  if (m.role === 'assistant') {
    node.innerHTML = renderMarkdown(m.text)
  } else if (m.role === 'tool' && m.detail) {
    // Baris tool: TERTUTUP → pratinjau ringkas baris yang diubah; DIKLIK → detail penuh (diff
    // berwarna + output tool). Ala Ctrl+O, tapi perubahan file langsung terbaca tanpa dibuka.
    const caret = el('span', { class: 'tool-caret' }, '▸')
    const head = el('div', { class: 'tool-head' }, caret, el('span', {}, ` ${m.text}`))
    const pre = document.createElement('pre')
    pre.className = 'tool-detail'
    pre.hidden = true
    renderToolDetail(pre, m.detail)
    const preview = document.createElement('pre')
    preview.className = 'tool-preview'
    renderDiffPreview(preview, m.detail)
    head.addEventListener('click', () => {
      pre.hidden = !pre.hidden
      preview.hidden = !pre.hidden ? true : !preview.textContent // tampil lagi hanya bila ada isinya
      caret.textContent = pre.hidden ? '▸' : '▾'
      if (!pre.hidden) scrollChatToBottom()
    })
    node.append(head, preview, pre)
    if (m.toolUseId) toolDetailEls.set(m.toolUseId, pre)
  } else {
    if (m.text) node.appendChild(document.createTextNode(m.text))
    for (const src of m.images ?? []) {
      const img = document.createElement('img')
      img.className = 'msg-img'
      img.src = src
      node.appendChild(img)
    }
  }
  $('chat-log').append(node)
  capChatLog()
  if (scroll) scrollChatToBottom()
  return node
}

// ---- panel LOG (pohon per-turn) --------------------------------------------

/** Ringkas jadi satu baris, buang whitespace berlebih, potong ke n char. */
function clip1(s: string, n: number): string {
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function updateLogHint(): void {
  const hint = document.getElementById('log-hint')
  if (hint) hint.textContent = logTurns.length ? `${logTurns.length} prompt` : 'belum ada'
}

/** Kosongkan pohon LOG (pindah sesi / sesi dihapus / chat baru). */
function logReset(): void {
  logTurns.length = 0
  chatCallSeq = 0
  const t = document.getElementById('log-tree')
  if (t) t.textContent = ''
  updateLogHint()
}

/** Format byte → "820 B" / "1.4 KB" / "2.3 MB" (ukuran nyata yang dikirim/diterima). */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}
/** Auto-scroll ke dasar HANYA bila sudah dekat dasar → jangan rebut scroll user yang lagi baca atas. */
function scrollLogToBottom(): void {
  const t = document.getElementById('log-tree')
  if (!t || logCollapsed) return
  if (t.scrollHeight - t.scrollTop - t.clientHeight < 60) t.scrollTop = t.scrollHeight
}

/** Node anak expandable (request/respons/tool) — tiru pola baris tool di chat. bytesEl bisa di-update. */
function makeLogChild(
  label: string,
  detail: string,
  labelCls: string,
  bytes?: number
): { row: HTMLElement; pre: HTMLElement; bytesEl: HTMLElement } {
  const caret = el('span', { class: 'log-caret2' }, '▸')
  const bytesEl = el('span', { class: 'log-bytes' }, bytes == null ? '' : ` · ${fmtBytes(bytes)}`)
  const head = el('div', { class: 'log-child-head' }, caret, el('span', { class: labelCls }, label), bytesEl)
  const pre = document.createElement('pre')
  pre.className = 'log-child-detail'
  pre.hidden = true
  pre.textContent = detail
  head.addEventListener('click', () => {
    pre.hidden = !pre.hidden
    caret.textContent = pre.hidden ? '▸' : '▾'
    if (!pre.hidden) scrollLogToBottom()
  })
  const row = el('div', { class: 'log-child' }, head, pre)
  return { row, pre, bytesEl }
}

/** Mulai node turn baru (prompt user = header level-atas collapsible). */
function logStartTurn(text: string, ts: number): LogTurn {
  const caret = el('span', { class: 'log-caret2' }, '▾')
  const usageEl = el('span', { class: 'log-turn-usage' }) // diisi logAddCallUsage saat call API tercatat
  const meta = el('span', { class: 'log-turn-meta' }, usageEl, el('span', { class: 'log-turn-time' }, fmtClock(ts)))
  const head = el(
    'div',
    { class: 'log-turn-head' },
    caret,
    el('span', { class: 'log-turn-label' }, `❯ ${clip1(text, 90) || '(prompt kosong)'}`),
    meta
  )
  const body = el('div', { class: 'log-turn-body' })
  const wrap = el('div', { class: 'log-turn' }, head, body)
  head.addEventListener('click', () => {
    body.hidden = !body.hidden
    caret.textContent = body.hidden ? '▸' : '▾'
  })
  const turn: LogTurn = { wrap, caret, body, meta, usageEl, children: [], done: false, calls: 0, outSum: 0, ctxMax: 0 }
  ;(document.getElementById('log-tree') as HTMLElement).append(wrap)
  logTurns.push(turn)
  // cap: buang turn tertua bila melewati batas (lepas juga ref detail tool-nya).
  while (logTurns.length > MAX_LOG_TURNS) logTurns.shift()!.wrap.remove()
  updateLogHint()
  return turn
}

/** Turn berjalan; buat turn implisit bila anak datang tanpa header prompt (mis. riwayat mulai di tengah). */
function currentTurn(ts: number): LogTurn {
  return logTurns.length ? logTurns[logTurns.length - 1] : logStartTurn('(tanpa prompt)', ts)
}

/**
 * Serap ChatMessage ke panel LOG. SENGAJA hanya pesan USER — itu membuka node turn baru sebagai
 * wadah REQUEST-nya. Respons/tool/system TIDAK lagi disalin ke sini: semuanya sudah tampil utuh
 * (beserta detail expandable) di chat, dan menampilkannya dua kali cuma bikin panel ini jadi
 * cermin yang harus dibaca bolak-balik.
 */
function logIngest(m: ChatMessage, live = true): void {
  if (m.role !== 'user') return
  logStartTurn(m.text, m.ts)
  chatCallSeq = 0 // giliran baru → penomoran call di chat mulai lagi dari 1
  if (live) scrollLogToBottom()
}

/** Node "REQUEST": teks mentah yang Grove kirim ke query() (prompt+reseed / auto-task / recycle). */
function logAddRequest(kind: 'user' | 'auto' | 'recycle', text: string, bytes: number, images: number): void {
  // kind 'user' → tempel ke turn yang barusan dibuat pesan user; 'auto'/'recycle' TAK direkam ke chat
  // sehingga tak ada turn induk → buat node turn sintetis agar aktivitas tersembunyi ini terlihat.
  const turn =
    kind === 'user'
      ? currentTurn(Date.now())
      : logStartTurn(kind === 'recycle' ? '♻ recycle (Grove auto)' : '⚙ auto-task (Grove)', Date.now())
  const imgNote = images ? ` · ${images} gambar` : ''
  const { row } = makeLogChild(`→ REQUEST${imgNote}`, text, 'log-req', bytes)
  row.title =
    'Teks yang Grove kirim ke query() tiap giliran (prompt user + reseed konteks + auto-task). ' +
    'BUKAN body HTTP byte-exact: system prompt, seluruh transcript, & skema tools dirakit di subprocess ' +
    'SDK dan tak ter-expose ke JS. Untuk byte-exact, log lewat proxy (akun base-URL sendiri).'
  turn.body.prepend(row) // REQUEST paling atas di badan turn
  turn.children.push({})
  scrollLogToBottom()
}

/**
 * Rincian token SATU respons API (call). Barisnya ditaruh INLINE DI CHAT — persis di tempat kejadian,
 * jadi mahal/tidaknya sebuah langkah terbaca tanpa pindah panel. Panel LOG hanya menyimpan ringkasan
 * per-turn di headernya (n× call · Σout · ctx▲).
 *
 * Arti angkanya: ctx = seluruh input yang diproses call ini (fresh+cache) · fresh = bagian yang
 * ditagih harga penuh (cache miss) · cache = konteks lama yang dibaca-ulang (murah) · out = keluaran.
 */
function logAddCallUsage(u: { input: number; cacheRead: number; cacheCreation: number; output: number }): void {
  const ctxIn = u.input + u.cacheRead + u.cacheCreation
  const cache = u.cacheRead + u.cacheCreation
  chatCallSeq += 1
  const turn = logTurns[logTurns.length - 1]
  if (turn) {
    turn.calls += 1
    turn.outSum += u.output
    turn.ctxMax = Math.max(turn.ctxMax, ctxIn)
    turn.usageEl.textContent = `${turn.calls}× · out ${fmtTokens(turn.outSum)} · ctx▲${fmtTokens(turn.ctxMax)} · `
  }
  const row = el(
    'div',
    {
      class: 'msg meter',
      title:
        `call ${chatCallSeq} giliran ini\n` +
        `ctx ${ctxIn.toLocaleString()} = fresh ${u.input.toLocaleString()} + cache ${cache.toLocaleString()} token\n` +
        `fresh = ditagih penuh (cache miss) · cache = konteks dibaca-ulang, jauh lebih murah\n` +
        `output ${u.output.toLocaleString()} token`
    },
    `↳ call ${chatCallSeq} · ctx ${fmtTokens(ctxIn)} · fresh ${fmtTokens(u.input)}` +
      (cache ? ` · cache ${fmtTokens(cache)}` : '') +
      ` · out ${fmtTokens(u.output)}`
  )
  $('chat-log').append(row)
  capChatLog()
  scrollChatToBottom()
}

/** Tandai turn terakhir "selesai" saat sesi aktif kembali idle/done (penanda akhir-turn). */
function logMarkTurnDone(): void {
  const turn = logTurns[logTurns.length - 1]
  if (!turn || turn.done) return
  turn.done = true
  turn.meta.prepend(el('span', { class: 'log-done' }, '✓ '))
}

// ---- antrian pesan + riwayat prompt (↑/↓ di kolom chat) --------------------------------------
// queueItems  = pesan yang DITAHAN Grove karena turn masih jalan (belum dikirim ke model).
// sentPrompts = prompt yang SUDAH terkirim (dari riwayat chat) — ini yang jadi bahan ↑ "prompt baru".
// editingQid  = sedang mengedit item antrian nomor ini (Enter menyimpan ke antrian, bukan mengirim baru).
let queueItems: Array<{ qid: number; text: string }> = []
let sentPrompts: string[] = []
let histIdx = -1 // -1 = tidak sedang menelusuri riwayat
let histDraft = '' // teks yang sedang diketik sebelum menelusuri, dipulihkan saat kembali ke bawah
let editingQid: number | null = null

/**
 * MUATAN pesan yang sudah dikirim dari UI — teks asli (tanpa blok referensi) + lampirannya.
 * Chat & antrian hanya menyimpan TEKS, jadi tanpa catatan ini "batalkan pesan terakhir" mustahil
 * mengembalikan gambar & referensinya. Disimpan per sesi, dibatasi beberapa terakhir saja.
 */
interface SentPayload {
  text: string // yang diketik user
  sent: string // yang benar-benar dikirim (refBlock + text) → untuk mencocokkan item antrian
  images: ImageAttachment[]
  refs: string[]
}
const sentPayloads = new Map<string, SentPayload[]>()
const MAX_SENT_PAYLOADS = 8

function rememberSent(sessionId: string, p: SentPayload): void {
  const list = sentPayloads.get(sessionId) ?? []
  list.push(p)
  while (list.length > MAX_SENT_PAYLOADS) list.shift()
  sentPayloads.set(sessionId, list)
}

/** Ambil (dan buang) muatan terakhir yang cocok teksnya; null bila tak ada catatannya. */
function takeSentPayload(sessionId: string, sentText?: string): SentPayload | null {
  const list = sentPayloads.get(sessionId)
  if (!list?.length) return null
  const idx = sentText ? list.map((p) => p.sent).lastIndexOf(sentText) : list.length - 1
  if (idx < 0) return null
  const [p] = list.splice(idx, 1)
  return p ?? null
}

/** Kembalikan sebuah pesan ke kolom ketik: teks, gambar, dan referensinya sekaligus. */
function restoreToComposer(p: { text: string; images?: ImageAttachment[]; refs?: string[] }): void {
  const input = $<HTMLTextAreaElement>('chat-input')
  input.value = p.text
  pendingImages = p.images ? [...p.images] : []
  pendingRefs = p.refs ? [...p.refs] : []
  renderAttachStrip()
  autoGrow(input)
  resetHistoryNav()
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

/**
 * ESC — BATALKAN PESAN TERAKHIR, kembalikan utuh ke kolom ketik (meniru perilaku claude.ai).
 *
 * Dua keadaan, dua akibat yang berbeda — dan bedanya dikatakan apa adanya:
 *  1. Pesan masih ANTRI di Grove (turn sedang jalan) → benar-benar dibatalkan sebelum sampai ke
 *     model: tak ada token terpakai, tak ada jejak di konteks.
 *  2. Pesan SUDAH terkirim (sedang dikerjakan) → turn dihentikan, teksnya dikembalikan ke kolom
 *     ketik, TAPI pesan itu sudah masuk konteks model dan tokennya sudah tertagih. Itu batas yang
 *     tak bisa dilewati siapa pun, jadi jangan berpura-pura "batal total".
 */
async function cancelLastMessage(sessionId: string): Promise<void> {
  const last = queueItems[queueItems.length - 1]
  if (last) {
    const ok = await window.grove.cancelQueued(sessionId, last.qid).catch(() => false)
    if (ok) {
      const p = takeSentPayload(sessionId, last.text)
      restoreToComposer(p ?? { text: last.text })
      appendChatMessage({
        role: 'system',
        text: '↩︎ Pesan terakhir dibatalkan sebelum terkirim ke model — dikembalikan ke kolom ketik.',
        ts: Date.now()
      })
      return
    }
    // Sudah terlanjur terkirim di sela-sela → jatuh ke jalur 2.
  }
  const node = nodes.get(sessionId)
  if (node?.status !== 'running') return // tak ada yang bisa dibatalkan → Esc diam saja
  await window.grove.interruptSession(sessionId).catch(() => {})
  const p = takeSentPayload(sessionId)
  if (p) restoreToComposer(p)
  appendChatMessage({
    role: 'system',
    text: p
      ? '⏹ Turn dihentikan; pesan terakhir dikembalikan ke kolom ketik (gambar & referensi ikut). Catatan: pesan itu sudah sempat masuk konteks model, jadi tokennya tetap tertagih.'
      : '⏹ Turn dihentikan.',
    ts: Date.now()
  })
}

/** Daftar yang ditelusuri ↑: antrian dulu (paling dekat & masih bisa diubah), lalu prompt terkirim. */
function historyEntries(): Array<{ text: string; qid: number | null }> {
  return [
    ...[...queueItems].reverse().map((q) => ({ text: q.text, qid: q.qid })),
    ...[...sentPrompts].reverse().map((t) => ({ text: t, qid: null }))
  ]
}

function setEditingQid(qid: number | null): void {
  editingQid = qid
  const form = document.getElementById('chat-form')
  form?.classList.toggle('editing-queue', qid != null)
}

/** ↑/↓ menelusuri riwayat prompt. Item antrian → masuk mode EDIT ANTRIAN; sisanya → prompt baru. */
function navigateHistory(dir: 1 | -1): void {
  const input = $<HTMLTextAreaElement>('chat-input')
  const list = historyEntries()
  if (!list.length) return
  if (histIdx === -1 && dir === 1) histDraft = input.value // mulai menelusuri → simpan ketikan
  const next = histIdx + dir
  if (next < -1) return
  if (next >= list.length) return
  histIdx = next
  if (histIdx === -1) {
    input.value = histDraft
    setEditingQid(null)
  } else {
    const e = list[histIdx]
    input.value = e.text
    setEditingQid(e.qid) // qid null = prompt yang sudah dijawab → perlakukan sebagai prompt BARU
  }
  autoGrow(input)
  input.setSelectionRange(input.value.length, input.value.length)
}

/** Keluar dari mode telusur (mis. user mulai mengetik lagi / kirim). */
function resetHistoryNav(): void {
  histIdx = -1
  histDraft = ''
  setEditingQid(null)
}

function renderQueueStrip(): void {
  const strip = $('chat-queue')
  strip.textContent = ''
  strip.style.display = queueItems.length ? 'flex' : 'none'
  for (const q of queueItems) {
    const chip = el('div', { class: `queue-chip${editingQid === q.qid ? ' editing' : ''}` })
    chip.append(el('span', { class: 'queue-num' }, '⏳'), el('span', { class: 'queue-text' }, clip1(q.text, 90)))
    const edit = el('button', { class: 'queue-btn', title: 'Edit pesan ini (↑ juga bisa)' }, '✎')
    edit.addEventListener('click', () => {
      const input = $<HTMLTextAreaElement>('chat-input')
      histDraft = input.value
      input.value = q.text
      autoGrow(input)
      setEditingQid(q.qid)
      renderQueueStrip()
      input.focus()
    })
    const del = el('button', { class: 'queue-btn', title: 'Batalkan pesan ini' }, '✕')
    del.addEventListener('click', () => {
      if (!activeId) return
      void window.grove.cancelQueued(activeId, q.qid).then(() => {
        if (editingQid === q.qid) {
          setEditingQid(null)
          $<HTMLTextAreaElement>('chat-input').value = histDraft
        }
      })
    })
    chip.append(edit, del)
    strip.append(chip)
  }
}

function renderAttachStrip(): void {
  const strip = $('chat-attach')
  strip.textContent = ''
  strip.style.display = pendingImages.length || pendingRefs.length ? 'flex' : 'none'
  pendingImages.forEach((im, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'attach-item'
    const img = document.createElement('img')
    img.src = `data:${im.mediaType};base64,${im.data}`
    const rm = document.createElement('button')
    rm.className = 'attach-rm'
    rm.textContent = '×'
    rm.onclick = () => {
      pendingImages.splice(i, 1)
      renderAttachStrip()
    }
    wrap.append(img, rm)
    strip.append(wrap)
  })
  pendingRefs.forEach((p, i) => {
    const chip = document.createElement('div')
    chip.className = 'ref-chip'
    chip.title = p
    const name = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
    chip.append(document.createTextNode(`📎 ${name}`))
    const rm = document.createElement('button')
    rm.className = 'chip-rm'
    rm.textContent = '×'
    rm.onclick = () => {
      pendingRefs.splice(i, 1)
      renderAttachStrip()
    }
    chip.append(rm)
    strip.append(chip)
  })
}

/**
 * Tinggi textarea mengikuti isi. Sederhana dan — setelah pesan di luar layar tak lagi ikut di-layout
 * (content-visibility di styles.css) — juga MURAH: terukur 0,06 ms per ketikan pada 400 pesan.
 *
 * Dua alternatif sudah diuji dan LEBIH BURUK, jangan diulang:
 *  - `field-sizing: content` (CSS murni): tinggi jadi bergantung isi -> 44 ms/ketikan.
 *  - elemen bayangan + getComputedStyle: 7,4 ms/ketikan (biaya baca gaya & tulis style).
 */
const NATIVE_GROW = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content')
function autoGrow(el: HTMLTextAreaElement): void {
  if (NATIVE_GROW) return // tinggi diurus CSS field-sizing: nol layout paksa
  el.style.height = 'auto'
  el.style.height = `${Math.min(Math.max(el.scrollHeight, 84), 320)}px`
}




// ---- board & inbox ---------------------------------------------------------

function renderBoard(): void {
  const container = $('board')
  container.textContent = ''
  const entries = [...board.values()].filter((b) => nodes.has(b.sessionId))
  if (entries.length === 0) {
    container.append(el('div', { class: 'empty' }, 'Belum ada laporan.'))
    return
  }
  // urutan stabil by createdAt session (bukan updatedAt yang berubah terus → kebalik-balik)
  entries.sort(
    (a, b) => (nodes.get(a.sessionId)?.createdAt ?? 0) - (nodes.get(b.sessionId)?.createdAt ?? 0)
  )
  let focusCard: HTMLElement | null = null
  for (const b of entries) {
    const node = nodes.get(b.sessionId)!
    const card = el(
      'div',
      { class: `board-card${node.status === 'running' ? ' active-proc' : ''}` },
      el(
        'div',
        { class: 'bc-head' },
        el('span', { class: `dot s-${node.status}` }),
        el('span', { class: 'bc-title' }, `${node.title} · ${shortId(b.sessionId)}`)
      )
    )
    if (b.summary) card.append(el('div', { class: 'bc-sum' }, b.summary))
    if (typeof b.percent === 'number') {
      const pct = Math.max(0, Math.min(100, b.percent))
      const fill = el('span', { class: 'bc-bar-fill' })
      fill.style.width = `${pct}%`
      card.append(
        el('div', { class: 'bc-barrow' }, el('div', { class: 'bc-bar' }, fill), el('span', { class: 'bc-pct' }, `${pct}%`))
      )
    }
    if (b.progress) card.append(el('div', { class: 'bc-prog' }, `▸ ${b.progress}`))
    if (b.todo.length) {
      const ul = el('ul', { class: 'bc-todo' })
      for (const t of b.todo) ul.append(el('li', { class: t.done ? 'done' : '' }, t.text))
      card.append(ul)
    }
    container.append(card)
    // Target scroll = proses yang sedang jalan (prioritaskan sesi aktif yang running).
    if (node.status === 'running' && (!focusCard || b.sessionId === activeId)) focusCard = card
  }
  if (focusCard) focusCard.scrollIntoView({ block: 'nearest' }) // auto-scroll ke proses aktif
}

function addInbox(m: InboxMessage): void {
  const inbox = $('inbox')
  const to = m.to ? shortId(m.to) : 'ALL'
  const item = el(
    'div',
    { class: 'im' },
    el('span', { class: 'im-from' }, `${shortId(m.from)} → ${to}: `),
    m.body
  )
  inbox.prepend(item)
  inbox.scrollTop = 0 // pesan terbaru (di atas) selalu terlihat
}

/** Panel MEMORI: hasil compact untuk pohon sesi aktif (terbaru di atas, klik untuk expand). */
function renderMemories(): void {
  const box = $('memories')
  box.textContent = ''
  const tree = activeId ? nodes.get(activeId)?.treeId : null
  const list = memories.filter((m) => !tree || m.treeId === tree).sort((a, b) => b.createdAt - a.createdAt)
  if (!list.length) {
    box.append(el('div', { class: 'mem-empty' }, tree ? 'Belum ada memori. Klik 🗜 Compact di UTAMA.' : '—'))
    return
  }
  for (const m of list) {
    const caret = el('span', { class: 'tool-caret' }, '▸')
    const head = el('div', { class: 'mem-head' }, caret, el('span', {}, ` 🧠 ${new Date(m.createdAt).toLocaleString()}`))
    const pre = document.createElement('pre')
    pre.className = 'mem-body'
    pre.hidden = true
    pre.textContent = m.content
    head.addEventListener('click', () => {
      pre.hidden = !pre.hidden
      caret.textContent = pre.hidden ? '▸' : '▾'
    })
    box.append(el('div', { class: 'mem-card' }, head, pre))
  }
}

/**
 * Banner "belum ada akun yang dipakai". SENGAJA non-blocking: Grove tetap bisa dipakai (kelola akun,
 * baca riwayat, pilih akun) — yang berhenti hanya sesi yang tak punya token. Tombolnya membuka
 * panel ⚙ Akun langsung supaya user tak perlu menebak harus ke mana.
 */
function showAuthBanner(p: { sessionTitle: string; tokenMissing: boolean; hasAccounts: boolean }): void {
  const b = $('auth-banner')
  b.textContent = ''
  const msg = p.tokenMissing
    ? `⛔ Sesi "${p.sessionTitle}" berhenti: akun yang dipilih tidak punya token. Tambahkan ulang tokennya.`
    : p.hasAccounts
      ? `⚠️ Sesi "${p.sessionTitle}" belum dipasangi akun. Pilih salah satu akun agar bisa jalan.`
      : `⚠️ Belum ada akun Claude yang dipakai. Tambahkan token (CLAUDE_CODE_OAUTH_TOKEN) supaya sesi bisa jalan.`
  b.append(el('span', {}, msg))

  const open = el('button', {}, p.hasAccounts ? 'Pilih akun' : 'Tambah akun')
  open.addEventListener('click', (e) => {
    e.stopPropagation() // handler global menutup panel — jangan sampai dibuka lalu langsung ditutup
    $('acct-panel').classList.add('show')
    renderAccountsPanel()
  })
  const close = el('button', { class: 'ab-x', title: 'Sembunyikan' }, '×')
  close.addEventListener('click', hideAuthBanner)
  b.append(open, close)
  b.hidden = false
}

function hideAuthBanner(): void {
  $('auth-banner').hidden = true
}

// ---- context menu per-sesi (klik-kanan kartu): ganti akun & model -----------

let ctxMenuEl: HTMLElement | null = null

function closeSessionMenu(): void {
  ctxMenuEl?.remove()
  ctxMenuEl = null
}

// ---- referensi antar-sesi (cache renderer; sumber kebenaran ada di main/DB) -------------------
const refsByHelper = new Map<string, Array<{ id: string; title: string; status: string; cwd: string }>>()

function referencesOf(helperId: string): Array<{ id: string; title: string; status: string; cwd: string }> {
  return refsByHelper.get(helperId) ?? []
}

async function refreshReferences(helperId: string): Promise<void> {
  try {
    refsByHelper.set(helperId, await window.grove.listReferences(helperId))
  } catch {
    /* sesi baru dihapus → abaikan */
  }
}

/** Terima teks "grove:ref:<id>" (atau id polos) → tautkan sebagai referensi milik `helperId`. */
function linkReferenceFromText(helperId: string, raw: string): void {
  const m = /^(?:grove:ref:)?\s*([0-9a-fA-F-]{6,})\s*$/.exec(raw.trim())
  if (!m) {
    appendChatMessage({
      role: 'system',
      text: '⚠️ Clipboard tak berisi ID referensi. Klik-kanan chat sumber → "Salin ID referensi sesi ini" dulu.',
      ts: Date.now()
    })
    return
  }
  const targetId = nodes.has(m[1]) ? m[1] : [...nodes.keys()].find((id) => id.startsWith(m[1]))
  if (!targetId) {
    appendChatMessage({ role: 'system', text: `⚠️ Sesi ${m[1]} tidak ditemukan.`, ts: Date.now() })
    return
  }
  void window.grove
    .linkReference(helperId, targetId)
    .then(() => refreshReferences(helperId))
    .catch((e) => appendChatMessage({ role: 'system', text: `⚠️ Gagal menautkan: ${String(e)}`, ts: Date.now() }))
}

/** Akun EFEKTIF sebuah node dari sisi renderer: akun sesi → akun sesi utama → akun global. */
function effectiveAccountOf(node: Node): Account | undefined {
  const rootAcc = node.role === 'sub' ? nodes.get(node.treeId)?.accountId : undefined
  const id = node.accountId ?? rootAcc ?? defaultAccountId ?? null
  return id ? accounts.find((a) => a.id === id) : undefined
}

/**
 * Menu klik-kanan: pilih akun & model KHUSUS sesi ini (per-chat). Sub-sesi mewarisi dari sesi utama;
 * memilih "ikut warisan" mengembalikannya ke warisan. Untuk akun OpenRouter, model dikunci oleh akun
 * itu (alias Claude tak berlaku) → ditampilkan sebagai info, bukan pilihan.
 */
function showSessionMenu(node: Node, x: number, y: number): void {
  closeSessionMenu()
  const menu = el('div', { class: 'ctx-menu' })

  const item = (label: string, on: boolean, onClick: () => void, cls = ''): HTMLElement => {
    const it = el('div', { class: `ctx-item${on ? ' on' : ''}${cls ? ' ' + cls : ''}` }, label)
    it.addEventListener('click', (e) => {
      e.stopPropagation()
      closeSessionMenu()
      onClick()
    })
    return it
  }

  menu.append(el('div', { class: 'ctx-head' }, `${node.role === 'root' ? 'UTAMA' : 'SUB'} · ${node.title}`))

  // --- Sub-worker manual --- jalur yang bisa DITEMUKAN untuk aksi klik-3× pada kartu.
  menu.append(el('div', { class: 'ctx-sep' }, 'Worker'))
  menu.append(item('➕ Sub-worker baru (atau klik 3× kartu)', false, () => void createWorkerUnder(node.id)))

  // --- Akun ---
  menu.append(el('div', { class: 'ctx-sep' }, 'Akun'))
  const inheritAccLabel =
    node.role === 'sub'
      ? `— ikut sesi utama —`
      : defaultAccountId
        ? `— ikut global: ${accounts.find((a) => a.id === defaultAccountId)?.label ?? '?'} —`
        : '— ikut global (kosong) —'
  menu.append(item(inheritAccLabel, node.accountId == null, () => setSessionAccount(node.id, null)))
  for (const a of accounts) {
    const tag =
      a.provider === 'custom'
        ? '  ⟨GM⟩'
        : a.provider === 'cursor'
          ? '  ⟨CR⟩'
          : a.provider === 'openrouter'
            ? '  ⟨OR⟩'
            : a.provider === 'deepseek'
              ? '  ⟨DS⟩'
              : a.provider === 'dzax'
                ? '  ⟨OAI⟩'
                : ''
    menu.append(item(a.label + tag, node.accountId === a.id, () => setSessionAccount(node.id, a.id)))
  }

  // --- Referensi (satu arah) --- salin ID sesi ini, atau jadikan sesi lain referensi sesi ini.
  menu.append(el('div', { class: 'ctx-sep' }, 'Referensi'))
  menu.append(
    item('📋 Salin ID referensi sesi ini', false, () => {
      void navigator.clipboard
        .writeText(`grove:ref:${node.id}`)
        .then(() =>
          appendChatMessage({
            role: 'system',
            text: `📋 ID referensi "${node.title}" disalin. Buka chat lain → klik-kanan → "Tempel referensi", atau tempel langsung ke kolom chat-nya.`,
            ts: Date.now()
          })
        )
        .catch(() => {})
    })
  )
  menu.append(
    item('🔗 Tempel referensi dari clipboard', false, () => {
      void navigator.clipboard
        .readText()
        .then((t) => linkReferenceFromText(node.id, t))
        .catch(() => alert('Clipboard tak bisa dibaca.'))
    })
  )
  for (const r of referencesOf(node.id)) {
    menu.append(
      item(`✕ lepas: ${r.title} (${r.id.slice(0, 6)})`, false, () => {
        void window.grove.unlinkReference(node.id, r.id).then(() => void refreshReferences(node.id))
      })
    )
  }

  // --- Tingkat mikir (reasoning) --- berlaku untuk Claude & DeepSeek.
  menu.append(el('div', { class: 'ctx-sep' }, 'Mikir'))
  menu.append(
    item(
      node.role === 'sub' ? '— ikut sesi utama —' : `— ikut global: ${effortLabel(defaultEffort)} —`,
      node.effort == null,
      () => setSessionEffort(node.id, null)
    )
  )
  for (const e of EFFORT_OPTIONS) {
    if (e.value === '') continue // '' sudah diwakili "ikut warisan" di atas
    menu.append(item(e.label, node.effort === e.value, () => setSessionEffort(node.id, e.value as EffortSetting)))
  }

  // --- Model ---
  menu.append(el('div', { class: 'ctx-sep' }, 'Model'))
  const eff = effectiveAccountOf(node)
  if (usesOwnBaseUrl(eff?.provider)) {
    // Akun custom/cursor: model dikunci oleh proxy → info saja (ganti model = ganti akun / edit proxy).
    menu.append(item(`model akun: ${eff!.model ?? '?'} · dikunci proxy`, true, () => {}))
  } else if (eff?.provider === 'deepseek') {
    // Akun DeepSeek: pilih di antara pro/flash. Kosong = model default akun.
    const selfDs = isDeepSeekModel(node.model) ? node.model! : null
    menu.append(
      item(`— default akun: ${eff.model ?? DEEPSEEK_MODEL_DEFAULT} —`, selfDs == null, () =>
        setSessionModel(node.id, null)
      )
    )
    for (const m of DEEPSEEK_MODEL_SUGGESTIONS) {
      menu.append(item(m.label, selfDs === m.id, () => setSessionModel(node.id, m.id)))
    }
  } else if (eff?.provider === 'dzax') {
    // Akun GATEWAY: pilihan model = daftar milik akun (kandidat, dipisah koma) + hasil GET
    // <base>/models. Opsi AUTO = tak mengunci apa pun: Grove memakai kandidat pertama dan PINDAH
    // SENDIRI ke kandidat berikutnya kalau gateway menolak (kuota model habis / tak diizinkan).
    const own = (eff.model ?? '').split(',').map((m) => m.trim()).filter(Boolean)
    const auto = node.model == null
    menu.append(
      item(
        `🔀 Auto — pakai ${own[0] ?? '?'}${own.length > 1 ? `, pindah sendiri kalau ditolak (+${own.length - 1} cadangan)` : ''}`,
        auto,
        () => setSessionModel(node.id, null)
      )
    )
    const addModelItem = (id: string): void => {
      const tag = own.indexOf(id) === 0 ? ' · utama' : own.includes(id) ? ' · cadangan' : ''
      menu.append(item(`kunci ke ${id}${tag}`, node.model === id, () => setSessionModel(node.id, id)))
    }
    for (const id of own) addModelItem(id)
    if (node.model && !own.includes(node.model)) addModelItem(node.model)
    menu.append(
      item('✎ Model lain…', false, () => {
        const m = promptCustomModel(node.model)
        if (m != null) setSessionModel(node.id, m || null)
      })
    )
  } else if (eff?.provider === 'openrouter') {
    // Akun OpenRouter: model BEBAS dipilih dari daftar OR (tak dikunci). Kosong = default akun.
    const selfOr = node.model && node.model.includes('/') ? node.model : null
    menu.append(item(`— default akun: ${orShort(eff.model)} —`, selfOr == null, () => setSessionModel(node.id, null)))
    const list = orModels.length ? orModels : OPENROUTER_MODEL_SUGGESTIONS.map((m) => ({ id: m.id, name: m.label, paramB: '', context: 0, free: true }))
    for (const m of list) {
      const ctx = m.context >= 1e6 ? `${m.context / 1e6}M` : m.context ? `${Math.round(m.context / 1000)}K` : ''
      const lbl = `${orShort(m.id)}${m.paramB ? ` · ${m.paramB}` : ''}${ctx ? ` · ${ctx}` : ''}`
      menu.append(item(lbl, selfOr === m.id, () => setSessionModel(node.id, m.id)))
    }
  } else {
    const inheritModelLabel =
      node.role === 'sub' ? `— ikut sesi utama —` : `— ikut global: ${modelLabel(defaultModel)} —`
    menu.append(item(inheritModelLabel, node.model == null, () => setSessionModel(node.id, null)))
    for (const m of MODEL_OPTIONS) {
      if (m.value === '') continue // '' sudah diwakili "ikut warisan" di atas
      menu.append(item(m.label, node.model === m.value, () => setSessionModel(node.id, m.value)))
    }
    // Model terpasang yang tak ada di daftar (id lama custom) → tampilkan sebagai terpilih.
    if (node.model && !MODEL_OPTIONS.some((m) => m.value === node.model)) {
      menu.append(item(node.model, true, () => {}, 'ctx-info'))
    }
    menu.append(
      item('✎ Model lain…', false, () => {
        const m = promptCustomModel(node.model)
        if (m != null) setSessionModel(node.id, m || null)
      })
    )
  }

  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  document.body.append(menu)
  ctxMenuEl = menu
  // Jaga menu tetap di dalam viewport (klik dekat tepi kanan/bawah).
  const r = menu.getBoundingClientRect()
  if (r.right > innerWidth) menu.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`
  if (r.bottom > innerHeight) menu.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`
}

/** Helper renderer → main untuk set akun/model sesi, dengan penutupan banner bila relevan. */
function setSessionAccount(id: string, accountId: string | null): void {
  void window.grove
    .setSessionAccount(id, accountId)
    .then(() => {
      if (accountId || defaultAccountId) hideAuthBanner()
    })
    .catch((e) => alert(`Gagal ganti akun: ${String(e)}`))
}
function setSessionModel(id: string, model: string | null): void {
  void window.grove.setSessionModel(id, model).catch((e) => alert(`Gagal ganti model: ${String(e)}`))
}

function setSessionEffort(id: string, effort: EffortSetting | null): void {
  void window.grove.setSessionEffort(id, effort).catch((e) => alert(`Gagal ganti tingkat mikir: ${String(e)}`))
}

// ---- kolom yang bisa di-resize (lebar sidebar & board, disimpan di localStorage) --------------

/**
 * Splitter antar-kolom: geser untuk atur lebar sidebar & papan; chat mengisi sisa. Lebar disimpan
 * ke localStorage → dipulihkan saat buka lagi (dobel-klik splitter = reset ke default).
 */
function setupColumnResizers(): void {
  const root = document.documentElement
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  const px = (name: string): number => parseInt(getComputedStyle(root).getPropertyValue(name)) || 0

  // Pulihkan lebar tersimpan SEBELUM interaksi → layout langsung benar saat buka.
  const restore = (key: string, varName: string, lo: number, hi: number): void => {
    const v = Number(localStorage.getItem(key))
    if (Number.isFinite(v) && v > 0) root.style.setProperty(varName, clamp(v, lo, hi) + 'px')
  }
  restore('grove.wSide', '--w-side', 180, 600)
  restore('grove.wBoard', '--w-board', 200, 700)

  const wire = (
    el: HTMLElement,
    opts: { varName: string; key: string; min: number; max: number; def: number; sign: 1 | -1 }
  ): void => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      el.setPointerCapture(e.pointerId)
      el.classList.add('dragging')
      const startX = e.clientX
      const startW = px(opts.varName)
      const move = (ev: PointerEvent): void => {
        const w = clamp(startW + opts.sign * (ev.clientX - startX), opts.min, opts.max)
        root.style.setProperty(opts.varName, w + 'px')
      }
      const up = (): void => {
        el.classList.remove('dragging')
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        localStorage.setItem(opts.key, String(px(opts.varName))) // persist lebar final
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    })
    // Dobel-klik = reset ke default.
    el.addEventListener('dblclick', () => {
      root.style.setProperty(opts.varName, opts.def + 'px')
      localStorage.removeItem(opts.key)
    })
  }

  // Sidebar di KIRI: geser kanan → makin lebar (sign +1).
  wire($('resize-left'), { varName: '--w-side', key: 'grove.wSide', min: 180, max: 600, def: 300, sign: 1 })
  // Board di KANAN: geser kiri → makin lebar (sign -1).
  wire($('resize-right'), { varName: '--w-board', key: 'grove.wBoard', min: 200, max: 700, def: 320, sign: -1 })
}

/** Panel kelola akun: auto-switch, daftar akun, tambah (token setup-token), akun sesi aktif. */
function renderAccountsPanel(): void {
  const panel = $('acct-panel')
  panel.textContent = ''
  panel.append(el('div', { class: 'ap-title' }, 'AKUN CLAUDE'))

  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = autoSwitch
  cb.addEventListener('change', () => {
    autoSwitch = cb.checked // simpan lokal langsung → tetap kecentang saat panel dibuka ulang
    void window.grove.setAutoSwitch(cb.checked).catch(() => {})
  })
  panel.append(el('label', { class: 'ap-toggle' }, cb, el('span', {}, ' Auto-switch akun saat kena limit')))

  const cr = document.createElement('input')
  cr.type = 'checkbox'
  cr.checked = autoResume
  cr.addEventListener('change', () => {
    autoResume = cr.checked // simpan lokal langsung
    void window.grove.setAutoResume(cr.checked).catch(() => {})
  })
  panel.append(el('label', { class: 'ap-toggle' }, cr, el('span', {}, ' Lanjutkan sesi yang tadi kerja saat app dibuka')))

  // Ambang default (dipakai akun yang tak menyetel sendiri).
  const dPct = document.createElement('input')
  dPct.type = 'number'
  dPct.className = 'ap-pct'
  dPct.min = '50'
  dPct.max = '99'
  dPct.value = String(defaultSwitchPct)
  const commitDefault = (): void => {
    const v = Number(dPct.value)
    if (!Number.isFinite(v)) return
    defaultSwitchPct = Math.min(99, Math.max(50, Math.round(v)))
    dPct.value = String(defaultSwitchPct) // pantulkan hasil clamp balik ke UI, jangan biarkan bohong
    void window.grove.setDefaultSwitchPct(defaultSwitchPct).catch(() => {})
  }
  dPct.addEventListener('change', commitDefault)
  panel.append(el('div', { class: 'ap-row' }, el('span', {}, 'Ambang pindah akun: '), dPct, el('span', {}, '%')))

  // Akun GLOBAL — dasar rantai: akun sesi → akun sesi utama → akun global.
  panel.append(el('div', { class: 'ap-head' }, 'Akun global (dipakai semua sesi)'))
  const gSel = document.createElement('select')
  gSel.className = 'ap-input'
  const gNone = document.createElement('option')
  gNone.value = ''
  gNone.textContent = '— tidak ada —'
  gSel.append(gNone)
  // OTOMATIS: akun dipilih sendiri menurut URUTAN PRIORITAS di daftar bawah (#1, #2, …), melewati
  // akun yang sedang kena limit. Jadi tak perlu menunjuk satu akun tetap.
  const gAuto = document.createElement('option')
  gAuto.value = 'auto'
  gAuto.textContent = '⟳ otomatis — ikut urutan prioritas akun'
  gSel.append(gAuto)
  for (const a of accounts) {
    const o = document.createElement('option')
    o.value = a.id
    o.textContent = a.label
    gSel.append(o)
  }
  gSel.value = defaultAccountId ?? ''
  gSel.addEventListener('change', () => {
    void window.grove
      .setDefaultAccount(gSel.value || null)
      .then(() => {
        if (gSel.value) hideAuthBanner()
      })
      .catch((e) => alert(`Gagal set akun global: ${String(e)}`))
  })
  panel.append(gSel)
  // Akun global hanya jadi CADANGAN bagi sesi yang belum menentukan sendiri. Tombol ini memaksakan
  // pilihan itu ke SEMUA sesi — termasuk yang akunnya terlanjur digeser auto-switch saat limit.
  const applyAll = el('button', { class: 'ap-add' }, '↧ Terapkan akun ini ke SEMUA sesi')
  applyAll.addEventListener('click', () => {
    const target = gSel.value || null
    const nama = target ? (accounts.find((a) => a.id === target)?.label ?? '?') : '(kosongkan → ikut global)'
    void uiConfirm(`Paksa SEMUA sesi memakai akun "${nama}"? Pilihan akun per-sesi yang ada akan ditimpa.`, 'Ya, terapkan').then((ok) => {
      if (!ok) return
      void window.grove.applyAccountToAll(target).then((n) => {
        appendChatMessage({ role: 'system', text: `↧ ${n} sesi dipindah ke akun "${nama}".`, ts: Date.now() })
      })
    })
  })
  panel.append(applyAll)

  // AKUN PEMBACA GAMBAR (OCR). Sesi bermodel buta-gambar menitipkan gambarnya ke akun lain; tanpa
  // setelan ini Grove memakai akun GLOBAL duluan, dan kalau akun itu tak bisa membaca gambar (mis.
  // kuota modelnya habis) SETIAP gambar gagal dulu sebelum jatuh ke cadangan.
  panel.append(el('div', { class: 'ap-head' }, 'Akun pembaca gambar (OCR)'))
  const vSel = document.createElement('select')
  vSel.className = 'ap-input'
  vSel.title = 'Dipakai saat model sesi tak bisa melihat gambar. Pilih akun yang kamu tahu bisa (mis. langganan Claude).'
  const vAuto = document.createElement('option')
  vAuto.value = ''
  vAuto.textContent = '— otomatis (urutan bawaan) —'
  vSel.append(vAuto)
  for (const a of accounts) {
    if (a.provider === 'deepseek') continue // DeepSeek mengabaikan gambar diam-diam → jangan ditawarkan
    const o = document.createElement('option')
    o.value = a.id
    o.textContent = `${a.label}${a.model ? ` · ${a.model.split(',')[0].trim()}` : ''}`
    vSel.append(o)
  }
  vSel.value = visionAccountId ?? ''
  vSel.addEventListener('change', () => {
    void window.grove
      .setVisionAccount(vSel.value || null)
      .catch((e) => alert(`Gagal set akun gambar: ${String(e)}`))
  })
  panel.append(vSel)

  panel.append(el('div', { class: 'ap-head' }, 'Tersimpan'))
  if (!accounts.length) {
    panel.append(el('div', { class: 'ap-empty' }, 'Belum ada akun. Sesi TIDAK bisa jalan tanpa akun.'))
  } else {
    for (const a of accounts) {
      const del = el('button', { class: 'ap-del', title: 'Hapus akun' }, '×')
      del.addEventListener('click', () => {
        if (confirm(`Hapus akun "${a.label}"?`)) void window.grove.deleteAccount(a.id).catch((e) => alert(String(e)))
      })
      const planTag = a.plan ? el('span', { class: 'ap-plan' }, `Max ${a.plan}x`) : el('span', {})
      // Badge provider: akun OpenRouter / custom-proxy ditandai jelas + model yang dipakainya.
      const provTag =
        a.provider === 'openrouter'
          ? el('span', { class: 'ap-prov', title: a.model ?? '' }, `OR: ${a.model?.split('/').pop() ?? '?'}`)
          : a.provider === 'custom'
            ? el('span', { class: 'ap-prov', title: `${a.baseUrl ?? ''} · ${a.model ?? ''}` }, `GM: ${a.model ?? '?'}`)
            : a.provider === 'cursor'
              ? el('span', { class: 'ap-prov', title: `${a.baseUrl ?? ''} · ${a.model ?? ''}` }, `CR: ${a.model ?? '?'}`)
              : a.provider === 'deepseek'
                ? el(
                    'span',
                    {
                      class: 'ap-prov',
                      title: `api.deepseek.com · ${a.model ?? DEEPSEEK_MODEL_DEFAULT}\n${deepseekPriceLabel(a.model)}`
                    },
                    `DS: ${a.model ?? DEEPSEEK_MODEL_DEFAULT}`
                  )
                : a.provider === 'dzax'
                  ? (() => {
                      // Daftar model bisa panjang (beberapa kandidat) — tampilkan yang UTAMA saja + jumlah
                      // cadangannya, selengkapnya di tooltip. Badge panjang dulu mendorong tombol ✎/×
                      // keluar dari panel sehingga akun tak bisa diedit sama sekali.
                      const ms = (a.model ?? '').split(',').map((m) => m.trim()).filter(Boolean)
                      const short = ms[0] ?? '?'
                      return el(
                        'span',
                        {
                          class: 'ap-prov',
                          title: [a.baseUrl ?? DZAX_BASE_URL_DEFAULT, ...(ms.length ? ms : ['?'])].join('\n')
                        },
                        `OAI: ${short}${ms.length > 1 ? ` +${ms.length - 1}` : ''}`
                      )
                    })()
                  : el('span', {})
      // Tombol ✎ — buka form ubah akun di tempat. Ini jalan satu-satunya untuk MELIHAT & mengoreksi
      // endpoint/model akun gateway tanpa harus menghapus lalu membuat ulang (yang menghilangkan
      // riwayat pemakaian akun itu).
      // Urutan prioritas rotasi otomatis: yang di ATAS dicoba lebih dulu saat akun sekarang kena
      // limit/ambang. Tanpa urutan eksplisit, Grove memakai ukuran paket seperti dulu.
      const rankNo = accountOrder.indexOf(a.id)
      const prio = el('span', { class: 'ap-prio', title: 'Prioritas rotasi otomatis (makin kecil, makin dulu dicoba)' }, rankNo >= 0 ? `#${rankNo + 1}` : '#–')
      const move = (dir: -1 | 1): void => {
        const ids = accountOrder.length ? [...accountOrder] : accounts.map((x) => x.id)
        const from = ids.indexOf(a.id)
        const at = from < 0 ? ids.length : from
        if (from >= 0) ids.splice(from, 1)
        const to = Math.max(0, Math.min(ids.length, at + dir))
        ids.splice(to, 0, a.id)
        void window.grove.setAccountOrder(ids)
      }
      const up = el('button', { class: 'ap-edit', title: 'Naikkan prioritas rotasi' }, '▲')
      const down = el('button', { class: 'ap-edit', title: 'Turunkan prioritas rotasi' }, '▼')
      up.addEventListener('click', () => move(-1))
      down.addEventListener('click', () => move(1))
      const edit = el('button', { class: 'ap-edit', title: 'Ubah akun (endpoint, model, label, token)' }, '✎')
      const labelEl = el('span', { class: 'ap-label', title: a.label }, a.label)
      const row = el('div', { class: 'ap-item' }, prio, labelEl, provTag, planTag, up, down, edit, del)
      panel.append(row)

      const form = el('div', { class: 'ap-editbox' })
      form.hidden = true
      const field = (labelText: string, value: string, ph: string): HTMLInputElement => {
        const inp = document.createElement('input')
        inp.className = 'ap-input'
        inp.value = value
        inp.placeholder = ph
        form.append(el('div', { class: 'ap-sub' }, labelText), inp)
        return inp
      }
      const fLabel = field('Label', a.label, 'nama akun')
      const fToken = field('Token / API key', '', 'biarkan KOSONG = token lama dipertahankan')
      fToken.type = 'password'
      const skinAcc = a.provider !== 'claude'
      const fModel = skinAcc ? field('Model (pisahkan koma = cadangan otomatis)', a.model ?? '', 'mis. claude-sonnet-5, glm-5.2') : null
      const ownUrlAcc = a.provider === 'custom' || a.provider === 'cursor' || a.provider === 'dzax'
      const fUrl = ownUrlAcc ? field('Endpoint (base URL, sampai /v1)', a.baseUrl ?? '', 'https://contoh.id/v1') : null
      const save = el('button', { class: 'ap-add' }, 'Simpan perubahan')
      const status = el('div', { class: 'ap-hint' }, '')
      form.append(save, status)
      panel.append(form)
      edit.addEventListener('click', () => {
        form.hidden = !form.hidden
        if (!form.hidden) fLabel.focus()
      })
      // Simpan → baris ini diperbarui DI TEMPAT. Panel sengaja tidak di-render ulang selama fokus
      // ada di dalamnya (itu akan menghapus form yang sedang kamu isi), jadi tanpa pembaruan
      // setempat hasil edit baru terlihat setelah panel ditutup-buka. Ini yang bikin terasa "tidak
      // realtime".
      const applyRowVisual = (acc: Account): void => {
        labelEl.textContent = acc.label
        labelEl.title = acc.label
        if (acc.provider === 'dzax') {
          const ms = (acc.model ?? '').split(',').map((m) => m.trim()).filter(Boolean)
          provTag.textContent = `OAI: ${ms[0] ?? '?'}${ms.length > 1 ? ` +${ms.length - 1}` : ''}`
          provTag.title = [acc.baseUrl ?? DZAX_BASE_URL_DEFAULT, ...(ms.length ? ms : ['?'])].join(String.fromCharCode(10))
        } else if (acc.provider === 'openrouter') {
          provTag.textContent = `OR: ${acc.model?.split('/').pop() ?? '?'}`
        } else if (acc.provider === 'deepseek') {
          provTag.textContent = `DS: ${acc.model ?? DEEPSEEK_MODEL_DEFAULT}`
        } else if (acc.provider === 'custom' || acc.provider === 'cursor') {
          provTag.textContent = `${acc.provider === 'custom' ? 'GM' : 'CR'}: ${acc.model ?? '?'}`
          provTag.title = `${acc.baseUrl ?? ''} · ${acc.model ?? ''}`
        }
      }
      save.addEventListener('click', () => {
        status.textContent = 'menyimpan…'
        void window.grove
          .updateAccount(a.id, {
            label: fLabel.value,
            token: fToken.value || undefined,
            model: fModel ? fModel.value : undefined,
            baseUrl: fUrl ? fUrl.value : undefined
          })
          .then((acc) => {
            fToken.value = ''
            // Perbarui salinan lokal + tampilan baris, tanpa menutup form yang sedang dibuka.
            const idx = accounts.findIndex((x) => x.id === a.id)
            if (idx >= 0) accounts[idx] = acc
            applyRowVisual(acc)
            if (fModel) fModel.value = acc.model ?? ''
            if (fUrl) fUrl.value = acc.baseUrl ?? ''
            status.textContent = `✓ tersimpan ${new Date().toLocaleTimeString()} — berlaku pada giliran berikutnya`
          })
          .catch((e) => {
            status.textContent = `gagal: ${String(e)}`
          })
      })

      // Akun non-Claude (OpenRouter / custom-proxy) tak punya kuota gaya Claude → ambang tak relevan; lewati.
      if (a.provider !== 'claude') continue

      // Ambang khusus akun ini. Kosong = ikut ambang default di atas.
      const pct = document.createElement('input')
      pct.type = 'number'
      pct.className = 'ap-pct'
      pct.min = '50'
      pct.max = '99'
      pct.placeholder = String(defaultSwitchPct)
      pct.value = a.switchPct == null ? '' : String(a.switchPct)
      pct.title = `Kosongkan untuk ikut ambang default (${defaultSwitchPct}%)`
      pct.addEventListener('change', () => {
        const raw = pct.value.trim()
        const v = raw === '' ? null : Math.min(99, Math.max(50, Math.round(Number(raw))))
        if (v != null && !Number.isFinite(v)) return
        void window.grove.setAccountSwitchPct(a.id, v).catch((e) => alert(String(e)))
      })
      const sub = el('div', { class: 'ap-sub' }, el('span', {}, 'ambang'), pct, el('span', {}, '%'))
      // KEJUJURAN UI: kalau usage akun ini tak terbaca, ambang di atas TIDAK akan pernah memicu.
      // Lebih baik user tahu daripada mengira proteksi proaktif menyala padahal tidak.
      if (a.usageReadable === false) {
        sub.append(
          el(
            'span',
            {
              class: 'ap-dead',
              title:
                'Kuota akun ini tidak terbaca — baik lewat endpoint resmi maupun header rate-limit.\n' +
                'Ambang tidak akan memicu; yang tersisa hanya switch REAKTIF saat benar-benar kena limit.\n' +
                'Cek token akun ini masih sah (belum dicabut/kedaluwarsa).'
            },
            '⚠ non-aktif'
          )
        )
      }
      panel.append(sub)
    }
  }

  panel.append(el('div', { class: 'ap-head' }, 'Tambah akun'))
  // Pilih provider: Claude (langganan), OpenRouter (key + model), atau Gemini/Proxy (base-URL sendiri).
  const prov = document.createElement('select')
  prov.className = 'ap-input'
  for (const [v, t] of [
    ['claude', 'Claude (langganan)'],
    ['deepseek', 'DeepSeek (token saja)'],
    ['dzax', 'Gateway OpenAI-compatible (raw / DZAX)'],
    ['openrouter', 'OpenRouter (key + model)'],
    ['custom', 'Gemini / Proxy (base-URL)'],
    ['cursor', 'Cursor (token free + proxy)']
  ] as const) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = t
    prov.append(o)
  }

  const label = document.createElement('input')
  label.className = 'ap-input'
  label.placeholder = 'Label (mis. Kantor Max20)'
  const token = document.createElement('textarea')
  token.className = 'ap-input ap-token'
  token.rows = 2

  // Field khusus 'custom': base URL endpoint Anthropic-compatible (proxy sendiri). Hanya tampil bila custom.
  const baseUrl = document.createElement('input')
  baseUrl.className = 'ap-input'
  baseUrl.placeholder = 'Base URL proxy, mis. http://localhost:4000'

  // Field model DeepSeek: daftar TERTUTUP (pro/flash) → dropdown, bukan ketik bebas.
  const dsModel = document.createElement('select')
  dsModel.className = 'ap-input'
  for (const m of DEEPSEEK_MODEL_SUGGESTIONS) {
    const o = document.createElement('option')
    o.value = m.id
    o.textContent = m.label
    dsModel.append(o)
  }
  dsModel.value = DEEPSEEK_MODEL_DEFAULT

  // Field model (OpenRouter & custom): id/nama model dengan saran. Hanya tampil bila provider skin.
  const orModel = document.createElement('input')
  orModel.className = 'ap-input'
  orModel.setAttribute('list', 'or-model-list')
  orModel.placeholder = 'Model OpenRouter, mis. nvidia/nemotron-3-super-120b-a12b:free'
  const datalist = document.createElement('datalist')
  datalist.id = 'or-model-list'
  // Isi awal: saran statis (langsung ada). Lalu ganti dgn daftar LIVE (gratis + dukung tools) begitu
  // fetch selesai — id + ukuran param (B) + limit context, seperti diminta.
  const fillDatalist = (items: ReadonlyArray<{ value: string; text: string }>): void => {
    datalist.textContent = ''
    for (const it of items) {
      const o = document.createElement('option')
      o.value = it.value
      o.textContent = it.text
      datalist.append(o)
    }
  }
  const orSuggest = OPENROUTER_MODEL_SUGGESTIONS.map((m) => ({ value: m.id, text: m.label }))
  const customSuggest = CUSTOM_MODEL_SUGGESTIONS.map((m) => ({ value: m.id, text: m.label }))
  const cursorSuggest = CURSOR_MODEL_SUGGESTIONS.map((m) => ({ value: m.id, text: m.label }))
  const dzaxSuggest = DZAX_MODEL_SUGGESTIONS.map((m) => ({ value: m.id, text: m.label }))
  let orLive: ReadonlyArray<{ value: string; text: string }> | null = null
  fillDatalist(orSuggest)
  void window.grove
    .listOpenRouterModels(true)
    .then((list) => {
      if (!list.length) return // fetch gagal → biarkan saran statis
      const fmtCtx = (n: number): string => (n >= 1e6 ? `${n / 1e6}M` : `${Math.round(n / 1000)}K`)
      orLive = list.map((m) => ({ value: m.id, text: `${m.name} · ${m.paramB || '?'} · ${fmtCtx(m.context)} ctx` }))
      if (prov.value === 'openrouter') fillDatalist(orLive) // hanya refresh bila OR yang sedang aktif
    })
    .catch(() => {})

  // Ukuran paket dipakai saat SEMUA akun sudah menembus ambang kuota → yang terbesar dipilih (Claude saja).
  const plan = document.createElement('input')
  plan.className = 'ap-input'
  plan.type = 'number'
  plan.min = '1'
  plan.placeholder = 'Ukuran paket, mis. 20 untuk Max 20x (opsional)'

  const hint = el('div', { class: 'ap-hint' }, '')
  const applyProvider = (): void => {
    const p = prov.value // 'claude' | 'deepseek' | 'dzax' | 'openrouter' | 'custom' | 'cursor'
    // dzax memakai base URL sendiri (gateway), tapi BUKAN proxy lokal buatan user.
    const proxy = p === 'custom' || p === 'cursor'
    const ownUrl = proxy || p === 'dzax'
    const skin = p === 'openrouter' || p === 'deepseek' || p === 'dzax' || proxy
    token.placeholder =
      p === 'dzax'
        ? 'API key gateway (mis. ctg_… DZAX, sk_live_…, sk-…)'
        : p === 'deepseek'
        ? 'DeepSeek API key (sk-…) — ambil di platform.deepseek.com'
        : p === 'openrouter'
        ? 'OpenRouter API key (sk-or-v1-…)'
        : p === 'cursor'
          ? 'claude-code-proxy: isi "unused" · Cursor-To-OpenAI: WorkosCursorSessionToken'
          : p === 'custom'
            ? 'Token proxy (ANTHROPIC_AUTH_TOKEN) — isi apa saja bila proxy tak memeriksa'
            : 'CLAUDE_CODE_OAUTH_TOKEN (sk-ant-oat01-…)'
    baseUrl.style.display = ownUrl ? 'block' : 'none'
    // Prefill base URL saat kosong ATAU masih salah satu default bawaan → ganti provider ganti default,
    // tapi URL yang sudah user-ketik tetap dipertahankan.
    const knownDefaults: string[] = [CUSTOM_BASE_URL_DEFAULT, CURSOR_BASE_URL_DEFAULT, DZAX_BASE_URL_DEFAULT]
    if (ownUrl && (!baseUrl.value || knownDefaults.includes(baseUrl.value))) {
      baseUrl.value =
        p === 'dzax' ? DZAX_BASE_URL_DEFAULT : p === 'cursor' ? CURSOR_BASE_URL_DEFAULT : CUSTOM_BASE_URL_DEFAULT
    }
    // DeepSeek punya daftar model TERTUTUP → dropdown sendiri; provider skin lain tetap ketik-bebas.
    dsModel.style.display = p === 'deepseek' ? 'block' : 'none'
    orModel.style.display = skin && p !== 'deepseek' ? 'block' : 'none'
    orModel.placeholder =
      p === 'dzax'
        ? 'Model (boleh BEBERAPA dipisah koma = cadangan otomatis), mis. claude-sonnet-5, glm-5.2, kimi-k3'
        : p === 'cursor'
        ? 'Nama model Cursor, mis. claude-3.5-sonnet'
        : p === 'custom'
          ? 'Nama model yg dikenal proxy, mis. gemini-2.5-flash'
          : 'Model OpenRouter, mis. nvidia/nemotron-3-super-120b-a12b:free'
    fillDatalist(
      p === 'dzax'
        ? dzaxSuggest
        : p === 'cursor'
          ? cursorSuggest
          : p === 'custom'
            ? customSuggest
            : (orLive ?? orSuggest)
    )
    plan.style.display = skin ? 'none' : 'block'
    hint.textContent =
      p === 'dzax'
        ? '🌉 Untuk endpoint APA PUN yang berformat OpenAI (chat/completions) — DZAX/Belo Store, gateway pribadi, endpoint raw. Grove menjalankan JEMBATAN penerjemah lokal sendiri, jadi tak perlu proxy tambahan. Base URL = alamat sampai /v1 SAJA (tanpa /chat/completions). Model boleh diisi BEBERAPA id dipisah koma — yang pertama jadi utama, sisanya CADANGAN yang dipakai otomatis kalau gateway menolak (kuota model itu habis / tak diizinkan). Nama model harus PERSIS; kalau salah, gateway biasanya membalas daftar model yang diizinkan. Diuji jalan di Grove: chat, streaming, dan tool-call. Kuota gaya Claude tak berlaku di sini.'
        : p === 'deepseek'
        ? '🚀 Langsung ke endpoint Anthropic RESMI DeepSeek (https://api.deepseek.com/anthropic) — TANPA proxy lokal: cukup API key. Streaming, tool, & reasoning sudah diuji jalan di Grove. Pilih modelnya di dropdown: deepseek-v4-pro (paling pintar, ~1jt konteks) atau deepseek-v4-flash (lebih cepat & hemat) — bisa diganti per-sesi lewat klik-kanan kartu sesi. Kuota gaya Claude tak berlaku — yang berlaku saldo & rate-limit DeepSeek.'
        : p === 'openrouter'
        ? '⚠️ OpenRouter hanya MENJAMIN Claude Code untuk model Anthropic. Model lain (mis. Nemotron) bisa saja tak patuh protokol tool Grove — uji dulu di satu sesi sebelum diandalkan. Kuota gaya Claude tak berlaku (auto-switch/ambang diabaikan).'
        : p === 'cursor'
          ? '🔌 Butuh PROXY Anthropic-native untuk Cursor. Termudah: raine/claude-code-proxy → jalankan "claude-code-proxy cursor auth login" lalu "claude-code-proxy serve" (:18765); di form token isi "unused" (auth disimpan proxy), Model = cursor / composer-2.5. Alternatif: Cursor-To-OpenAI + bridge Anthropic→OpenAI, token = WorkosCursorSessionToken. Kuota gaya Claude tak berlaku — "limit" = batas request Cursor.'
          : p === 'custom'
            ? '🔌 Perlu PROXY penerjemah Anthropic→Gemini yang jalan lokal (LiteLLM / claude-code-router) memegang API key Gemini gratismu. Base URL = alamat proxy itu; Model = nama yang dikenal proxy. Kuota gaya Claude tak berlaku — "limit" = rate-limit Gemini (bukan kuota Claude).'
            : 'Token `claude setup-token` didukung penuh: menjalankan sesi maupun memantau kuota (usage dibaca dari header rate-limit bila endpoint resmi menolak).'
  }
  prov.addEventListener('change', applyProvider)

  const add = el('button', { class: 'ap-add' }, '+ Tambah akun')
  add.addEventListener('click', () => {
    const l = label.value.trim()
    const t = token.value.trim()
    const provider = prov.value as 'claude' | 'openrouter' | 'custom' | 'cursor' | 'deepseek' | 'dzax'
    const proxy = provider === 'custom' || provider === 'cursor'
    const ownUrl = proxy || provider === 'dzax'
    const skin = provider === 'openrouter' || provider === 'deepseek' || provider === 'dzax' || proxy
    const p = !skin && Number(plan.value) > 0 ? Number(plan.value) : undefined
    // DeepSeek: dari dropdown (pro/flash), selalu terisi. Skin lain: ketik bebas.
    const m = provider === 'deepseek' ? dsModel.value || DEEPSEEK_MODEL_DEFAULT : skin ? orModel.value.trim() : undefined
    const url = ownUrl ? baseUrl.value.trim() || (provider === 'dzax' ? DZAX_BASE_URL_DEFAULT : '') : undefined
    if (!l || !t) return alert('Isi label & token/key dulu.')
    if (provider === 'openrouter' && !m) return alert('Isi id model OpenRouter (mis. nvidia/nemotron-3-super-120b-a12b:free).')
    if (provider === 'cursor' && !m) return alert('Isi nama model Cursor yang dikenal proxy (mis. claude-3.5-sonnet).')
    if (provider === 'custom' && !m) return alert('Isi nama model yang dikenal proxy (mis. gemini-2.5-flash).')
    if (provider === 'dzax' && !m) return alert('Isi model DZAX sesuai family key-mu (mis. gl/glm-5.2 atau kr/claude-sonnet-5).')
    if (proxy && !url) return alert('Isi base URL proxy (mis. http://localhost:3000).')
    void window.grove
      .addAccount(l, t, p, undefined, provider, m, url)
      .then(() => {
        label.value = ''
        token.value = ''
        plan.value = ''
        orModel.value = ''
        baseUrl.value = ''
      })
      .catch((e) => alert(`Gagal tambah: ${String(e)}`))
  })
  panel.append(prov, label, token, baseUrl, dsModel, orModel, datalist, hint, plan, add)
  applyProvider() // set tampilan awal sesuai provider default (claude)

  const node = activeId ? nodes.get(activeId) : null
  if (node) {
    panel.append(el('div', { class: 'ap-head' }, `Sesi aktif: ${node.title}`))
    const sel = document.createElement('select')
    sel.className = 'ap-input'
    // TIDAK ADA lagi opsi "Default (login utama)": Grove berjalan murni dgn token akun GUI, jadi
    // opsi itu dulu berarti "diam-diam pakai & tagih akun login CLI".
    // Opsi kosong sekarang berarti MEWARISI, bukan "tanpa akun": sub-sesi ikut sesi utamanya,
    // sesi utama ikut akun global. Teksnya menyebut sumber warisan + akun efektifnya supaya user
    // tak perlu menebak akun mana yang sebenarnya menagih.
    const isSub = node.role === 'sub'
    const rootAcct = isSub ? (nodes.get(node.treeId)?.accountId ?? null) : null
    const inheritedId = rootAcct ?? defaultAccountId
    const inheritedLabel = accounts.find((a) => a.id === inheritedId)?.label
    const def = document.createElement('option')
    def.value = ''
    def.textContent = inheritedLabel
      ? `— ikut ${isSub ? 'sesi utama' : 'akun global'}: ${inheritedLabel} —`
      : accounts.length
        ? '— pilih akun (warisan kosong) —'
        : '— belum ada akun —'
    sel.append(def)
    for (const a of accounts) {
      const o = document.createElement('option')
      o.value = a.id
      o.textContent = a.label
      sel.append(o)
    }
    sel.value = node.accountId ?? ''
    // Memilih opsi kosong = KEMBALI mewarisi (kirim null), bukan "tanpa akun".
    sel.addEventListener('change', () => {
      void window.grove
        .setSessionAccount(node.id, sel.value || null)
        .then(() => {
          if (sel.value || inheritedId) hideAuthBanner()
          renderAccountsPanel() // label warisan sub-sesi ikut berubah saat root diganti
        })
        .catch((e) => alert(`Gagal ganti akun: ${String(e)}`))
    })
    panel.append(el('div', { class: 'ap-row' }, el('span', {}, 'Akun sesi: '), sel))
    if (!isSub) {
      panel.append(el('div', { class: 'ap-hint' }, 'Sub-sesi pohon ini otomatis ikut akun sesi utama, kecuali diatur sendiri.'))
    }
  }
}

// ---- Panel Tools: diff checker + formatter (MURNI renderer / client-side) ----
// Dua utilitas mandiri, tidak menyentuh DB/IPC/main maupun panel chat LOG.

/** Satu operasi diff per-baris: sama (eq), tambah (add), hapus (del). */
type DiffOp = { type: 'eq' | 'add' | 'del'; text: string }

/**
 * Diff per-baris berbasis LCS (longest common subsequence). Baris yang sama dipertahankan,
 * selebihnya jadi hapus (dari A) / tambah (ke B). O(n·m) memori & waktu — cukup untuk textarea.
 */
function lineDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  // Tabel LCS diisi dari belakang: dp[i][j] = panjang subsequence sama dari a[i..] & b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'eq', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i++
    } else {
      out.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}

let toolsPanelBuilt = false

/** Isi panel Tools SEKALI (lazy) supaya teks yang diketik user tak hilang saat panel dibuka-tutup. */
function renderToolsPanel(): void {
  if (toolsPanelBuilt) return
  toolsPanelBuilt = true
  const panel = $('tools-panel')
  panel.textContent = ''
  panel.append(el('div', { class: 'ap-title' }, 'TOOLS'))

  const tabDiff = el('button', { class: 'tools-tab active' }, 'Diff')
  const tabFmt = el('button', { class: 'tools-tab' }, 'Formatter')
  panel.append(el('div', { class: 'tools-tabs' }, tabDiff, tabFmt))

  const secDiff = el('div', { class: 'tools-sec' })
  const secFmt = el('div', { class: 'tools-sec' })
  secFmt.hidden = true
  panel.append(secDiff, secFmt)

  const showTab = (which: 'diff' | 'fmt'): void => {
    const isDiff = which === 'diff'
    secDiff.hidden = !isDiff
    secFmt.hidden = isDiff
    tabDiff.classList.toggle('active', isDiff)
    tabFmt.classList.toggle('active', !isDiff)
  }
  tabDiff.addEventListener('click', () => showTab('diff'))
  tabFmt.addEventListener('click', () => showTab('fmt'))

  buildDiffSection(secDiff)
  buildFormatterSection(secFmt)
}

/** Seksi Diff: dua textarea (A lama / B baru) → render diff per-baris berwarna. */
function buildDiffSection(sec: HTMLElement): void {
  const taA = document.createElement('textarea')
  taA.className = 'tools-ta'
  taA.rows = 6
  taA.placeholder = 'Teks A (lama)…'
  const taB = document.createElement('textarea')
  taB.className = 'tools-ta'
  taB.rows = 6
  taB.placeholder = 'Teks B (baru)…'
  sec.append(
    el(
      'div',
      { class: 'tools-grid2' },
      el('div', { class: 'tools-col' }, el('label', { class: 'tools-lbl' }, 'A · lama'), taA),
      el('div', { class: 'tools-col' }, el('label', { class: 'tools-lbl' }, 'B · baru'), taB)
    )
  )

  const stat = el('span', { class: 'tools-stat' }, '')
  const out = el('div', { class: 'diff-out' })

  const run = (): void => {
    // String kosong → 0 baris (bukan [''] satu baris kosong), supaya statistik jujur.
    const a = taA.value === '' ? [] : taA.value.split('\n')
    const b = taB.value === '' ? [] : taB.value.split('\n')
    out.textContent = ''
    // Guard beban: LCS O(n·m). Cegah UI beku pada input raksasa.
    if (a.length * b.length > 4_000_000) {
      out.append(el('div', { class: 'diff-msg' }, 'Terlalu besar untuk dibandingkan per-baris (batas ±2000×2000 baris).'))
      stat.textContent = ''
      return
    }
    const ops = lineDiff(a, b)
    let add = 0
    let del = 0
    for (const op of ops) {
      if (op.type === 'add') add++
      else if (op.type === 'del') del++
      const sign = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '
      out.append(
        el(
          'div',
          { class: `diff-line diff-${op.type}` },
          el('span', { class: 'diff-sign' }, sign),
          el('span', { class: 'diff-txt' }, op.text)
        )
      )
    }
    if (!ops.length) out.append(el('div', { class: 'diff-msg' }, 'Kedua sisi kosong.'))
    else if (!add && !del) out.append(el('div', { class: 'diff-msg' }, 'Identik — tak ada perbedaan.'))
    stat.textContent = add || del ? `+${add} −${del}` : ''
  }

  const btn = el('button', { class: 'tools-btn primary' }, 'Bandingkan')
  btn.addEventListener('click', run)
  // Interaktif juga saat mengetik (debounce ringan), selain klik tombol.
  let t: number | undefined
  const onInput = (): void => {
    window.clearTimeout(t)
    t = window.setTimeout(run, 250)
  }
  taA.addEventListener('input', onInput)
  taB.addEventListener('input', onInput)

  sec.append(el('div', { class: 'tools-actions' }, btn, stat), out)
}

/** Seksi Formatter: input + pilih bahasa (JSON/YAML) → output rapi read-only + tombol Salin. */
function buildFormatterSection(sec: HTMLElement): void {
  const input = document.createElement('textarea')
  input.className = 'tools-ta'
  input.rows = 7
  input.placeholder = 'Tempel JSON atau YAML berantakan di sini…'

  const lang = document.createElement('select')
  lang.className = 'tools-sel'
  for (const [v, tx] of [
    ['json', 'JSON'],
    ['yaml', 'YAML']
  ] as const) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = tx
    lang.append(o)
  }

  const out = document.createElement('textarea')
  out.className = 'tools-ta tools-out'
  out.rows = 8
  out.readOnly = true
  out.placeholder = 'Hasil rapi muncul di sini…'

  const msg = el('div', { class: 'tools-msg' }, '')

  const format = (): void => {
    const src = input.value
    if (src.trim() === '') {
      out.value = ''
      msg.className = 'tools-msg'
      msg.textContent = 'Input kosong.'
      return
    }
    try {
      if (lang.value === 'json') {
        // Validasi + pretty 2 spasi.
        out.value = JSON.stringify(JSON.parse(src), null, 2)
      } else {
        // Round-trip via js-yaml: load → dump (indent 2, tanpa wrap baris, tanpa anchor/alias).
        out.value = yamlDump(yamlLoad(src), { indent: 2, lineWidth: -1, noRefs: true })
      }
      msg.className = 'tools-msg ok'
      msg.textContent = '✓ Rapi.'
    } catch (e) {
      // Input tak valid → pesan ramah, TIDAK crash.
      out.value = ''
      msg.className = 'tools-msg err'
      msg.textContent = `⛔ ${lang.value.toUpperCase()} tidak valid: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  const btnFmt = el('button', { class: 'tools-btn primary' }, 'Rapikan')
  btnFmt.addEventListener('click', format)
  lang.addEventListener('change', () => {
    if (out.value || (msg.textContent && msg.classList.contains('err'))) format() // re-run kalau sudah ada hasil
  })

  const btnCopy = el('button', { class: 'tools-btn' }, 'Salin')
  const flash = (label: string): void => {
    const old = btnCopy.textContent
    btnCopy.textContent = label
    window.setTimeout(() => (btnCopy.textContent = old), 1200)
  }
  const selectOut = (): void => {
    out.focus()
    out.select()
  }
  btnCopy.addEventListener('click', () => {
    if (!out.value) return
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(out.value).then(
        () => flash('✓ Tersalin'),
        () => selectOut() // clipboard ditolak → biarkan user Ctrl+C manual
      )
    } else {
      selectOut()
      try {
        if (document.execCommand('copy')) flash('✓ Tersalin')
      } catch {
        /* biarkan terseleksi untuk salin manual */
      }
    }
  })

  sec.append(
    el('label', { class: 'tools-lbl' }, 'Input'),
    input,
    el('div', { class: 'tools-actions' }, el('span', { class: 'tools-lbl' }, 'Bahasa:'), lang, btnFmt, btnCopy),
    msg,
    el('label', { class: 'tools-lbl' }, 'Output'),
    out
  )
}

// ---- events ----------------------------------------------------------------

/**
 * PROBE PERFORMA — supaya "UI berat" bisa DIBUKTIKAN dari app yang benar-benar kamu pakai, bukan
 * ditebak dari harness. Ia mencatat "long task" (blok >50ms di thread UI, itulah yang terasa sebagai
 * macet) beserta pekerjaan terakhir yang sedang dilakukan, plus jumlah event per kanal.
 *
 * Cara pakai: View → Toggle Developer Tools → ketik `grovePerf()`. Nyaris nol biaya saat diam
 * (PerformanceObserver hanya dipanggil ketika memang ada task panjang).
 */
const perfStats = {
  longTasks: 0,
  worstMs: 0,
  recent: [] as Array<{ jam: string; ms: number; saat: string }>,
  events: new Map<string, number>()
}
let perfNote = 'idle'
if (typeof PerformanceObserver !== 'undefined') {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 50) continue
        perfStats.longTasks++
        perfStats.worstMs = Math.max(perfStats.worstMs, Math.round(e.duration))
        perfStats.recent.push({ jam: new Date().toLocaleTimeString(), ms: Math.round(e.duration), saat: perfNote })
        if (perfStats.recent.length > 25) perfStats.recent.shift()
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    /* browser tanpa longtask API → probe diam saja */
  }
}
;(window as unknown as { grovePerf: () => unknown }).grovePerf = () => ({
  taskPanjang: perfStats.longTasks,
  terburukMs: perfStats.worstMs,
  terakhir: perfStats.recent,
  eventPerKanal: Object.fromEntries(perfStats.events),
  pesanDiChat: document.getElementById('chat-log')?.childElementCount ?? 0,
  barisLog: document.getElementById('log-tree')?.childElementCount ?? 0,
  totalNodeDom: document.getElementsByTagName('*').length
})

function onEvent(ev: GroveEvent): void {
  perfStats.events.set(ev.channel, (perfStats.events.get(ev.channel) ?? 0) + 1)
  perfNote = ev.channel // dicatat probe: kanal apa yang sedang diproses saat UI membeku
  switch (ev.channel) {
    case 'session:new': {
      const { ctxPercent, ...meta } = ev.payload
      nodes.set(meta.id, { ...(meta as SessionMeta), ctxPercent, tokensTotal: 0 })
      renderTree()
      if (!activeId) void selectSession(meta.id)
      break
    }
    case 'session:update': {
      const cur = nodes.get(ev.payload.id)
      if (cur) {
        if (ev.payload.status === 'running') {
          turnStart.set(ev.payload.id, Date.now())
          lastElapsed.set(ev.payload.id, 0)
        }
        Object.assign(cur, ev.payload)
        if (ev.payload.ctxPercent != null) cur.ctxPercent = ev.payload.ctxPercent
        updateNodeVisual(ev.payload.id) // incremental, bukan rebuild pohon
        touchActive(ev.payload.id) // catat waktu aktif + refresh label jam idle/done
        if (ev.payload.id === activeId) updateChatHeader()
        // Rincian token per-call (dari applyUsage) → catat ke turn LOG untuk diagnosa "kenapa berat".
        if (ev.payload.id === activeId && ev.payload.callUsage) logAddCallUsage(ev.payload.callUsage)
        // Turn sesi aktif selesai (idle/done) → tandai penanda akhir-turn di pohon LOG.
        if (ev.payload.id === activeId && (ev.payload.status === 'idle' || ev.payload.status === 'done'))
          logMarkTurnDone()
        // Akun sesi aktif berganti (manual atau auto-switch saat limit) → usage harus ikut pindah.
        if (ev.payload.id === activeId && 'accountId' in ev.payload) syncUsageSession()
      }
      break
    }
    case 'chat:delta': {
      if (ev.payload.id !== activeId) break
      if (!pendingEl) {
        pendingEl = appendChatMessage({ role: 'assistant', text: '', ts: Date.now() }, false)
        pendingText = ''
        shownLen = 0
        pendingTextNode = document.createTextNode('') // B4: node teks stabil utk append-only
        pendingEl.appendChild(pendingTextNode)
      }
      pendingText += ev.payload.delta // buffer; diungkap halus oleh flushPending
      if (!pendingRaf) pendingRaf = requestAnimationFrame(flushPending)
      break
    }
    case 'chat:message': {
      if (ev.payload.id !== activeId) break
      const m = ev.payload.message
      if (m.role === 'assistant' && pendingEl) {
        if (pendingRaf) {
          cancelAnimationFrame(pendingRaf)
          pendingRaf = 0
        }
        pendingEl.innerHTML = renderMarkdown(m.text) // finalisasi: render markdown penuh
        pendingEl = null
        pendingTextNode = null // B4: node teks streaming diganti markdown penuh → lepas ref
        pendingText = ''
        shownLen = 0
      } else {
        appendChatMessage(m)
      }
      if (m.role === 'user') sentPrompts.push(m.text) // bahan riwayat ↑ (prompt yang sudah terkirim)
      logIngest(m) // pohon LOG live-update (sumber sama)
      break
    }
    case 'queue:update': {
      if (ev.payload.id !== activeId) break
      queueItems = ev.payload.items
      if (editingQid != null && !queueItems.some((q) => q.qid === editingQid)) setEditingQid(null) // sudah terkirim
      renderQueueStrip()
      break
    }
    case 'log:request': {
      if (ev.payload.id !== activeId) break
      logAddRequest(ev.payload.kind, ev.payload.text, ev.payload.bytes, ev.payload.images)
      break
    }
    case 'chat:detail': {
      if (ev.payload.id !== activeId) break
      const pre = toolDetailEls.get(ev.payload.toolUseId)
      if (pre) renderToolDetail(pre, ev.payload.detail) // output tool tiba → render ulang (warna tetap)
      break
    }
    case 'board:update': {
      board.set(ev.payload.sessionId, ev.payload)
      scheduleBoard()
      break
    }
    case 'message:new': {
      addInbox(ev.payload)
      break
    }
    case 'memory:new': {
      memories.push(ev.payload)
      const tree = activeId ? nodes.get(activeId)?.treeId : null
      if (ev.payload.treeId === tree) renderMemories()
      break
    }
    case 'accounts:update': {
      accounts = ev.payload.accounts
      autoSwitch = ev.payload.autoSwitch
      autoResume = ev.payload.autoResume
      defaultSwitchPct = ev.payload.defaultSwitchPct
      defaultAccountId = ev.payload.defaultAccountId
      visionAccountId = ev.payload.visionAccountId
      accountOrder = ev.payload.accountOrder ?? []
      defaultModel = ev.payload.defaultModel
      defaultEffort = ev.payload.defaultEffort
      syncGlobalModel()
      syncGlobalEffort()
      const panel = $('acct-panel')
      // JANGAN bangun ulang panel saat user sedang mengetik di dalamnya. Event ini juga datang dari
      // latar (watchdog usage tiap 5 mnt → noteUsageReadable); membangun ulang mid-edit menghapus
      // angka ambang yang belum sempat commit + membuang fokus. Itu bug "ambang kereset/beda-beda".
      if (panel.classList.contains('show') && !panel.contains(document.activeElement)) renderAccountsPanel()
      // Akun baru ditambahkan → banner "belum ada akun" mungkin sudah tak relevan lagi.
      if (accounts.length) hideAuthBanner()
      break
    }
    case 'auth:missing': {
      showAuthBanner(ev.payload)
      break
    }
    case 'session:activity': {
      activities.set(ev.payload.id, ev.payload.activity)
      updateNodeActivity(ev.payload.id)
      touchActive(ev.payload.id) // jaga waktu aktif tetap terkini
      if (ev.payload.id === activeId) updateChatHeader()
      break
    }
    case 'usage:update': {
      // ATRIBUSI BILLING: HANYA tampilkan usage milik akun SESI YANG SEDANG DIPILIH. Hasil fetch
      // akun lain (mis. watchdog akun default, atau fetch akun sebelumnya yang mendarat telat)
      // TIDAK BOLEH menimpa angka akun yang sedang tampil — itu yang bikin angka terlihat "kebagi".
      const want = activeId ? (nodes.get(activeId)?.accountId ?? null) : null
      if (ev.payload.accountId !== want) break
      renderUsage(ev.payload)
      break
    }
    case 'procs:update': {
      // Baris ringkas: total RAM + tiap proses (pid, RAM, sesi pemiliknya). Sesi yang sedang dibuka
      // ditebalkan supaya "ini proses milik yang saya lihat" langsung kelihatan.
      const box = document.getElementById('log-procs')
      if (box) {
        const { totalRamMb, procs } = ev.payload
        box.textContent = ''
        if (procs.length) {
          box.append(`⚙ ${procs.length} proses CLI · ${totalRamMb} MB  `)
          for (const p of procs) {
            const own = p.sessionId === activeId
            box.append(
              el(
                'span',
                { class: own ? 'lp-mine' : '' },
                ' · ',
                el('span', { class: 'lp-pid' }, `pid ${p.pid}`),
                ` ${p.ramMb}MB ${p.title ? clip1(p.title, 22) : '(tak terpetakan)'}`
              )
            )
          }
        }
      }
      break
    }
    case 'session:removed': {
      applyRemoved(ev.payload.ids) // idempoten dgn confirmDelete; tangani hapus dari sumber lain
      break
    }
  }
}

// ---- drag & drop -----------------------------------------------------------

function setupDragDrop(): void {
  const overlay = $('drop-overlay')
  let depth = 0
  const show = (on: boolean) => overlay.classList.toggle('show', on)
  const hint = $('drop-hint')

  /**
   * Teks & highlight overlay MENGIKUTI zona yang sedang di-hover, supaya user tahu AKIBAT drop
   * sebelum melepas — bukan satu pesan global yang menyesatkan. Panel target diangkat di atas
   * scrim (lihat .drop-target di styles.css) sehingga zona aktif terlihat terang, sisanya redup.
   */
  const applyZone = (zone: DropZone): void => {
    overlay.dataset.zone = zone
    hint.textContent = ZONE_HINT[zone]
    document.querySelector('.sidebar')?.classList.toggle('drop-target', zone === 'sidebar')
    document.querySelector('.chat')?.classList.toggle('drop-target', zone === 'chat')
  }

  // hanya reaksi untuk drag FILE dari luar, bukan drag/seleksi internal
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth++
    show(true)
  })
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    applyZone(zoneOf(e)) // zona bisa berganti saat kursor pindah kolom → teks & highlight ikut
  })
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = Math.max(0, depth - 1)
    if (depth === 0) {
      show(false)
      clearDropAffordance()
    }
  })
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    depth = 0
    show(false)
    clearDropAffordance()
    // Drop sudah dimaknai sebagai "kunci folder kerja" (kartu sesi / zona sidebar) → jangan
    // dobel-perlakukan folder itu sebagai referensi chat. Overlay & counter tetap dibereskan di atas.
    if (folderDropHandled) {
      folderDropHandled = false
      return
    }
    const files = e.dataTransfer?.files
    if (!files || !files.length) return
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        // gambar → lampiran gambar (seperti paste)
        const reader = new FileReader()
        reader.onload = () => {
          const url = String(reader.result)
          pendingImages.push({ mediaType: file.type, data: url.slice(url.indexOf(',') + 1) })
          renderAttachStrip()
        }
        reader.readAsDataURL(file)
      } else {
        // file/folder lain → referensi (path dikirim, Claude bisa baca)
        const path = window.grove.getPathForFile(file)
        if (path && !pendingRefs.includes(path)) pendingRefs.push(path)
      }
    }
    renderAttachStrip()
    $<HTMLTextAreaElement>('chat-input').focus()
  })
}

// ---- init ------------------------------------------------------------------

async function init(): Promise<void> {
  setupDragDrop()
  setupSidebarFolderDrop()

  $('btn-new-chat').addEventListener('click', async () => {
    try {
      const meta = await window.grove.newChat()
      ensureNode(meta) // daftarkan segera → tidak race dengan event session:new
      void selectSession(meta.id)
    } catch (err) {
      alert(`Gagal mulai chat: ${String(err)}`)
    }
  })

  $('btn-open-folder').addEventListener('click', async () => {
    try {
      const meta = await window.grove.pickFolder()
      if (meta) {
        ensureNode(meta)
        void selectSession(meta.id)
      }
    } catch (err) {
      alert(`Gagal buka folder: ${String(err)}`)
    }
  })

  $('btn-stop').addEventListener('click', () => {
    if (activeId) void window.grove.interruptSession(activeId).catch(() => {})
  })

  $('btn-compact').addEventListener('click', () => {
    if (!activeId) return
    const node = nodes.get(activeId)
    if (node?.role !== 'root') return
    if (!confirm('Compact UTAMA: ringkas laporan semua sub → simpan ke Memori & PADATKAN konteks root (detail mentah lama dilepas). Lanjut?')) return
    void window.grove.compactSession(activeId).catch((err) => alert(`Gagal compact: ${String(err)}`))
  })

  $('btn-loop').addEventListener('click', () => {
    if (!activeId) return
    const node = nodes.get(activeId)
    if (node?.role !== 'root') return
    const next = !node.loopActive
    node.loopActive = next // optimistis
    updateChatHeader()
    void window.grove.setLoop(activeId, next).catch((err) => alert(`Gagal set auto-check: ${String(err)}`))
  })

  $('btn-lite').addEventListener('click', () => {
    if (!activeId) return
    const node = nodes.get(activeId)
    if (node?.role !== 'root') return
    const next = !node.lite
    if (!next && !confirm('Aktifkan mode Orkestrator? Sesi ini bisa spawn worker & memuat 13 tool grove + protokol multi-agent — lebih boros token. Cocok untuk tugas besar/paralel, bukan chat biasa.')) return
    node.lite = next || undefined // optimistis
    updateChatHeader()
    void window.grove.setLite(activeId, next).catch((err) => alert(`Gagal ganti mode: ${String(err)}`))
  })

  $('btn-resume-all').addEventListener('click', () => {
    void window.grove.resumeAll().then((n) => {
      appendChatMessage({
        role: 'system',
        text: n ? `▶ ${n} sesi didorong meneruskan pekerjaannya.` : '▶ Tak ada sesi menganggur yang perlu didorong.',
        ts: Date.now()
      })
    })
  })

  $('btn-stop-all').addEventListener('click', () => {
    void window.grove
      .stopAll()
      .then((n) => {
        if (!n) alert('Tidak ada sesi yang sedang berjalan.')
      })
      .catch((err) => alert(`Gagal stop all: ${String(err)}`))
  })

  $('usage').addEventListener('click', (e) => {
    e.stopPropagation()
    const shown = $('usage-panel').classList.toggle('show')
    if (shown) void renderUsageHistory() // fetch riwayat saat dibuka (bukan tiap tick)
  })

  // Refresh MANUAL: fetch usage akun sesi terpilih sekarang. Disable + spin selama cooldown (10s,
  // sejalan dgn guard di main) supaya user tak bisa hammer endpoint → cegah 429. Klik saat cooldown
  // dijaga di main (balik cache, tak fetch); di sini cukup guard visual.
  $('usage-refresh').addEventListener('click', (e) => {
    e.stopPropagation() // jangan ikut toggle popover
    const b = $<HTMLButtonElement>('usage-refresh')
    if (b.disabled) return
    b.disabled = true
    b.classList.add('spin')
    void window.grove
      .refreshUsage()
      .then(renderUsage)
      .catch(() => {})
      .finally(() => setTimeout(() => {
        b.disabled = false
        b.classList.remove('spin')
      }, 10_000))
  })
  document.addEventListener('click', () => {
    $('usage-panel').classList.remove('show')
    $('acct-panel').classList.remove('show')
    $('tools-panel').classList.remove('show')
    closeSessionMenu()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSessionMenu()
  })
  // Scroll yang BENAR-BENAR memindahkan kartu (sidebar/dokumen) membuat posisi menu salah → tutup.
  // BUG YANG DIPERBAIKI: dulu listener ini menangkap SEMUA scroll (capture=true), termasuk auto-scroll
  // #chat-log yang terjadi tiap potongan streaming. Akibatnya saat sesi sedang jalan, menu klik-kanan
  // ditutup ulang beberapa kali per detik → terlihat "kedip-kedip" dan seolah tak bisa dibuka.
  window.addEventListener(
    'scroll',
    (e) => {
      const t = e.target as (HTMLElement & { closest?: (s: string) => Element | null }) | Document | null
      if (t && t !== document && !(t as HTMLElement).closest?.('#tree')) return
      closeSessionMenu()
    },
    true
  )

  // Panel REQUEST: default TERTUTUP (logCollapsed=true) — isi chat sudah lengkap, panel ini alat
  // diagnosa. Terapkan state awalnya ke DOM supaya caret & isi tak pernah beda dari variabelnya.
  $('log-tree').hidden = logCollapsed
  $('log-caret').textContent = logCollapsed ? '▸' : '▾'
  $('log-head').addEventListener('click', () => {
    logCollapsed = !logCollapsed
    $('log-tree').hidden = logCollapsed
    $('log-caret').textContent = logCollapsed ? '▸' : '▾'
  })

  $('btn-accounts').addEventListener('click', (e) => {
    e.stopPropagation()
    $('tools-panel').classList.remove('show') // jangan tumpang-tindih dengan panel Tools
    const p = $('acct-panel')
    if (p.classList.toggle('show')) renderAccountsPanel()
  })
  $('acct-panel').addEventListener('click', (e) => e.stopPropagation()) // klik di dalam panel jangan menutup

  $('btn-tools').addEventListener('click', (e) => {
    e.stopPropagation()
    $('acct-panel').classList.remove('show') // jangan tumpang-tindih dengan panel Akun
    $('usage-panel').classList.remove('show')
    const p = $('tools-panel')
    if (p.classList.toggle('show')) renderToolsPanel()
  })
  $('tools-panel').addEventListener('click', (e) => e.stopPropagation()) // klik di dalam panel jangan menutup

  // Drag-reorder sidebar (dengar global agar terus terlacak walau kursor keluar node).
  document.addEventListener('pointermove', onDragMove)
  document.addEventListener('pointerup', onDragEnd)
  document.addEventListener('pointercancel', onDragEnd)

  const doSend = async (): Promise<void> => {
    const input = $<HTMLTextAreaElement>('chat-input')
    const text = input.value.trim()
    const images = pendingImages.slice()
    const refs = pendingRefs.slice()
    // Sedang mengedit pesan yang MASIH ANTRI → simpan perubahannya ke antrian, jangan kirim baru.
    // (Kalau item itu sudah terlanjur terkirim, editQueued balikan false → jatuh jadi prompt baru.)
    if (editingQid != null && activeId) {
      const qid = editingQid
      const saved = await window.grove.editQueued(activeId, qid, text).catch(() => false)
      if (saved) {
        input.value = ''
        autoGrow(input)
        resetHistoryNav()
        renderQueueStrip()
        input.focus()
        return
      }
      setEditingQid(null) // sudah dijawab/terkirim → lanjut sebagai prompt baru
    }
    if (!text && images.length === 0 && refs.length === 0) return
    resetHistoryNav()
    input.value = ''
    autoGrow(input)
    pendingImages = []
    pendingRefs = []
    renderAttachStrip()
    // Referensi = TITIK MASUK, bukan perintah baca-semua. Kalimat lama ("baca file/folder ini")
    // membuat agen menelan seluruh isi folder ke konteks — dibayar penuh sekali lalu dikirim ulang
    // tiap giliran. Sekarang eksplisit: cari dulu, baca seperlunya.
    const refBlock = refs.length
      ? `Referensi — titik masuk, BUKAN bahan bacaan wajib. Untuk folder: cari dulu (Glob/Grep) lalu baca hanya bagian yang relevan; jangan membaca seluruh isinya:\n${refs
          .map((p) => `- ${p}`)
          .join('\n')}\n\n`
      : ''
    const freshChat = async (): Promise<string> => {
      const meta = await window.grove.newChat()
      ensureNode(meta)
      activeId = meta.id // set aktif langsung (tanpa await getChat) supaya kirim tidak terhambat
      $('chat-log').textContent = ''
      toolDetailEls.clear()
      logReset()
      pendingEl = null
      pendingTextNode = null
      pendingText = ''
      updateChatHeader()
      updateActiveHighlight()
      return meta.id
    }
    try {
      // Target = session aktif yang MASIH ADA. Bila null/stale (mis. baru dihapus) → buat baru.
      const targetId = activeId && nodes.has(activeId) ? activeId : await freshChat()
      drafts.delete(targetId) // pesan terkirim DARI sesi ini → draft-nya tak berlaku lagi
      updateNodeVisual(targetId) // hapus penanda ✎ bila sempat ada
      // Tempel "grove:ref:<id>" ke kolom chat = tautkan referensi (bukan kirim pesan).
      if (/^grove:ref:/i.test(text)) {
        linkReferenceFromText(targetId, text)
        input.focus()
        return
      }
      // /btw <pertanyaan> — tanya sisipan: dijawab query TERPISAH, tak masuk antrian & konteks sesi
      // utama, jadi aman ditanyakan saat sesi sedang bekerja. Lampiran tidak ikut (ini kanal tanya).
      const btw = /^\/btw\b\s*([\s\S]*)$/.exec(text)
      if (btw) {
        const question = btw[1].trim()
        if (!question) {
          appendChatMessage({
            role: 'side',
            text: 'Pakai: /btw <pertanyaan> — dijawab di samping, tanpa mengganggu pekerjaan sesi ini.',
            ts: Date.now()
          })
        } else {
          await window.grove.askSide(targetId, question)
        }
        input.focus()
        return
      }
      try {
        await window.grove.sendChat(targetId, refBlock + text, images)
        rememberSent(targetId, { text, sent: refBlock + text, images, refs })
      } catch (err) {
        // Sesi target ternyata sudah tak ada (race dgn hapus) → buat chat baru & kirim ulang sekali.
        if (String(err).includes('tidak ditemukan')) {
          await window.grove.sendChat(await freshChat(), refBlock + text, images)
        } else {
          throw err
        }
      }
    } catch (err) {
      const m: ChatMessage = { role: 'system', text: `⚠️ Gagal kirim: ${String(err)}`, ts: Date.now() }
      appendChatMessage(m)
      alert(`Gagal kirim: ${String(err)}`)
    }
    input.focus()
  }

  const inputEl = $<HTMLTextAreaElement>('chat-input')
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault()
    void doSend()
  })
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault() // Enter kirim; Shift+Enter baris baru
      void doSend()
      return
    }
    // ↑/↓ = telusuri riwayat prompt, HANYA saat kursor di ujung (biar tetap bisa navigasi teks
    // multi-baris seperti biasa) atau kolom masih kosong.
    if (e.key === 'ArrowUp' && (inputEl.selectionStart === 0 || histIdx >= 0)) {
      e.preventDefault()
      navigateHistory(1)
      renderQueueStrip()
      return
    }
    if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault()
      navigateHistory(-1)
      renderQueueStrip()
      return
    }
    if (e.key === 'Escape' && histIdx >= 0) {
      e.preventDefault()
      inputEl.value = histDraft
      resetHistoryNav()
      renderQueueStrip()
      autoGrow(inputEl)
    }
  })
  inputEl.addEventListener('input', () => autoGrow(inputEl))
  inputEl.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    let handled = false
    for (const it of Array.from(items)) {
      if (!it.type.startsWith('image/')) continue
      const file = it.getAsFile()
      if (!file) continue
      handled = true
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result)
        pendingImages.push({ mediaType: file.type, data: url.slice(url.indexOf(',') + 1) })
        renderAttachStrip()
      }
      reader.readAsDataURL(file)
    }
    if (handled) e.preventDefault() // jangan tempel teks path
  })

  // Auto-scroll berhenti saat kamu menggulir ke atas, nyala lagi saat kembali ke dasar.
  $('chat-log').addEventListener('scroll', syncChatScrollState, { passive: true })
  $('chat-jump').addEventListener('click', () => {
    scrollChatToBottom(true)
    $<HTMLInputElement>('chat-input').focus()
  })

  // ESC = BATALKAN PESAN TERAKHIR & kembalikan ke kolom ketik (teks + gambar + referensi).
  // Ditangani di fase CAPTURE supaya tetap jalan saat fokus ada di kolom ketik, tapi mengalah pada
  // dua pemakaian Esc yang sudah ada: navigasi riwayat prompt (↑) dan menu klik-kanan.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (histIdx >= 0) return // Esc sedang dipakai membatalkan navigasi riwayat
      if (document.querySelector('.ctx-menu') || document.querySelector('.modal-back')) return
      if (!activeId) return
      void cancelLastMessage(activeId)
    },
    true
  )

  // Ketik di mana saja → langsung masuk kolom chat.
  window.addEventListener('keydown', (e) => {
    const ae = document.activeElement
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return
    $<HTMLInputElement>('chat-input').focus()
  })

  // Klik area chat → fokus kolom (kecuali sedang menyeleksi teks untuk disalin).
  // TAPI jangan mencuri fokus dari kontrol interaktif di header (select model, tombol): mencuri
  // fokus tepat saat <select> mau membuka membuatnya langsung menutup lagi → "dropdown tak bisa diklik".
  $('chat').addEventListener('mouseup', (e) => {
    const t = e.target as HTMLElement | null
    if (t?.closest('select, button, input, textarea, option')) return
    if (!window.getSelection()?.toString()) $<HTMLInputElement>('chat-input').focus()
  })

  $<HTMLInputElement>('chat-input').focus() // fokus saat app dibuka

  // timer live untuk durasi turn yang sedang berjalan
  setInterval(() => {
    if (!activeId) return
    const node = nodes.get(activeId)
    const start = turnStart.get(activeId)
    if (node?.status === 'running' && start) {
      lastElapsed.set(activeId, Date.now() - start)
      updateChatHeader()
    }
  }, 1000)

  window.grove.onEvent(onEvent)
  setupColumnResizers() // kolom bisa di-resize + pulihkan lebar tersimpan
  // Prefetch daftar model OpenRouter sekali → dropdown/menu model sesi OR langsung terisi.
  void window.grove
    .listOpenRouterModels(true)
    .then((l) => {
      orModels = l
      if (activeId) updateChatHeader()
    })
    .catch(() => {})
  syncUsageSession() // sebelum ada sesi terpilih → akun default (login utama)
  void window.grove
    .listAccounts()
    .then((r) => {
      accounts = r.accounts
      autoSwitch = r.autoSwitch
      autoResume = r.autoResume
      defaultSwitchPct = r.defaultSwitchPct
      defaultAccountId = r.defaultAccountId
      visionAccountId = r.visionAccountId
      accountOrder = r.accountOrder ?? []
      defaultModel = r.defaultModel
      defaultEffort = r.defaultEffort
      syncGlobalModel()
      syncGlobalEffort()
      // Startup tanpa akun sama sekali → beri tahu SEKARANG, jangan tunggu user gagal kirim pesan.
      if (!accounts.length) {
        showAuthBanner({ sessionTitle: '', tokenMissing: false, hasAccounts: false })
      }
    })
    .catch(() => {})

  const snap = await window.grove.getSnapshot()
  const flatten = (n: TreeNode): void => {
    const { children, board: b, ctxPercent, ...meta } = n
    nodes.set(meta.id, { ...(meta as SessionMeta), ctxPercent, tokensTotal: 0 })
    if (b) board.set(meta.id, b)
    for (const c of children) flatten(c)
  }
  for (const t of snap.trees) flatten(t)
  for (const b of snap.board) board.set(b.sessionId, b)
  memories.push(...(snap.memories ?? [])) // tahan skew HMR: main lama belum kirim memories
  renderTree()
  renderBoard()
  for (const m of snap.messages) addInbox(m)
  renderMemories()
  if (snap.trees.length) void selectSession(snap.trees[0].id)
}

void init()
