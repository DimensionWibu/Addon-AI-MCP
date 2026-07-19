import type {
  Account,
  BoardEntry,
  ChatMessage,
  GroveEvent,
  ImageAttachment,
  InboxMessage,
  Memory,
  SessionMeta,
  TreeNode,
  UsageInfo,
  UsageWindow
} from '../shared/types'

let pendingImages: ImageAttachment[] = []
let pendingRefs: string[] = [] // path file/folder referensi

type Node = SessionMeta & { ctxPercent: number; tokensTotal: number; loopActive?: boolean; apiStopped?: boolean }

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
let activeId: string | null = null
let pendingEl: HTMLElement | null = null
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
  { wrap: HTMLElement; dot: HTMLElement; badge: HTMLElement; title: HTMLElement; act: HTMLElement; time: HTMLElement }
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
let lastUsageShown: UsageInfo | null = null

function renderUsage(u: UsageInfo | null): void {
  const box = $('usage')
  const panel = $('usage-panel')
  if (!u) {
    // Jangan kosongkan kalau sudah pernah ada nilai — biarkan last-good tetap tampil.
    if (lastUsageShown) return
    box.textContent = ''
    panel.textContent = ''
    return
  }
  lastUsageShown = u
  box.classList.toggle('stale', !!u.stale)
  box.title = u.stale
    ? 'Data terakhir (refresh gagal — token mungkin sedang di-refresh). Klik untuk detail.'
    : 'Klik untuk detail limit'
  // top bar: mini bars 5-jam + minggu
  const mini = (label: string, w?: UsageWindow): string => {
    const v = w?.utilization ?? null
    const val = v != null ? Math.round(v) : 0
    return `<span class="ubar-mini"><span class="ulabel">${label}</span><span class="ubar"><span class="ufill ${ufillClass(v)}" style="width:${val}%"></span></span><span class="uval">${v != null ? val + '%' : '—'}</span></span>`
  }
  box.innerHTML = mini('5-jam', u.fiveHour) + mini('minggu', u.sevenDay)

  // panel detail (ala halaman Usage web)
  const row = (name: string, w?: UsageWindow): string => {
    const v = w?.utilization ?? null
    if (v == null) return ''
    const val = Math.round(v)
    return `<div class="up-row"><div class="up-head"><span class="up-name">${name}<span class="up-reset">${fmtResetIn(w?.resetsAt ?? null)}</span></span><span class="up-pct">${val}% terpakai</span></div><div class="up-bar"><span class="up-fill ${ufillClass(v)}" style="width:${val}%"></span></div></div>`
  }
  let html = `<div class="up-title">BATAS PEMAKAIAN</div>`
  html += row('Sesi saat ini (5 jam)', u.fiveHour)
  html += row('Mingguan — semua model', u.sevenDay)
  html += row('Mingguan — Opus', u.sevenDayOpus)
  html += row('Mingguan — Sonnet', u.sevenDaySonnet)
  if (u.monthly?.enabled) html += row('Bulanan (kredit)', { utilization: u.monthly.utilization, resetsAt: null })
  html += `<div class="up-updated">Update: ${new Date(u.fetchedAt).toLocaleTimeString()}${u.stale ? ' · data terakhir (refresh gagal)' : ''}</div>`
  panel.innerHTML = html
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
  if (!pendingEl) {
    shownLen = 0
    return
  }
  if (shownLen < pendingText.length) {
    const remaining = pendingText.length - shownLen
    // kecepatan ungkap menyesuaikan backlog (min 1/frame → selalu mengalir & tak tertinggal)
    shownLen = Math.min(pendingText.length, shownLen + Math.max(1, Math.ceil(remaining / 12)))
    pendingEl.textContent = pendingText.slice(0, shownLen)
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
        'Klik "+ Chat" atau langsung ketik untuk mulai. "+ Folder" untuk sesi proyek. Drag file/folder ke jendela = tambah referensi.'
      )
    )
    return
  }
  for (const r of roots) renderNode(r, 0, tree)
}

function renderNode(node: Node, depth: number, container: HTMLElement): void {
  const wrap = el('div', {
    class: `node${depth > 0 ? ' child' : ''}${activeId === node.id ? ' active' : ''}`
  })
  wrap.style.marginLeft = `${depth * 14}px`
  wrap.dataset.id = node.id
  wrap.onclick = () => {
    if (performance.now() < suppressClickUntil) return // klik pasca-drag → jangan pilih
    selectSession(node.id)
  }
  wrap.addEventListener('pointerdown', (e) => onNodePointerDown(e, node)) // tekan-tahan → geser

  const dot = el('span', { class: `dot s-${node.status}` })
  const title = el('span', { class: 'node-title' }, node.title)
  const badge = el('span', { class: badgeClass(node.ctxPercent) }, `${node.ctxPercent}%`)
  const del = el('button', { class: 'node-del', title: 'Hapus session' }, '×')
  del.onclick = (e) => {
    e.stopPropagation()
    confirmDelete(node.id)
  }
  const row = el('div', { class: 'node-row' }, dot, title, badge, del)
  const act = el('span', { class: 'node-act' }, activities.get(node.id) ?? '')
  const time = el('span', { class: 'node-time' }, '')
  const meta = el(
    'div',
    { class: 'node-meta' },
    el('span', { class: `role-tag ${node.role}` }, node.role === 'root' ? 'UTAMA' : 'SUB'),
    el('span', { class: 'node-id' }, shortId(node.id)),
    act,
    time
  )
  wrap.append(row, meta)
  container.append(wrap)
  nodeEls.set(node.id, { wrap, dot, badge, title, act, time })
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
  refs.badge.textContent = `${n.ctxPercent}%`
  refs.badge.className = badgeClass(n.ctxPercent)
  refs.wrap.classList.toggle('active', activeId === id)
  refs.wrap.classList.toggle('api-stopped', !!n.apiStopped) // dihentikan API Claude → judul merah
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
  const active = n.status === 'running' || n.status === 'waiting'
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
    pendingText = ''
    $('chat-log').textContent = ''
    toolDetailEls.clear()
    renderMemories()
    updateChatHeader()
  }
}

// ---- chat ------------------------------------------------------------------

async function selectSession(id: string): Promise<void> {
  activeId = id
  pendingEl = null
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
  badge.textContent = `ctx ${node.ctxPercent}%`
  badge.className = badgeClass(node.ctxPercent)
}

function updateChatHeader(): void {
  const node = activeId ? nodes.get(activeId) : null
  $('chat-title').textContent = node ? `${node.title} · ${shortId(activeId!)}` : 'Belum ada session'
  updateChatBadge()
  const telem = $('chat-telem')
  const stopBtn = $('btn-stop')
  const compactBtn = $('btn-compact')
  const loopBtn = $('btn-loop')
  if (node) {
    const act = activities.get(activeId!) || node.status
    const elapsed = fmtDuration(lastElapsed.get(activeId!) ?? 0)
    telem.textContent = `⏱ ${elapsed} · ↓ ${fmtTokens(node.tokensTotal ?? 0)} tokens · ${act}`
    stopBtn.style.display = node.status === 'running' ? 'inline-block' : 'none'
    compactBtn.style.display = node.role === 'root' ? 'inline-block' : 'none' // hanya UTAMA
    loopBtn.style.display = node.role === 'root' ? 'inline-block' : 'none' // hanya UTAMA
    loopBtn.classList.toggle('on', !!node.loopActive)
    loopBtn.textContent = node.loopActive ? '🔁 Auto ON' : '🔁 Auto'
  } else {
    telem.textContent = ''
    stopBtn.style.display = 'none'
    compactBtn.style.display = 'none'
    loopBtn.style.display = 'none'
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

  panel.append(el('div', { class: 'ap-head' }, 'Tersimpan'))
  if (!accounts.length) {
    panel.append(el('div', { class: 'ap-empty' }, 'Belum ada akun.'))
  } else {
    for (const a of accounts) {
      const del = el('button', { class: 'ap-del', title: 'Hapus akun' }, '×')
      del.addEventListener('click', () => {
        if (confirm(`Hapus akun "${a.label}"?`)) void window.grove.deleteAccount(a.id).catch((e) => alert(String(e)))
      })
      panel.append(el('div', { class: 'ap-item' }, el('span', { class: 'ap-label' }, a.label), del))
    }
  }

  panel.append(el('div', { class: 'ap-head' }, 'Tambah akun'))
  const label = document.createElement('input')
  label.className = 'ap-input'
  label.placeholder = 'Label (mis. Kantor Max20)'
  const token = document.createElement('textarea')
  token.className = 'ap-input ap-token'
  token.placeholder = 'Token dari `claude setup-token`'
  token.rows = 2
  const add = el('button', { class: 'ap-add' }, '+ Tambah akun')
  add.addEventListener('click', () => {
    const l = label.value.trim()
    const t = token.value.trim()
    if (!l || !t) return alert('Isi label & token dulu.')
    void window.grove
      .addAccount(l, t)
      .then(() => {
        label.value = ''
        token.value = ''
      })
      .catch((e) => alert(`Gagal tambah: ${String(e)}`))
  })
  panel.append(label, token, add)

  const node = activeId ? nodes.get(activeId) : null
  if (node) {
    panel.append(el('div', { class: 'ap-head' }, `Sesi aktif: ${node.title}`))
    const sel = document.createElement('select')
    sel.className = 'ap-input'
    const def = document.createElement('option')
    def.value = ''
    def.textContent = 'Default (login utama)'
    sel.append(def)
    for (const a of accounts) {
      const o = document.createElement('option')
      o.value = a.id
      o.textContent = a.label
      sel.append(o)
    }
    sel.value = node.accountId ?? ''
    sel.addEventListener('change', () => {
      void window.grove
        .setSessionAccount(node.id, sel.value || null)
        .catch((e) => alert(`Gagal ganti akun: ${String(e)}`))
    })
    panel.append(el('div', { class: 'ap-row' }, el('span', {}, 'Akun sesi: '), sel))
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
      }
      break
    }
    case 'chat:delta': {
      if (ev.payload.id !== activeId) break
      if (!pendingEl) {
        pendingEl = appendChatMessage({ role: 'assistant', text: '', ts: Date.now() }, false)
        pendingText = ''
        shownLen = 0
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
      if ($('acct-panel').classList.contains('show')) renderAccountsPanel()
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
  })
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = Math.max(0, depth - 1)
    if (depth === 0) show(false)
  })
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    depth = 0
    show(false)
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
  document.addEventListener('click', () => {
    $('usage-panel').classList.remove('show')
    $('acct-panel').classList.remove('show')
  })

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
      pendingText = ''
      updateChatHeader()
      updateActiveHighlight()
      return meta.id
    }
    try {
      // Target = session aktif yang MASIH ADA. Bila null/stale (mis. baru dihapus) → buat baru.
      const targetId = activeId && nodes.has(activeId) ? activeId : await freshChat()
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
  $('chat').addEventListener('mouseup', () => {
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
  void window.grove.getUsage().then(renderUsage).catch(() => {})
  void window.grove
    .listAccounts()
    .then((r) => {
      accounts = r.accounts
      autoSwitch = r.autoSwitch
      autoResume = r.autoResume
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
