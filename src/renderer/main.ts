import type {
  Account,
  BoardEntry,
  ChatMessage,
  GroveEvent,
  ImageAttachment,
  InboxMessage,
  Memory,
  OpenRouterModel,
  SessionMeta,
  TreeNode,
  UsageSnapshot,
  UsageUnavailable,
  UsageWindow
} from '../shared/types'
import { MODEL_OPTIONS, modelLabel, OPENROUTER_MODEL_SUGGESTIONS } from '../shared/types'

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
let defaultAccountId: string | null = null // akun global (dipakai pohon yang tak menentukan sendiri)
let defaultModel: string | null = null // model global (dipakai sesi yang tak menentukan sendiri)
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
    default:
      return 'Gagal menghubungi server limit. Dicoba lagi otomatis.'
  }
}

/**
 * Angka usage SELALU diberi identitas akun pemiliknya (email kalau bisa didapat, kalau
 * tidak label) — tanpa itu user tak bisa tahu "5-jam 19%" milik akun mana. usage null =
 * tak diketahui untuk akun tsb; kita tampilkan "—" + alasannya, BUKAN angka akun
 * sebelumnya (itu bug lamanya).
 */
function renderUsage(snap: UsageSnapshot): void {
  const box = $('usage')
  const panel = $('usage-panel')
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
    box.title = `${whoTitle} — pemakaian tak bisa dibaca. Klik untuk detail.`
    box.innerHTML = `${acct}<span class="ubar-mini"><span class="ulabel">usage</span><span class="uval">—</span></span>`
    panel.innerHTML =
      `<div class="up-title">BATAS PEMAKAIAN · ${who}</div>` +
      `<div class="up-empty">${escapeHtml(usageReasonText(snap.reason))}<br><br>Angka akun lain sengaja TIDAK ditampilkan di sini agar tidak menyesatkan.</div>`
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

function scrollChatToBottom(): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const log = $('chat-log')
    log.scrollTop = log.scrollHeight
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
    selectSession(node.id)
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

function confirmDelete(id: string): void {
  const n = nodes.get(id)
  const kids = countDescendants(id)
  const extra = kids ? ` beserta ${kids} sub-session` : ''
  if (!confirm(`Hapus session "${n?.title ?? id}"${extra}?`)) return
  // Terapkan segera dari id yang dikembalikan (jangan tunggu event) → tutup race "target basi".
  window.grove
    .deleteSession(id)
    .then(applyRemoved)
    .catch((err) => alert(`Gagal hapus: ${String(err)}`))
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
  const history = await window.grove.getChat(id)
  // Balapan async: kalau pilihan berubah selama getChat berjalan (klik sesi lain, ATAU sesi ini
  // dihapus lalu applyRemoved auto-pindah ke sesi lain), JANGAN tempel riwayat basi ke chat-log
  // yang kini menampilkan sesi berbeda. Tanpa guard ini, menghapus sesi (yang memicu auto-pindah)
  // bisa "menyuntik" riwayat sesi lama/terhapus ke chat sesi aktif → chat tampak rusak lintas-sesi.
  if (activeId !== id) return
  for (const m of history.slice(-MAX_CHAT_DOM)) appendChatMessage(m, false) // hanya N terakhir → anti-lag
  log.scrollTop = log.scrollHeight
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

/** Isi <select> model dengan MODEL_OPTIONS sekali; return elemennya. */
function fillModelOptions(sel: HTMLSelectElement, inheritLabel?: string): void {
  sel.textContent = ''
  for (const m of MODEL_OPTIONS) {
    const o = document.createElement('option')
    o.value = m.value
    // Untuk per-sesi, opsi kosong berarti "mewarisi", bukan "Default SDK" — beri tahu warisannya apa.
    o.textContent = m.value === '' && inheritLabel ? inheritLabel : m.label
    sel.append(o)
  }
}

/** Dropdown model GLOBAL di topbar → set nilai dari state. */
function syncGlobalModel(): void {
  const sel = $<HTMLSelectElement>('global-model')
  if (!sel.options.length) {
    fillModelOptions(sel)
    sel.addEventListener('change', () => {
      void window.grove.setDefaultModel(sel.value || null).catch((e) => alert(`Gagal set model global: ${String(e)}`))
    })
  }
  sel.value = defaultModel ?? ''
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
  const eff = effectiveAccountOf(node)
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
    fillModelOptions(sel, inheritedModelFor(node))
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
  const modelSel = $<HTMLSelectElement>('chat-model')
  if (node) {
    const act = activities.get(activeId!) || node.status
    const elapsed = fmtDuration(lastElapsed.get(activeId!) ?? 0)
    telem.textContent = `⏱ ${elapsed} · ↓ ${fmtTokens(node.tokensTotal ?? 0)} tokens · ${act}`
    stopBtn.style.display = node.status === 'running' ? 'inline-block' : 'none'
    compactBtn.style.display = node.role === 'root' ? 'inline-block' : 'none' // hanya UTAMA
    loopBtn.style.display = node.role === 'root' ? 'inline-block' : 'none' // hanya UTAMA
    loopBtn.classList.toggle('on', !!node.loopActive)
    loopBtn.textContent = node.loopActive ? '🔁 Auto ON' : '🔁 Auto'
    // Dropdown model per-sesi, PROVIDER-AWARE: akun OpenRouter → daftar model OR (bisa dipilih bebas),
    // akun Claude → alias + warisan. Opsi kosong = ikut warisan / default akun.
    modelSel.style.display = 'inline-block'
    fillSessionModelSelect(modelSel, node)
    modelSel.onchange = (): void => {
      void window.grove
        .setSessionModel(node.id, modelSel.value || null)
        .catch((e) => alert(`Gagal ganti model: ${String(e)}`))
    }
  } else {
    telem.textContent = ''
    stopBtn.style.display = 'none'
    compactBtn.style.display = 'none'
    loopBtn.style.display = 'none'
    modelSel.style.display = 'none'
  }
}

function ensureNode(meta: SessionMeta, ctxPercent = 0): void {
  if (!nodes.has(meta.id)) {
    nodes.set(meta.id, { ...meta, ctxPercent, tokensTotal: 0 })
    renderTree()
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
    // Baris tool: klik header untuk expand/collapse detail (input + output), ala Ctrl+O.
    const caret = el('span', { class: 'tool-caret' }, '▸')
    const head = el('div', { class: 'tool-head' }, caret, el('span', {}, ` ${m.text}`))
    const pre = document.createElement('pre')
    pre.className = 'tool-detail'
    pre.hidden = true
    pre.textContent = m.detail
    head.addEventListener('click', () => {
      pre.hidden = !pre.hidden
      caret.textContent = pre.hidden ? '▸' : '▾'
      if (!pre.hidden) scrollChatToBottom()
    })
    node.append(head, pre)
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

function autoGrow(el: HTMLTextAreaElement): void {
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
    const tag = a.provider === 'openrouter' ? '  ⟨OR⟩' : ''
    menu.append(item(a.label + tag, node.accountId === a.id, () => setSessionAccount(node.id, a.id)))
  }

  // --- Model ---
  menu.append(el('div', { class: 'ctx-sep' }, 'Model'))
  const eff = effectiveAccountOf(node)
  if (eff?.provider === 'openrouter') {
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
      // Badge provider: akun OpenRouter ditandai jelas + model yang dipakainya.
      const provTag =
        a.provider === 'openrouter'
          ? el('span', { class: 'ap-prov', title: a.model ?? '' }, `OR: ${a.model?.split('/').pop() ?? '?'}`)
          : el('span', {})
      panel.append(
        el('div', { class: 'ap-item' }, el('span', { class: 'ap-label' }, a.label), provTag, planTag, del)
      )

      // Akun OpenRouter (mis. model gratis) tak punya kuota gaya Claude → ambang tak relevan; lewati.
      if (a.provider === 'openrouter') continue

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
  // Pilih provider: Claude (langganan) atau OpenRouter (key + model).
  const prov = document.createElement('select')
  prov.className = 'ap-input'
  for (const [v, t] of [
    ['claude', 'Claude (langganan)'],
    ['openrouter', 'OpenRouter (key + model)']
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

  // Field khusus OpenRouter: id model (dengan saran gratis) — hanya tampil bila provider = openrouter.
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
  fillDatalist(OPENROUTER_MODEL_SUGGESTIONS.map((m) => ({ value: m.id, text: m.label })))
  void window.grove
    .listOpenRouterModels(true)
    .then((list) => {
      if (!list.length) return // fetch gagal → biarkan saran statis
      const fmtCtx = (n: number): string => (n >= 1e6 ? `${n / 1e6}M` : `${Math.round(n / 1000)}K`)
      fillDatalist(
        list.map((m) => ({
          value: m.id,
          text: `${m.name} · ${m.paramB || '?'} · ${fmtCtx(m.context)} ctx`
        }))
      )
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
    const or = prov.value === 'openrouter'
    token.placeholder = or ? 'OpenRouter API key (sk-or-v1-…)' : 'CLAUDE_CODE_OAUTH_TOKEN (sk-ant-oat01-…)'
    orModel.style.display = or ? 'block' : 'none'
    plan.style.display = or ? 'none' : 'block'
    hint.textContent = or
      ? '⚠️ OpenRouter hanya MENJAMIN Claude Code untuk model Anthropic. Model lain (mis. Nemotron) bisa saja tak patuh protokol tool Grove — uji dulu di satu sesi sebelum diandalkan. Kuota gaya Claude tak berlaku (auto-switch/ambang diabaikan).'
      : 'Token `claude setup-token` didukung penuh: menjalankan sesi maupun memantau kuota (usage dibaca dari header rate-limit bila endpoint resmi menolak).'
  }
  prov.addEventListener('change', applyProvider)

  const add = el('button', { class: 'ap-add' }, '+ Tambah akun')
  add.addEventListener('click', () => {
    const l = label.value.trim()
    const t = token.value.trim()
    const or = prov.value === 'openrouter'
    const p = !or && Number(plan.value) > 0 ? Number(plan.value) : undefined
    const m = or ? orModel.value.trim() : undefined
    if (!l || !t) return alert('Isi label & token/key dulu.')
    if (or && !m) return alert('Isi id model OpenRouter (mis. nvidia/nemotron-3-super-120b-a12b:free).')
    void window.grove
      .addAccount(l, t, p, undefined, or ? 'openrouter' : 'claude', m)
      .then(() => {
        label.value = ''
        token.value = ''
        plan.value = ''
        orModel.value = ''
      })
      .catch((e) => alert(`Gagal tambah: ${String(e)}`))
  })
  panel.append(prov, label, token, orModel, datalist, hint, plan, add)
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

// ---- events ----------------------------------------------------------------

function onEvent(ev: GroveEvent): void {
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
      break
    }
    case 'chat:detail': {
      if (ev.payload.id !== activeId) break
      const pre = toolDetailEls.get(ev.payload.toolUseId)
      if (pre) pre.textContent = ev.payload.detail // sisipkan output tool yang baru tiba
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
      defaultModel = ev.payload.defaultModel
      syncGlobalModel()
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
    $('usage-panel').classList.toggle('show')
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
    closeSessionMenu()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSessionMenu()
  })
  // Scroll di sidebar / window → posisi menu jadi salah; tutup saja.
  window.addEventListener('scroll', closeSessionMenu, true)

  $('btn-accounts').addEventListener('click', (e) => {
    e.stopPropagation()
    const p = $('acct-panel')
    if (p.classList.toggle('show')) renderAccountsPanel()
  })
  $('acct-panel').addEventListener('click', (e) => e.stopPropagation()) // klik di dalam panel jangan menutup

  // Drag-reorder sidebar (dengar global agar terus terlacak walau kursor keluar node).
  document.addEventListener('pointermove', onDragMove)
  document.addEventListener('pointerup', onDragEnd)
  document.addEventListener('pointercancel', onDragEnd)

  const doSend = async (): Promise<void> => {
    const input = $<HTMLTextAreaElement>('chat-input')
    const text = input.value.trim()
    const images = pendingImages.slice()
    const refs = pendingRefs.slice()
    if (!text && images.length === 0 && refs.length === 0) return
    input.value = ''
    autoGrow(input)
    pendingImages = []
    pendingRefs = []
    renderAttachStrip()
    const refBlock = refs.length
      ? `Referensi (baca file/folder ini untuk konteks):\n${refs.map((p) => `- ${p}`).join('\n')}\n\n`
      : ''
    const freshChat = async (): Promise<string> => {
      const meta = await window.grove.newChat()
      ensureNode(meta)
      activeId = meta.id // set aktif langsung (tanpa await getChat) supaya kirim tidak terhambat
      $('chat-log').textContent = ''
      toolDetailEls.clear()
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
      try {
        await window.grove.sendChat(targetId, refBlock + text, images)
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
      defaultModel = r.defaultModel
      syncGlobalModel()
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
