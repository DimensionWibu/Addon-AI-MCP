// Satu Session = satu query() SDK berumur panjang (streaming input multi-turn).
// Bertanggung jawab: kirim pesan user, streaming output ke UI, hitung token/context,
// simpan riwayat chat, update status di DB.

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ChatMessage,
  GroveEvent,
  ImageAttachment,
  SessionMeta,
  SessionRole,
  SessionStatus
} from '../../shared/types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Board } from './db'
import { buildGroveServer, type GroveHost } from './mcpTools'
import { contextPercent, contextWindowFor } from './contextWindows'
import { groveAppend } from './prompts'

/**
 * Path claude.exe untuk app TERPAKET. Di dalam paket, SDK menunjuk binary yang berada
 * DI DALAM app.asar — file di arsip asar tak bisa dieksekusi ("exists but failed to launch").
 * electron-builder sudah menyalinnya ke app.asar.unpacked (lihat asarUnpack di package.json),
 * jadi arahkan SDK ke salinan nyata itu. Di dev path ini tak ada → undefined → SDK pakai default.
 */
function packagedClaudeExecutable(): string | undefined {
  const rp = process.resourcesPath
  if (!rp) return undefined
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const p = join(
    rp,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    bin
  )
  return existsSync(p) ? p : undefined
}
const CLAUDE_EXE = packagedClaudeExecutable()

/** Potong string 1-baris agar rapi di daftar chat. */
function short(v: unknown, max = 140): string {
  if (v == null) return ''
  const t = (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/**
 * Ringkas satu tool_use jadi baris informatif untuk chat, mis:
 *   → Read src/main/orchestrator/Session.ts
 *   → Grep "spawnWorker" (*.ts)
 *   → grove:report_progress Membaca prefs engine…
 * Supaya user tahu persis session lagi ngapain, bukan cuma nama tool.
 */
function summarizeTool(name = 'tool', input?: Record<string, unknown>): string {
  const i = input ?? {}
  const label = name.startsWith('mcp__grove__') ? `grove:${name.slice('mcp__grove__'.length)}` : name
  let detail = ''
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      detail = short(i.file_path ?? i.path ?? i.notebook_path)
      break
    case 'Grep':
      detail = short(i.pattern) + (i.glob ? ` (${short(i.glob, 40)})` : i.path ? ` in ${short(i.path, 60)}` : '')
      break
    case 'Glob':
      detail = short(i.pattern) + (i.path ? ` in ${short(i.path, 60)}` : '')
      break
    case 'Bash':
      detail = short(i.command, 160)
      break
    case 'Task':
    case 'Agent':
      detail = short(i.description ?? i.subagent_type)
      break
    case 'WebFetch':
    case 'WebSearch':
      detail = short(i.url ?? i.query)
      break
    default:
      if (name.startsWith('mcp__grove__')) {
        // Untuk tool Grove, tampilkan field paling informatif (progress/summary/title/…).
        detail = short(
          i.progress ?? i.summary ?? i.title ?? i.task ?? i.body ?? i.worker_id ?? i.scope ?? ''
        )
      } else {
        detail = short(i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.query ?? i.description ?? '')
      }
  }
  return detail ? `→ ${label} ${detail}` : `→ ${label}`
}

/** Potong string panjang dengan penanda. */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} char dipotong)` : s
}

/** Input tool lengkap, dirapikan untuk panel expand (string multi-baris tetap apa adanya). */
function formatToolInput(input?: Record<string, unknown>): string {
  const entries = Object.entries(input ?? {})
  if (!entries.length) return '(tanpa argumen)'
  return entries
    .map(([k, v]) => {
      if (typeof v === 'string') return v.includes('\n') ? `${k}:\n${clip(v, 6000)}` : `${k}: ${clip(v, 2000)}`
      return `${k}: ${clip(JSON.stringify(v), 2000)}`
    })
    .join('\n')
}

/** Ambil teks dari content tool_result (string, array blok teks/gambar, atau objek). */
function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        const o = c as { type?: string; text?: string }
        if (o?.type === 'text') return o.text ?? ''
        if (o?.type === 'image') return '[image]'
        return JSON.stringify(c)
      })
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

const MAX_TRANSIENT_RETRIES = 3 // auto-retry beruntun error koneksi transient sebelum menyerah
const AUTO_COMPACT_HIGH = 88 // ctx% ambang ATAS: picu auto-compact (cegah freeze saat konteks nyaris penuh)
const AUTO_COMPACT_LOW = 70 // ctx% ambang BAWAH: baru boleh mempersenjatai ulang auto-compact (hysteresis anti-thrash)
const DELTA_FLUSH_MS = 40 // B2: coalesce token stream → satu emit chat:delta per interval ini (bukan per token)
const CTX_PERSIST_MS = 2000 // B3: throttle tulis ctx/usage ke DB; angka ephemeral, nilai final disimpan saat turn selesai

/** Apakah error menandakan batas pemakaian/rate-limit (pemicu auto-switch akun). */
function isLimitError(raw: string): boolean {
  return /rate_limit|429|usage|quota|exceed|limit reached|out of/i.test(raw)
}

/**
 * Pemberitahuan limit langganan yang datang sebagai TEKS asisten, mis:
 *   "You've hit your session limit · resets 4:20pm (Asia/Jakarta)"
 *   "You've reached your weekly limit"
 * Pola sengaja SPESIFIK (bukan sekadar kata "limit") agar tidak salah-picu saat model
 * kebetulan membahas kata limit dalam jawabannya.
 */
function isLimitNotice(text: string): boolean {
  return /(hit|reached|exceeded)\s+your\s+[\w\s-]*limit|(session|weekly|usage|5-hour|five-hour)\s+limit\b[^\n]{0,40}\bresets?\b|limit\s*·\s*resets/i.test(
    text
  )
}

/**
 * Error KONEKSI TRANSIENT yang layak dicoba-ulang otomatis: koneksi diputus/timeout, atau upstream
 * 5xx / provider sementara tak tersedia. SANGAT sering di OpenRouter free (kapasitas bersama drop
 * koneksi di tengah stream). SENGAJA TIDAK mencakup:
 *  - limit langganan (429/quota/"limit reached") → itu urusan isLimitError/onLimitHit.
 *  - error FATAL (401/403 auth, 404 model tak ada) → retry percuma, harus diberitahu ke user.
 */
export function isTransientError(raw: string): boolean {
  if (/\b(401|403|404)\b|unauthorized|forbidden|not\s*found|invalid.?api.?key|no\s+access/i.test(raw)) return false
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|connection (was )?(lost|reset|closed|error)|network error|fetch failed|premature close|provider_unavailable|\b(502|503|504|529)\b|bad gateway|service unavailable|gateway time|overloaded/i.test(
    raw
  )
}

/** Apakah pesan menandakan blokir keamanan API Claude (pemicu recycle sesi). */
function isApiBlock(raw: string): boolean {
  return /safety measures that flagged|flagged this message for a|Cyber Verification Program|cybersecurity topic/i.test(
    raw
  )
}

/**
 * Heuristik "turn berhenti menunggu jawaban/konfirmasi user/parent". Dipakai karena app memakai
 * bypassPermissions (tak ada permission-prompt yang menahan giliran) → satu-satunya sinyal realistis
 * adalah ISI penutup pesan asisten.
 *
 * TIGA LAPIS, sengaja BEDA LEBAR JENDELA supaya sensitif tapi tetap rendah false-positive:
 *  L1  '?' pada baris TERAKHIR                  → sinyal terkuat ("Lanjut?", "Which one?").
 *  L2  BLOK PILIHAN di ~8 baris terakhir        → daftar bernomor/berpoin (≥2 item) + pemicu
 *      serah-keputusan ("pilih satu", "bola di kamu", "mana yang", …). Ini yang menangkap kasus
 *      nyata: permintaan keputusan ada di TENGAH pesan ("Bola di kamu, pilih satu:" + daftar 1..4)
 *      sementara baris penutupnya justru kalimat PERNYATAAN tanpa '?' — versi lama (jendela 2 baris)
 *      melewatkannya.
 *  L3a FRASA SPESIFIK/memblokir di ~8 baris terakhir ("bilang saja", "menunggu keputusan",
 *      "saya berhenti dulu", "tanpa izin", "butuh akses dari kamu", …) — cukup spesifik untuk
 *      dicari di jendela lebar.
 *  L3b FRASA GENERIK ("apakah", "konfirmasi", "mau saya", "confirm", "proceed") DIBATASI ke 3 baris
 *      penutup saja — kata-kata ini gampang muncul sambil lalu, jadi jendelanya sengaja sempit
 *      (praktis mempertahankan perilaku lama).
 *
 * Sengaja TIDAK menyala untuk ringkasan penyelesaian biasa ("Selesai. Semua tes lulus.") karena
 * tak ada '?', blok pilihan, maupun frasa memblokir. Tawaran langkah lanjutan yang TIDAK memblokir
 * ("Kalau mau, saya bisa lanjut ke X") juga tidak menyala — kasus abu-abu sengaja DICONDONGKAN ke
 * TIDAK menyala; kalau asisten memang menunggu, ia hampir selalu menutup dgn '?' atau frasa L3.
 * Catatan: "bilang saja" adalah anggota paling rawan di L3a (kadang cuma basa-basi penutup), tapi
 * dimasukkan atas permintaan eksplisit karena muncul di kasus nyata. Biayanya rendah: kedip hilang
 * begitu ada giliran baru (beginTurn), dan SET-nya masih dijaga cleanEnd + inbox kosong.
 */
export function looksLikeAwaitingInput(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  const lines = t
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return false

  // L1 — baris terakhir diakhiri tanda tanya.
  if (/\?\s*$/.test(lines[lines.length - 1])) return true

  const tailLines = lines.slice(-8) // jendela LEBAR: blok pilihan + frasa spesifik
  const tail = tailLines.join(' ')
  const closing = lines.slice(-3).join(' ') // jendela SEMPIT: frasa generik

  // L2 — blok pilihan: daftar ≥2 item bernomor/berpoin + pemicu serah-keputusan.
  // Pemicu sengaja berupa frasa IMPERATIF/serah-keputusan, BUKAN kata benda generik seperti
  // "opsi"/"pilihan" — kalau tidak, changelog berpoin ("menambah 3 opsi baru:") ikut salah-picu.
  const listItems = tailLines.filter((l) => /^(\d+[.)]|[-*•])\s+\S/.test(l)).length
  const handover =
    /(pilih satu|pilih salah satu|silakan pilih|pilihanmu|bola di (kamu|anda)|terserah (kamu|anda)|mana yang|pick one|choose one|your call|up to you|which (one|option))/i
  if (listItems >= 2 && handover.test(tail)) return true

  // L3a — frasa SPESIFIK/memblokir (aman di jendela lebar).
  // "kabari" sengaja diikat ke bentuk yang DITUJUKAN KE USER ("kabari saya/ya/kalau"), supaya
  // "nanti saya kabari hasilnya" (asisten yang memberi tahu) tidak salah-picu.
  // "begitu"/"setelah" DIBUANG: "saya kabari begitu/setelah X" = asisten MELAPOR nanti (bukan
  // menunggu) — persis false-positive "Nanti saya kabari begitu worker lapor" yang bikin kedip kuning.
  const STRONG_ID =
    /(bilang saja|kabari (saya|aku|ya|kalau|kalo)|beri ?tahu saya|tunggu kabar|(menunggu|nunggu) (jawaban|keputusan|konfirmasi|instruksi|arahan|persetujuan)|saya berhenti dulu|tanpa izin|butuh (akses|kredensial|password|token|izin) dari (kamu|anda)|bola di (kamu|anda)|pilih satu|pilih salah satu|silakan pilih|pilihanmu|\b(y\/n|ya\/tidak|iya\/tidak)\b)/i
  const STRONG_EN =
    /\b(let me know|waiting for (your )?(input|confirmation|answer|decision|reply)|please (confirm|choose|clarify|advise|decide)|should i|would you like|do you want|which (one|option))\b/i
  if (STRONG_ID.test(tail) || STRONG_EN.test(tail)) return true

  // L3b — frasa GENERIK: hanya pada 3 baris penutup (jendela sempit = anti false-positive).
  const WEAK_ID =
    /(mau saya|boleh saya|apakah\b|konfirmasi|setuju\b|pilih (yang )?mana|mau yang mana|butuh (jawaban|keputusan|konfirmasi|persetujuan)|tolong (konfirmasi|pilih|pastikan|putuskan))/i
  const WEAK_EN = /\b(confirm|proceed)\b/i
  return WEAK_ID.test(closing) || WEAK_EN.test(closing)
}

/** Ubah error/subtype mentah jadi pesan ramah + apakah masih bisa dilanjut. */
function friendlyError(raw: string): string {
  const s = raw.toLowerCase()
  if (s.includes('rate_limit') || s.includes('429'))
    return 'Kena rate limit. Tunggu sebentar, lalu kirim pesan lagi.'
  if (s.includes('overloaded') || s.includes('529'))
    return 'Server Claude sedang overload. Coba kirim lagi sebentar lagi.'
  if (s.includes('roles must alternate'))
    return 'Urutan pesan sempat tak sinkron. Kirim pesan lagi — akan disusun ulang & lanjut.'
  if (s.includes('authentication') || s.includes('401'))
    return 'Autentikasi bermasalah. Pastikan Claude Code masih login (jalankan `claude` sekali).'
  if (s.includes('permission') || s.includes('403'))
    return 'Akses ditolak (model/fitur tidak tersedia untuk akunmu). Coba ganti model.'
  if (s.includes('refus'))
    return 'Claude menolak permintaan ini (kebijakan konten). Ubah/rephrase lalu kirim lagi.'
  if (s.includes('max_turns')) return 'Turn mencapai batas maksimum langkah.'
  if (s.includes('budget')) return 'Batas biaya turn tercapai.'
  if (s.includes('invalid_request')) return 'Request tidak valid. Kirim pesan lagi.'
  return `Error: ${raw}`
}

// CATATAN: perakitan env provider (Claude vs OpenRouter) dipindah ke SessionManager.getSessionLaunch
// supaya Session tak perlu tahu detail tiap provider. options.env MENGGANTI seluruh env subprocess
// (bukan merge) → manager sudah spread process.env di sana. Dalam urutan auth Claude Code,
// ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN MENGALAHKAN CLAUDE_CODE_OAUTH_TOKEN — itu justru dipakai
// untuk provider OpenRouter, dan dibuang untuk provider Claude (lihat getSessionLaunch).

/** Antrian async untuk streaming input: user mengetik → dorong ke query yang sedang jalan. */
export class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private resolvers: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false

  push(content: string | unknown[]): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: content as never },
      parent_tool_use_id: null
    }
    const r = this.resolvers.shift()
    if (r) r({ value: msg, done: false })
    else this.queue.push(msg)
  }

  close(): void {
    this.closed = true
    let r
    while ((r = this.resolvers.shift())) r({ value: undefined as never, done: true })
  }

  /**
   * Lepas resolver yang masih "parkir" (menunggu next()) milik iterator query LAMA yang sudah
   * mati. Query streaming tetap hidup antar-turn dengan iterator terparkir di inbox.next(); saat
   * query di-restart memakai inbox yang sama (ganti akun, recycle blokir API, compact, autoResume),
   * resolver lama itu tertinggal di sini. Tanpa dibuang, push() berikutnya nyasar ke iterator mati
   * (resolvers.shift() mengambilnya) → pesan HILANG & query baru menggantung → "ganti akun / lanjut
   * tidak jalan". Dipanggil tepat sebelum query baru dibuat. Antrian pesan (queue) DIBIARKAN utuh.
   */
  resetConsumers(): void {
    this.resolvers.length = 0
  }

  /**
   * Buang pesan yang masih ter-antri (belum dikonsumsi). Dipakai saat reuse worker untuk tugas
   * BARU yang independen (resetForNewTask): antrian topik lama tak boleh nyasar ke sesi fresh.
   * Berbeda dari resetConsumers() yang sengaja MEMBIARKAN queue utuh (ganti akun/compact).
   */
  clearQueue(): void {
    this.queue.length = 0
  }

  /** Masih ada pesan ter-antri (belum dikonsumsi)? Dipakai deteksi "benar-benar menunggu input". */
  hasPending(): boolean {
    return this.queue.length > 0
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.queue.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.resolvers.push(resolve))
      }
    }
  }
}

export class Session {
  readonly meta: SessionMeta
  private readonly inbox = new AsyncMessageQueue()
  private readonly history: ChatMessage[] = []
  private q: ReturnType<typeof query> | null = null
  private stopped = false
  private started = false
  private tokensTotal = 0 // token output kumulatif (ala counter CLI)
  private toolRows = new Map<string, { rowId: number; input: string }>() // tool_use_id → baris + input
  private pendingCompactSeed: string | null = null // ringkasan compact, dieksekusi saat turn selesai
  private reseedText: string | null = null // disisipkan ke pesan berikutnya setelah konteks dipadatkan
  private lastUserPrompt = '' // prompt terakhir (untuk diulang saat recycle akibat blokir API)
  private apiRetries = 0 // berapa kali recycle akibat blokir API (maks 3)
  private apiStopped = false // dihentikan API Claude setelah 3× → judul merah
  private apiBlockPending = false // blokir API terdeteksi → recycle di akhir turn
  private limitHitPending = false // limit pemakaian terdeteksi → auto-switch akun di akhir turn
  private limitStreak = 0 // pindah akun beruntun akibat limit tanpa turn sukses (guard anti-loop)
  private transientPending = false // error koneksi transient (ECONNRESET/5xx) → auto-retry di akhir turn
  private transientSeen = false // teks asisten menyebut error koneksi transient pada turn ini
  private transientRetries = 0 // retry transient beruntun tanpa turn sukses (guard anti-loop; reset saat sukses)
  private retryTimer: NodeJS.Timeout | null = null // timer backoff auto-retry (di-clear saat stop)
  private compactArmed = true // auto-compact hanya menyala bila konteks NYATA pernah turun < LOW (hysteresis anti-thrash)
  private compactStreak = 0 // compact beruntun tanpa turn yang berakhir < LOW (guard anti-freeze; lihat limitStreak)
  private compactWarned = false // peringatan "konteks tetap penuh" sudah dikirim untuk streak ini (anti-spam)
  // --- jaminan runtime "worker selesai → parent tahu" (lihat host.notifyTurnEnd) ---
  private lastAssistantText = '' // teks asisten TERAKHIR pada turn berjalan = hasil kerja worker
  private turnText = '' // AKUMULASI semua blok teks asisten pada turn ini = hasil PENUH utk handoff ke parent
  private finalReportSent = false // worker SUDAH lapor final (report_to_parent 100%) untuk turn ini → jangan dobel
  private interrupting = false // turn dihentikan PAKSA (Stop All/compact/ganti akun) → bukan "selesai wajar"
  private awaitingInput = false // turn berhenti wajar & penutupnya pertanyaan → nunggu jawaban user/parent (kartu kedip kuning)
  private doneMarked = false // tugas dinyatakan TUNTAS (task_done root / sub lapor 100%) → akhiri turn sbg 'done', bukan 'idle'
  // --- B2: coalesce token stream — tampung text_delta, emit sekali per DELTA_FLUSH_MS (kurangi banjir IPC per-token) ---
  private deltaBuf = ''
  private deltaTimer: NodeJS.Timeout | null = null
  private lastCtxPersist = 0 // B3: kapan terakhir ctx/usage ditulis ke DB (throttle persist)
  /** Waktu terakhir API merespons (dari applyUsage). Dipakai SessionManager untuk tahu kapan cache perlu di-warm. */
  lastApiActivity = 0

  constructor(
    meta: SessionMeta,
    private readonly db: Board,
    private readonly host: GroveHost,
    private readonly emit: (ev: GroveEvent) => void
  ) {
    this.meta = meta
  }

  getHistory(): ChatMessage[] {
    return this.history
  }

  /** Mulai query berumur panjang (lazy). Bila meta.sdkSessionId ada → resume (lanjut konteks). */
  start(initialTask?: string): void {
    if (this.started) {
      if (initialTask) this.sendUserMessage(initialTask)
      return
    }
    this.started = true
    // Buang resolver parkir dari query SEBELUMNYA (mis. sesudah ganti akun/recycle/compact) —
    // kalau tidak, pesan pertama ke query baru ini akan nyasar ke iterator mati & menggantung.
    this.inbox.resetConsumers()
    // Mode LITE (CLI-parity): TANPA MCP grove (0 dari 13 tool orkestrasi) & TANPA append protokol
    // multi-agent → prefix prompt = preset claude_code polos, hemat ~3k token/giliran + tak ada
    // mandat bookkeeping yang memicu giliran ekstra. Orkestrasi (spawn/board) memang tak ada di sini.
    const lite = !!this.meta.lite
    // Akun EFEKTIF: akun sesi ini → akun sesi utama pohon → akun global. Dihitung SEKARANG (bukan
    // disalin saat sesi lahir) supaya ganti akun di sesi utama langsung berlaku ke sub-sesinya.
    // launch berisi env provider (Claude vs OpenRouter) + model efektif; null = tak ada token.
    const launch = this.host.getSessionLaunch(this.meta.id)
    // GROVE BERJALAN MURNI DENGAN TOKEN AKUN GUI. Tidak ada lagi jalur diam-diam ke login CLI
    // (~/.claude/.credentials.json): dulu, sesi tanpa accountId membuat opsi `env` di bawah tak
    // di-set sama sekali sehingga CLI memakai akun login utama — kerja jalan, tapi tagihannya
    // mendarat di akun yang tak pernah user pilih di GUI. Sekarang token WAJIB ada; kalau tidak,
    // sesi berhenti dengan pesan jelas. App-nya sendiri tetap hidup & bisa dipakai (kelola akun,
    // baca riwayat) — yang berhenti hanya sesi ini.
    if (!launch) {
      this.started = false
      this.record({
        role: 'system',
        text: this.meta.accountId
          ? '⛔ Akun yang dipasang ke sesi ini tidak punya TOKEN (akun terhapus/token kosong). Sesi dihentikan agar tidak diam-diam menagih akun lain. Tambahkan ulang tokennya di ⚙ Akun.'
          : '⚠️ Sesi ini belum dipasangi akun Claude. Buka ⚙ Akun, tambahkan token (CLAUDE_CODE_OAUTH_TOKEN), lalu pilih akun untuk sesi ini. Setelah itu kirim pesanmu lagi.',
        ts: Date.now()
      })
      this.setStatus('error')
      this.emitActivity(this.meta.accountId ? 'akun tanpa token' : 'belum ada akun')
      this.host.onAccountMissing(this.meta.id)
      return
    }
    this.q = query({
      prompt: this.inbox,
      options: {
        // Model EFEKTIF: untuk akun Claude = model sesi → sesi utama → global → default SDK; untuk
        // akun OpenRouter = id model akun itu (dihitung di getSessionLaunch).
        model: launch.model,
        cwd: this.meta.cwd,
        includePartialMessages: true,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: lite ? '' : groveAppend(this.meta.role),
          // CATATAN (diverifikasi di sdk.d.ts:1943-1947): opsi ini TIDAK membuang apa pun. Ia hanya
          // MEMINDAHKAN seksi dinamis (working-dir, auto-memory, git-status) keluar dari system
          // prompt lalu menyuntikkannya kembali sebagai pesan user PERTAMA — tujuannya agar prefix
          // prompt tetap statis & bisa di-cache, BUKAN menyembunyikan memori. Jadi flag ini bukan
          // alat isolasi memori; isolasi ditangani lewat cwd unik per-tree (scratch per chat baru,
          // lihat src/main/ipc.ts) karena direktori memori diturunkan dari cwd.
          excludeDynamicSections: true
        },
        // EKSPLISIT (sebelumnya dibiarkan kosong → ikut default SDK yang memuat SEMUA sumber).
        // Nilai sah: 'user' | 'project' | 'local' (sdk.d.ts:6538). Ketiganya SENGAJA dinyalakan agar
        // perilaku PERSIS sama dengan default lama, tapi terprediksi & kebal perubahan default SDK:
        //   'user'    = ~/.claude/settings.json  → instruksi global user tetap berlaku
        //   'project' = .claude/settings.json    → WAJIB ada agar berkas CLAUDE.md dimuat (sdk.d.ts:1881)
        //   'local'   = .claude/settings.local.json
        // Sengaja TIDAK memakai [] (mode isolasi SDK): user memang menghendaki CLAUDE.md + memori —
        // yang tak diinginkan hanyalah memori LINTAS-PROJECT, dan itu sudah diatasi oleh cwd per-tree.
        settingSources: ['user', 'project', 'local'],
        // LITE → jangan pasang MCP grove: 13 skema tool (~1.5-2k token) tak ikut tiap request.
        ...(lite ? {} : { mcpServers: { grove: buildGroveServer(this.meta.id, this.host) } }),
        // Env provider sudah dirakit di getSessionLaunch (Claude → CLAUDE_CODE_OAUTH_TOKEN; OpenRouter
        // → ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN), sudah termasuk spread process.env.
        env: launch.env,
        ...(CLAUDE_EXE ? { pathToClaudeCodeExecutable: CLAUDE_EXE } : {}), // paket: pakai binary unpacked
        resume: this.meta.sdkSessionId // lanjut konteks bila session dimuat ulang dari DB
      }
    })
    if (initialTask) this.sendUserMessage(initialTask)
    void this.consume()
  }

  /** Tandai untuk compact: konteks dipadatkan saat turn berjalan selesai (dari tool save_compaction). */
  scheduleCompact(summary: string): void {
    this.pendingCompactSeed = summary
  }

  private doCompact(): void {
    const summary = this.pendingCompactSeed
    this.pendingCompactSeed = null
    if (summary) this.compactWith(summary)
  }

  /**
   * Padatkan konteks LANGSUNG (tanpa giliran model): lepas sesi SDK lama (drop resume),
   * turunkan ctx% ke 0, dan siapkan ringkasan untuk disisipkan ke pesan berikutnya.
   * Menghentikan turn yang sedang jalan (mis. macet karena konteks penuh) → membebaskan sesi.
   * Dipakai tombol Compact (ringkasan dari board) & tool save_compaction (ringkasan model).
   */
  compactWith(summary: string): void {
    if (!summary) return
    this.flushDelta() // B2: keluarkan sisa token & batalkan timer sebelum konteks dipotong
    this.interrupting = true // turn dipotong paksa → jangan dianggap "worker selesai"
    this.reseedText = summary
    this.meta.sdkSessionId = undefined // start berikutnya FRESH (tanpa resume) → konteks lama dilepas
    this.resetCtx() // ctx% turun ke 0 seketika
    this.compactArmed = false // jangan auto-compact lagi sampai konteks NYATA turun < LOW (anti-thrash)
    this.compactStreak++ // hitung compact beruntun → guard anti-freeze bila konteks tetap penuh
    this.db.upsertSession(this.meta)
    this.started = false
    const q = this.q
    this.q = null
    try {
      void q?.interrupt?.()
    } catch {
      /* abaikan */
    }
    this.record({
      role: 'system',
      text: '⟲ Konteks dipadatkan (compact). Ringkasan tugas disimpan ke Memori — pesan berikutnya melanjutkan dari ringkasan.',
      ts: Date.now()
    })
    this.setStatus('idle')
    this.emitActivity('idle')
  }

  /**
   * REUSE worker untuk tugas BARU yang TIDAK berkaitan: buang percakapan SDK topik lama
   * (drop resume) TANPA menghapus slot/id/title worker (UI tetap dipakai ulang). Query lama
   * dihentikan, sdkSessionId dikosongkan → start() berikutnya MINT session_id BARU
   * (resume: undefined, lihat start()) sehingga CLI tak membawa transkrip lama; ctx% balik 0.
   * Beda dari compactWith: TIDAK ada ringkasan yang di-seed — konteks benar-benar bersih.
   * Ini penawar cross-topic "sub kebawa topik sibling" saat orchestrator me-reuse worker.
   */
  resetForNewTask(): void {
    if (this.stopped) return
    this.flushDelta() // B2: keluarkan sisa token & batalkan timer sebelum konteks direset
    this.interrupting = true // stream/turn lama dipotong paksa → BUKAN "worker selesai"
    this.setAwaitingInput(false) // konteks direset utk tugas baru → kedip lama tak relevan
    this.reseedText = null // tak ada carry-over ringkasan
    this.meta.sdkSessionId = undefined // start berikutnya FRESH (tanpa resume) → transkrip lama dilepas
    this.resetCtx() // ctx% turun ke 0 seketika
    this.compactArmed = true // konteks fresh → auto-compact boleh menyala lagi nanti
    this.compactStreak = 0
    this.compactWarned = false
    this.db.upsertSession(this.meta)
    this.started = false
    const q = this.q
    this.q = null
    try {
      void q?.interrupt?.() // hentikan query long-lived lama (juga cegah interleave bila worker masih running)
    } catch {
      /* abaikan */
    }
    this.inbox.clearQueue() // buang pesan topik lama yang masih ter-antri
    this.toolRows.clear() // korelasi tool_use lama tak relevan lagi
    this.history.length = 0 // bersihkan riwayat in-memory (row DB/UI tetap ada)
    this.record({
      role: 'system',
      text: '🧹 Konteks worker direset untuk tugas baru yang independen — percakapan sebelumnya tidak dibawa.',
      ts: Date.now()
    })
    this.setStatus('idle')
    this.emitActivity('idle')
  }

  /** Sisipkan ringkasan memori (sekali) di depan teks setelah compact, agar konteks nyambung. */
  private withReseed(text: string): string {
    if (!this.reseedText) return text
    const seed = this.reseedText
    this.reseedText = null
    return `[MEMORI TERKOMPAK — ringkasan konteks sebelumnya]\n${seed}\n\n---\n${text}`
  }

  /**
   * Awal satu giliran baru → reset pelacak laporan-final. Dipanggil di SETIAP jalur yang
   * mendorong pekerjaan baru (pesan user, tugas dari orkestrator, auto-check, resume).
   */
  private beginTurn(): void {
    // Turn baru (user kirim / auto-task / retry sendiri) menggantikan retry yang tertunda → batalkan
    // timernya supaya tak memicu giliran dobel.
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    this.lastAssistantText = ''
    this.turnText = ''
    this.finalReportSent = false
    this.interrupting = false
    this.transientSeen = false // giliran baru → deteksi error transient dimulai dari nol
    this.lastCtxPersist = 0 // B3: giliran baru → usage pertama turn ini dipersist segera (angka ctx fresh)
    this.setAwaitingInput(false) // kerja baru masuk (user/parent menindak) → matikan kedip kuning
    this.doneMarked = false // ada tugas baru → tak lagi "tuntas" (status balik running/idle)
  }

  /** Dipanggil host saat worker memanggil report_to_parent dgn percent 100 → auto-report jangan dobel. */
  markFinalReported(): void {
    this.finalReportSent = true
  }

  /** Kirim pesan user (opsional dengan gambar); start otomatis bila dormant. */
  sendUserMessage(text: string, images?: ImageAttachment[]): void {
    this.beginTurn()
    this.lastUserPrompt = text // prompt user SEBELUM kena flag → diulang saat recycle
    this.apiRetries = 0 // prompt baru → reset hitungan recycle
    this.limitStreak = 0 // prompt user baru → reset rantai pindah-akun akibat limit
    this.setApiStopped(false)
    text = this.withReseed(text)
    if (!this.started) {
      this.start()
      // start() dibatalkan (mis. akun tanpa token → cegah salah-billing): simpan pesan user supaya
      // tak hilang, tapi JANGAN tandai running / dorong ke query yang tidak ada.
      if (!this.started) {
        this.record({ role: 'user', text, ts: Date.now() })
        return
      }
    }
    const dataUrls = (images ?? []).map((im) => `data:${im.mediaType};base64,${im.data}`)
    this.record({ role: 'user', text, ts: Date.now(), images: dataUrls.length ? dataUrls : undefined })
    this.setStatus('running')
    this.emitActivity('berpikir…')
    if (images?.length) {
      const content: unknown[] = []
      if (text) content.push({ type: 'text', text })
      for (const im of images) {
        content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })
      }
      this.inbox.push(content)
    } else {
      this.inbox.push(text)
    }
  }

  /**
   * Inject instruksi otomatis (mis. permintaan rangkuman progres dari worker) ke query.
   * Masuk konteks SDK sebagai giliran user, TAPI tidak direkam ke chat/DB agar UI tetap bersih —
   * yang tampil ke user cukup BALASAN root-nya. Start bila dormant (resume, konteks nyambung).
   */
  injectAutoTask(text: string): void {
    if (this.stopped) return
    this.beginTurn()
    text = this.withReseed(text)
    if (!this.started) {
      this.start()
      if (!this.started) return // start dibatalkan (akun tanpa token) → jangan tandai running
    }
    this.setStatus('running')
    this.emitActivity('menyusun update progres…')
    this.inbox.push(text)
  }

  /** Auto-check berkala: tampilkan nota "udah sampe mana?" (biar terlihat) lalu inject promptnya. */
  autoCheck(prompt: string): void {
    if (this.stopped) return
    this.record({ role: 'system', text: '🔁 Auto-check berkala: "udah sampe mana?"', ts: Date.now() })
    this.injectAutoTask(prompt)
  }

  /**
   * Cache warm: inject prompt minimal untuk menjaga prefix ter-cache di API (Pro TTL 1 jam).
   * TIDAK merekam ke chat/DB (injectAutoTask); model hanya balas 1 kata → biaya output minimal.
   * Dipanggil SessionManager saat sesi idle mendekati batas TTL cache.
   */
  cacheWarm(): void {
    if (this.stopped) return
    this.record({ role: 'system', text: '🔄 Cache prefix di-refresh', ts: Date.now() })
    this.injectAutoTask('[GROVE CACHE-WARM] Prefix cache refresh. Reply with exactly one word: OK — no tools, no analysis, no other text.')
  }

  /** Saat app dibuka lagi: sesi yang tadinya kerja → resume konteks & dorong lanjut. */
  autoResume(): void {
    if (this.stopped || this.started) return
    this.record({ role: 'system', text: '▶ Melanjutkan sesi yang terputus saat aplikasi ditutup…', ts: Date.now() })
    // Sertakan ringkasan tugas dari board: kalau sesi ini fresh (tanpa resume), dia tetap tahu
    // harus melanjutkan apa — bukan sekadar disuruh "lanjutkan" tanpa konteks.
    const b = this.db.getBoardEntry(this.meta.id)
    const ctx: string[] = []
    if (b?.summary) ctx.push(`Tujuan & kondisi terakhir: ${b.summary}`)
    if (b?.progress) ctx.push(`Terakhir dikerjakan: ${b.progress}`)
    if (b?.todo?.length) ctx.push(`Checklist: ${b.todo.map((t) => `${t.done ? '✓' : '○'} ${t.text}`).join('; ')}`)
    const seed = ctx.length ? `\n\n${ctx.join('\n')}` : ''
    this.injectAutoTask(
      `Lanjutkan pekerjaan sebelumnya yang terputus saat aplikasi ditutup. Mulai dari titik terakhir, jangan mengulang dari awal.${seed}`
    )
  }

  private emitActivity(activity: string): void {
    this.emit({ channel: 'session:activity', payload: { id: this.meta.id, activity } })
  }

  /**
   * B2 — coalesce token stream. Tampung tiap text_delta ke buffer; emit SATU chat:delta tergabung
   * per DELTA_FLUSH_MS. Memangkas jumlah IPC/serialisasi per-token (besar saat banyak sesi paralel)
   * tanpa mengubah urutan/keutuhan teks. WAJIB flushDelta() sebelum blok difinalkan (chat:message)
   * & saat turn berakhir agar tak ada token tertinggal / stray-emit setelah finalisasi.
   */
  private queueDelta(text: string): void {
    this.deltaBuf += text
    if (!this.deltaTimer) this.deltaTimer = setTimeout(() => this.flushDelta(), DELTA_FLUSH_MS)
  }

  /** Kirim buffer delta yang tertampung (bila ada) sebagai satu event; batalkan timer. Aman dipanggil kapan saja. */
  private flushDelta(): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer)
      this.deltaTimer = null
    }
    if (!this.deltaBuf) return
    const delta = this.deltaBuf
    this.deltaBuf = ''
    this.emit({ channel: 'chat:delta', payload: { id: this.meta.id, delta } })
  }

  /** Simpan ke riwayat in-memory + DB + kirim ke UI. Kembalikan rowid DB. (Gambar tak dipersist.) */
  private record(m: ChatMessage): number {
    this.history.push(m)
    const dbText = m.text || (m.images?.length ? '🖼️ [gambar]' : '')
    const rowId = this.db.addChatMessage(this.meta.id, m.role, dbText, m.ts, m.detail)
    this.emit({ channel: 'chat:message', payload: { id: this.meta.id, message: m } })
    return rowId
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null } // batalkan auto-retry yang tertunda
    this.flushDelta() // B2: keluarkan sisa token & batalkan timer saat sesi ditutup
    this.interrupting = true // ditutup paksa → bukan "turn selesai wajar"
    this.setAwaitingInput(false) // sesi ditutup → kedip jangan nyangkut
    this.inbox.close()
    try {
      await this.q?.interrupt?.()
    } catch {
      /* abaikan */
    }
    this.setStatus('done')
  }

  /**
   * Tandai tugas TUNTAS → status 'done' (dot hijau) TANPA menutup sesi seperti stop():
   * inbox tetap terbuka, jadi tugas/pesan berikutnya masih bisa masuk (sendUserMessage akan
   * mengembalikannya ke 'running'). Dipanggil orkestrator: root saat task_done, sub saat lapor 100%.
   * Karena kedua pemanggil itu terjadi DI TENGAH turn (tool call), status baru diterapkan saat turn
   * berakhir (lihat handler 'result') — kalau langsung dipasang di sini, setStatus('idle') di akhir
   * turn akan menimpanya, dan dot juga akan "hijau" padahal sesi masih bekerja.
   */
  markDone(): void {
    if (this.stopped) return
    this.doneMarked = true
    if (this.meta.status !== 'running') this.setStatus('done') // tak ada turn jalan → langsung tampak
  }

  private setStatus(status: SessionStatus): void {
    if (this.meta.status === status) return
    this.meta.status = status
    this.meta.updatedAt = Date.now()
    this.db.upsertSession(this.meta)
    this.emit({ channel: 'session:update', payload: { id: this.meta.id, status } })
  }

  private async consume(): Promise<void> {
    const myQ = this.q // query yang dikonsumsi loop INI — dibandingkan di finally (anti-clobber)
    if (!myQ) return
    try {
      for await (const msg of myQ) {
        this.handle(msg as Record<string, unknown> & { type: string })
      }
    } catch (e) {
      const raw = String(e)
      // INTERUPSI DISENGAJA (ganti akun/model via restartQuery, atau stop) → BUKAN error. Kalau tidak
      // dibedakan, error interupsi (mis. koneksi ke subprocess "premature close") salah dikira transient
      // → memicu auto-retry siluman yang mengacaukan chat berikutnya ("habis ganti akun gak bisa chat").
      // apiBlock/limit punya flag sendiri (di-set sebelum interupsi) & TIDAK men-set `interrupting`,
      // jadi jalur itu tetap jalan lewat cabang di bawah.
      if (this.interrupting || this.stopped) {
        /* disengaja — abaikan, jangan tandai error/transient/limit */
      } else if (isApiBlock(raw)) this.apiBlockPending = true
      else if (isLimitError(raw)) this.limitHitPending = true // limit via exception → auto-switch (didahulukan)
      else if (isTransientError(raw) || this.transientSeen) this.transientPending = true // koneksi putus → auto-retry
      else {
        console.error(`[Session ${this.meta.id}] error:`, e)
        this.record({
          role: 'system',
          text: `⚠️ ${friendlyError(raw)}  (session tetap bisa dilanjut — kirim pesan lagi)`,
          ts: Date.now()
        })
        this.setStatus('error')
      }
    } finally {
      // Reset state HANYA bila query yang berakhir ini MASIH query aktif sesi. resetForNewTask()/
      // compact/ganti-akun bisa SUDAH mengganti this.q dgn query BARU (start()-nya men-set
      // started=true & this.q=queryBaru). Tanpa guard ini, finally query LAMA meng-clobber
      // started→false & q→null → pesan berikutnya men-spawn query DUPLIKAT (zombie subprocess),
      // teks handoff turn baru ke-wipe, & tombol Stop tak menjangkau turn yang jalan.
      if (this.q === myQ) {
        this.turnText = '' // query berhenti → jangan bawa akumulasi turn ke query berikutnya
        // Query mati (error/blokir/selesai). Bila bukan karena stop manual, izinkan
        // restart: pesan berikutnya akan start() ulang dengan resume → konteks nyambung.
        if (!this.stopped) {
          this.started = false
          this.q = null
          if (this.meta.status === 'running') this.setStatus('idle')
        }
        // Error koneksi transient → auto-retry (resume konteks), didahulukan sebelum limit/apiblock
        // karena ini gangguan sesaat yang paling mungkin sukses bila diulang.
        if (this.transientPending && !this.stopped) {
          this.transientPending = false
          this.scheduleTransientRetry()
        }
        // Setelah state di-reset: bila kena limit, minta orkestrator auto-switch akun (bila aktif).
        if (this.limitHitPending && !this.stopped) {
          this.limitHitPending = false
          this.host.onLimitHit(this.meta.id)
        }
        // Bila terdeteksi blokir API → recycle (reset konteks + ulang tugas terakhir).
        if (this.apiBlockPending && !this.stopped) {
          this.apiBlockPending = false
          this.handleApiBlock()
        }
      }
    }
  }

  /**
   * Ganti akun berlaku efektif: token dibaca saat start(). Kalau session sedang jalan,
   * hentikan query lama (konteks/sdkSessionId dipertahankan) → pesan berikutnya resume
   * dengan token akun baru. Kalau sudah dormant, tak perlu apa-apa (start berikutnya sudah pakai baru).
   */
  /** Interupsi query yang sedang jalan; pesan berikutnya RESUME dgn konfigurasi baru (akun/model).
   *  sdkSessionId dipertahankan → konteks tak hilang, hanya token/model yang berganti. */
  restartQuery(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null } // ganti akun/model → batalkan retry lama
    // Restart DISENGAJA bukan kegagalan koneksi → buang jejak transient supaya tak ada auto-retry siluman.
    this.transientPending = false
    this.transientSeen = false
    this.transientRetries = 0
    if (!this.started) return
    this.flushDelta() // B2: keluarkan sisa token & batalkan timer sebelum restart
    this.interrupting = true // turn dipotong paksa demi ganti konfig → bukan "worker selesai"
    this.started = false
    const q = this.q
    this.q = null
    try {
      void q?.interrupt?.()
    } catch {
      /* abaikan */
    }
    this.setStatus('idle')
    this.emitActivity('idle')
  }

  /** Blokir API terdeteksi → hentikan turn agar consume().finally menjalankan recycle. */
  private flagApiBlock(): void {
    if (this.apiStopped || this.apiBlockPending) return
    this.apiBlockPending = true
    try {
      void this.q?.interrupt?.()
    } catch {
      /* abaikan */
    }
  }

  /**
   * Limit pemakaian terdeteksi (dari error field pesan assistant / result / exception).
   * Hentikan turn → consume().finally memanggil host.onLimitHit (auto-switch akun + lanjut).
   */
  private flagLimitHit(): void {
    if (this.limitHitPending || this.apiBlockPending) return
    this.limitHitPending = true
    try {
      void this.q?.interrupt?.()
    } catch {
      /* abaikan */
    }
  }

  /**
   * Error koneksi TRANSIENT (ECONNRESET/5xx/provider penuh) → coba lagi OTOMATIS: resume konteks
   * (sdkSessionId dipertahankan) lalu suruh lanjut dari titik terakhir. Backoff naik tiap percobaan.
   * Dibatasi MAX_TRANSIENT_RETRIES percobaan BERUNTUN tanpa turn sukses (counter direset saat sukses)
   * supaya tak jadi loop tak berujung saat upstream benar-benar down. Sesuai jelas dengan permintaan:
   * hanya untuk gangguan transient, BUKAN error fatal (auth/model — sudah disaring isTransientError).
   */
  private scheduleTransientRetry(): void {
    if (this.stopped) return
    if (this.transientRetries >= MAX_TRANSIENT_RETRIES) {
      this.transientRetries = 0
      this.record({
        role: 'system',
        text: `🚫 Koneksi ke API putus ${MAX_TRANSIENT_RETRIES}× berturut (retry otomatis menyerah). Ini biasanya kapasitas gratis OpenRouter yang sedang penuh — kirim pesan lagi untuk coba manual, atau klik-kanan kartu sesi → pilih model lain / OpenRouter berbayar yang lebih stabil.`,
        ts: Date.now()
      })
      this.setStatus('error')
      this.emitActivity('koneksi putus')
      return
    }
    this.transientRetries++
    const n = this.transientRetries
    const delayMs = 1500 * n // backoff naik: 1.5s, 3s, 4.5s
    this.record({
      role: 'system',
      text: `🔁 Koneksi terputus (transient) — mencoba lagi otomatis (${n}/${MAX_TRANSIENT_RETRIES}) dalam ${Math.round(delayMs / 1000)}s…`,
      ts: Date.now()
    })
    this.emitActivity('mencoba ulang koneksi…')
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.stopped) return
      // injectAutoTask meng-start() ulang (resume) lalu mendorong lanjut dari titik terakhir.
      this.injectAutoTask(
        '[GROVE] Koneksi ke API sempat terputus lalu tersambung lagi. LANJUTKAN pekerjaan dari titik terakhir — jangan mengulang dari awal.'
      )
    }, delayMs)
  }

  /** Catat satu baris system ke chat (dipakai orkestrator: memberi tahu switch akun / limit). */
  systemNote(text: string): void {
    this.record({ role: 'system', text, ts: Date.now() })
  }

  /** Tandai sesi berhenti karena limit (tak bisa/berhenti auto-switch) → status error. */
  markLimited(): void {
    this.setStatus('error')
    this.emitActivity('kena limit')
  }

  /** Naikkan & kembalikan hitungan pindah-akun beruntun akibat limit (guard anti-loop). */
  bumpLimitStreak(): number {
    return ++this.limitStreak
  }

  private setApiStopped(v: boolean): void {
    if (this.apiStopped === v) return
    this.apiStopped = v
    this.emit({ channel: 'session:update', payload: { id: this.meta.id, apiStopped: v } })
  }

  /** Menyala/mati flag "menunggu jawaban" (kartu berkedip kuning). Meniru pola setApiStopped. */
  private setAwaitingInput(v: boolean): void {
    if (this.awaitingInput === v) return
    this.awaitingInput = v
    this.emit({ channel: 'session:update', payload: { id: this.meta.id, awaitingInput: v } })
  }

  /** Reset hitungan konteks ke 0 (setelah konteks dibuang) → badge ctx% langsung turun. */
  private resetCtx(): void {
    this.meta.ctxInput = 0
    this.meta.ctxOutput = 0
    // ctxInput=0 dipakai logika ambang; UI diberi penanda "pending" agar badge TIDAK memajang 0% palsu —
    // isi window nyata baru diketahui saat turn berikutnya melapor usage (lihat applyUsage → ctxPending:false).
    this.emit({
      channel: 'session:update',
      payload: { id: this.meta.id, ctxInput: 0, ctxOutput: 0, ctxPercent: 0, ctxPending: true }
    })
  }

  /**
   * Recycle akibat blokir API: reset konteks Claude (buang riwayat yang ke-flag) TAPI seed
   * ringkasan tugas (dari board: summary/progress/todo) + prompt terakhir → lanjut langsung.
   * Setelah 3× masih diblokir → stop + tandai judul merah.
   */
  private handleApiBlock(): void {
    if (this.apiStopped) return
    if (this.apiRetries >= 3) {
      this.record({
        role: 'system',
        text: '⛔ Sesi dihentikan oleh API Claude (diblokir 3× berturut). Rephrase prompt lalu kirim manual untuk mencoba lagi.',
        ts: Date.now()
      })
      this.setApiStopped(true)
      this.setStatus('error')
      this.emitActivity('diblokir API')
      return
    }
    this.apiRetries++
    // Ringkasan tugas dari board sesi ini → agar sesi fresh tetap tahu konteksnya.
    const board = this.db.getBoardEntry(this.meta.id)
    const ctx: string[] = []
    if (board?.summary) ctx.push(`Tujuan & hasil sejauh ini: ${board.summary}`)
    if (board?.progress) ctx.push(`Terakhir dikerjakan: ${board.progress}`)
    if (board?.todo?.length) {
      ctx.push(`Checklist: ${board.todo.map((t) => `${t.done ? '✓' : '○'} ${t.text}`).join('; ')}`)
    }
    const seed = ctx.length
      ? `[Konteks direset karena blokir keamanan API — ringkasan tugasmu agar bisa langsung lanjut:]\n${ctx.join('\n')}\n\n`
      : ''
    this.record({
      role: 'system',
      text: `⟲ Konteks direset — recycle #${this.apiRetries}/3 (blokir API). Lanjut dari ringkasan tugas.`,
      ts: Date.now()
    })
    this.meta.sdkSessionId = undefined // fresh SDK session (tanpa resume → riwayat lama dilepas)
    this.resetCtx() // ctx% turun ke 0 seketika → bukti reset jalan
    this.db.upsertSession(this.meta)
    const prompt = `${seed}Lanjutkan pekerjaan.${this.lastUserPrompt ? ` Instruksi terakhir dari user: ${this.lastUserPrompt}` : ''}`
    this.beginTurn() // recycle = giliran baru → pelacak laporan-final direset
    this.start() // fresh (started sudah false dari finally)
    this.setStatus('running')
    this.emitActivity(`recycle #${this.apiRetries}…`)
    this.inbox.push(prompt)
  }

  /** Interupsi turn yang sedang berjalan TANPA menutup session (masih bisa lanjut chat). */
  async interruptTurn(): Promise<void> {
    // Ditandai SEBELUM interrupt: kalau SDK sempat memancarkan `result` sebagai akibat interupsi,
    // handler 'result' sudah melihat flag ini → Stop All TIDAK memicu laporan "selesai" palsu.
    this.interrupting = true
    this.flushDelta() // B2: keluarkan sisa token & batalkan timer saat turn diinterupsi manual
    this.setAwaitingInput(false) // dihentikan manual → kedip jangan nyangkut
    try {
      await this.q?.interrupt?.()
    } catch {
      /* abaikan */
    }
    this.setStatus('idle')
    this.emitActivity('idle')
  }

  private handle(msg: Record<string, unknown> & { type: string }): void {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const sid = msg.session_id as string
          const model = msg.model as string | undefined
          let changed = false
          if (sid && this.meta.sdkSessionId !== sid) {
            this.meta.sdkSessionId = sid
            changed = true
          }
          // Model aktual baru diketahui saat init → set ctxWindow yang benar (mis. [1m] = 1jt).
          if (model && this.meta.model !== model) {
            this.meta.model = model
            this.meta.ctxWindow = contextWindowFor(model)
            changed = true
            // Verifikasi (sekali/model): pastikan model 1M tak salah dideteksi sbagai 200k.
            console.log(`[Session ${this.meta.id}] model="${model}" → ctxWindow=${this.meta.ctxWindow}`)
          }
          if (changed) {
            this.meta.updatedAt = Date.now()
            this.db.upsertSession(this.meta)
            this.emit({
              channel: 'session:update',
              payload: {
                id: this.meta.id,
                sdkSessionId: this.meta.sdkSessionId,
                model: this.meta.model,
                ctxWindow: this.meta.ctxWindow,
                ctxPercent: contextPercent(this.meta.ctxInput, this.meta.ctxWindow)
              }
            })
          }
          this.setStatus('running')
        }
        break
      }
      case 'stream_event': {
        const ev = (
          msg as {
            event?: {
              type?: string
              delta?: { type?: string; text?: string }
              content_block?: { type?: string; name?: string }
            }
          }
        ).event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          this.queueDelta(ev.delta.text) // B2: tampung → flush tergabung, bukan emit per token
        } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          this.emitActivity(`🔧 ${ev.content_block.name ?? 'tool'}`)
        }
        break
      }
      case 'assistant': {
        // B2: pastikan token yang masih tertampung ter-emit SEBELUM blok ini difinalkan (chat:message),
        // agar urutan benar & tak ada stray chat:delta menyusul finalisasi (bikin gelembung dobel).
        this.flushDelta()
        // Limit langganan (5-jam/7-hari) datang sebagai field `error:'rate_limit'` di wrapper,
        // BUKAN exception — deteksi di sini agar auto-switch akun ikut kepicu.
        const wrapErr = (msg as { error?: string }).error
        if (wrapErr && isLimitError(wrapErr)) this.flagLimitHit()
        const message = (msg as { message?: { content?: unknown[]; usage?: Record<string, number> } }).message
        this.applyUsage(message?.usage)
        for (const block of (message?.content ?? []) as {
          type: string
          id?: string
          text?: string
          name?: string
          input?: Record<string, unknown>
        }[]) {
          if (block.type === 'text' && block.text?.trim()) {
            this.record({ role: 'assistant', text: block.text, ts: Date.now() })
            this.lastAssistantText = block.text // hasil kerja worker → isi auto-report saat turn selesai
            // Akumulasi SELURUH teks turn ini (bukan cuma blok terakhir) → hasil penuh utk handoff ke parent.
            this.turnText = this.turnText ? this.turnText + '\n' + block.text : block.text
            if (isApiBlock(block.text)) this.flagApiBlock() // API blokir pesan → recycle di akhir turn
            // Limit langganan sering datang sebagai TEKS ("You've hit your session limit · resets …"),
            // bukan exception/field error → deteksi di sini agar auto-switch akun ikut kepicu.
            else if (isLimitNotice(block.text)) this.flagLimitHit()
            // "Connection to the API was lost (ECONNRESET)…" datang sebagai TEKS asisten dari CLI,
            // sedang result-nya cuma subtype generik → catat di sini supaya finally bisa auto-retry.
            else if (isTransientError(block.text)) this.transientSeen = true
          } else if (block.type === 'tool_use') {
            const input = formatToolInput(block.input)
            const rowId = this.record({
              role: 'tool',
              text: summarizeTool(block.name, block.input),
              ts: Date.now(),
              detail: input,
              toolUseId: block.id
            })
            if (block.id) this.toolRows.set(block.id, { rowId, input })
          }
        }
        break
      }
      case 'user': {
        // Pesan 'user' dari SDK membawa hasil tool (tool_result) → tempelkan ke baris tool-nya.
        const content = (msg as { message?: { content?: unknown } }).message?.content
        if (!Array.isArray(content)) break // content string biasa (bukan tool_result) → abaikan
        for (const b of content as {
          type?: string
          tool_use_id?: string
          content?: unknown
          is_error?: boolean
        }[]) {
          if (b.type !== 'tool_result' || !b.tool_use_id) continue
          const rec = this.toolRows.get(b.tool_use_id)
          if (!rec) continue
          const out = clip(extractResultText(b.content), 6000)
          const merged = `${rec.input}\n\n--- OUTPUT${b.is_error ? ' (error)' : ''} ---\n${out}`
          this.db.updateChatDetail(rec.rowId, merged)
          this.emit({ channel: 'chat:detail', payload: { id: this.meta.id, toolUseId: b.tool_use_id, detail: merged } })
          this.toolRows.delete(b.tool_use_id)
        }
        break
      }
      case 'result': {
        this.flushDelta() // B2: turn berakhir → keluarkan sisa token yang masih tertampung
        const r = msg as { subtype?: string; errors?: unknown[]; stop_reason?: string }
        const subtype = r.subtype
        if (isApiBlock(JSON.stringify(msg))) this.flagApiBlock() // blokir API terselip di result
        // Limit bisa muncul sbg result error (errors[]/stop_reason). JANGAN stringify seluruh msg
        // untuk isLimitError — field "usage"/"modelUsage" akan false-positive; cek yang spesifik saja.
        if (subtype && subtype !== 'success') {
          const errStr = Array.isArray(r.errors) ? r.errors.map((x) => String(x)).join(' ') : ''
          const hit =
            (Array.isArray(r.errors) && r.errors.some((x) => isLimitError(String(x)))) ||
            (r.stop_reason ? isLimitError(r.stop_reason) : false)
          if (hit) this.flagLimitHit()
          // Result gagal + jejak koneksi transient (dari errors[] atau teks asisten "ECONNRESET…")
          // → tandai auto-retry. subtype generik 'error_during_execution' pun dianggap transient bila
          // teks turn menyebut koneksi hilang (transientSeen).
          else if (!this.apiBlockPending && (isTransientError(errStr) || this.transientSeen)) {
            this.transientPending = true
          }
        }
        if (subtype === 'success') {
          this.limitStreak = 0 // turn sukses → rantai limit direset
          this.transientRetries = 0 // turn sukses → rantai retry transient direset
        }
        // Jangan cetak error generik bila turn ini akan di-retry otomatis (transient) — nanti retry
        // punya notanya sendiri; dua pesan malah membingungkan.
        if (
          subtype &&
          subtype !== 'success' &&
          !this.apiBlockPending &&
          !this.limitHitPending &&
          !this.transientPending
        ) {
          this.record({
            role: 'system',
            text: `⚠️ ${friendlyError(subtype)}  (session tetap bisa dilanjut — kirim pesan lagi)`,
            ts: Date.now()
          })
        }
        // Status akhir turn:
        // - 'error' bila result NON-SUKSES yang bukan interupsi manual / limit / blokir API
        //   (ketiganya punya penanganan sendiri: interrupt→idle, limit→markLimited, apiBlock→recycle)
        //   → error nyata (max_turns/invalid_request/refusal/overloaded/…) akhirnya terlihat dot merah.
        // - 'done' bila tugas sudah dinyatakan tuntas (task_done root / sub lapor 100%) via markDone().
        // - selain itu 'idle' (menunggu input berikutnya) — perilaku lama.
        const failed =
          !!subtype &&
          subtype !== 'success' &&
          !this.apiBlockPending &&
          !this.limitHitPending &&
          !this.transientPending && // akan di-retry → jangan tandai error (dot merah) dulu
          !this.interrupting
        this.setStatus(failed ? 'error' : this.doneMarked ? 'done' : 'idle')
        this.emitActivity(failed ? 'error' : this.doneMarked ? 'selesai' : 'idle')
        // Turn selesai → beri tahu orkestrator (root akan dibangunkan untuk lapor ke user).
        // JAMINAN RUNTIME: bila turn ini berakhir WAJAR dan worker TIDAK melapor final sendiri,
        // sertakan teks jawaban terakhirnya supaya host yang melaporkannya ke parent. Turn yang
        // berakhir karena interupsi (Stop All/compact/ganti akun), limit, blokir API, atau result
        // non-sukses TIDAK dikirimi outcome → tak ada laporan "selesai" palsu.
        const cleanEnd =
          subtype === 'success' &&
          !this.interrupting &&
          !this.stopped &&
          !this.apiBlockPending &&
          !this.limitHitPending
        // Turn berhenti WAJAR, tak ada kerja tertunda di inbox, & penutupnya berupa pertanyaan/konfirmasi
        // → tandai "menunggu jawaban" (kartu berkedip kuning). Dibersihkan lagi di beginTurn() saat
        // user/parent menindak. (turnText masih utuh di sini — dibersihkan setelah notifyTurnEnd.)
        if (
          cleanEnd &&
          !this.inbox.hasPending() &&
          looksLikeAwaitingInput(this.turnText || this.lastAssistantText)
        ) {
          this.setAwaitingInput(true)
        }
        // Handoff: kirim teks turn PENUH setiap turn berakhir wajar, TANPA peduli finalReportSent —
        // worker yang sempat report_to_parent(100) tetap wajib menyerahkan hasilnya ke parent.
        this.host.notifyTurnEnd(
          this.meta.id,
          cleanEnd ? { finalText: this.turnText || this.lastAssistantText } : undefined
        )
        this.turnText = '' // sudah dipakai → bersihkan agar turn berikutnya mulai bersih
        // Bila ada permintaan compact tertunda, padatkan konteks sekarang (turn sudah selesai).
        if (this.pendingCompactSeed) this.doCompact()
        else {
          const pct = contextPercent(this.meta.ctxInput, this.meta.ctxWindow)
          if (pct < AUTO_COMPACT_LOW) {
            // Turn berakhir lega → reset guard futility (compact sebelumnya benar memberi headroom).
            this.compactStreak = 0
            this.compactWarned = false
          } else if (this.compactArmed && pct >= AUTO_COMPACT_HIGH) {
            if (this.compactStreak >= 2) {
              // Compact berulang tak menurunkan konteks → jangan loop; peringatkan SEKALI (anti-freeze + anti-spam).
              if (!this.compactWarned) {
                this.record({
                  role: 'system',
                  text: '⚠️ Konteks tetap penuh setelah compact berulang; ringkasan/tugas mungkin terlalu besar — pertimbangkan pecah tugas atau Compact manual.',
                  ts: Date.now()
                })
                this.compactWarned = true
              }
            } else {
              // Auto-compact: konteks mendekati penuh → minta orkestrator padatkan (cegah freeze).
              this.host.notifyHighContext(this.meta.id)
            }
          }
        }
        break
      }
      default:
        break
    }
  }

  private applyUsage(usage?: Record<string, number>): void {
    if (!usage) return
    const ctxInput =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    const ctxOutput = usage.output_tokens ?? 0
    if (ctxInput <= 0 && ctxOutput <= 0) return
    // Catat pemakaian NYATA respons ini ke riwayat lokal (per jam/akun) → bisa dicek boros/normal.
    this.host.recordUsage(this.meta.id, {
      input: usage.input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      output: ctxOutput
    })
    this.lastApiActivity = Date.now()
    this.meta.ctxInput = ctxInput
    this.meta.ctxOutput = ctxOutput
    this.tokensTotal += ctxOutput
    const now = Date.now()
    this.meta.updatedAt = now
    // B3: angka ctx/usage ephemeral (dihitung ulang tiap turn) → jangan tulis DB tiap pesan.
    // Persist maksimal tiap CTX_PERSIST_MS. Nilai FINAL tetap tersimpan saat turn selesai:
    // 'result' memanggil setStatus('idle') yang meng-upsert meta terkini (running→idle berubah).
    if (now - this.lastCtxPersist >= CTX_PERSIST_MS) {
      this.lastCtxPersist = now
      this.db.upsertSession(this.meta)
    }
    this.emit({
      channel: 'session:update',
      payload: {
        id: this.meta.id,
        ctxInput,
        ctxOutput,
        ctxPercent: contextPercent(ctxInput, this.meta.ctxWindow),
        tokensTotal: this.tokensTotal,
        ctxPending: false // ada pengukuran nyata → badge keluar dari mode pending
      }
    })
    // Hysteresis: begitu konteks NYATA turun < LOW, persenjatai ulang auto-compact (boleh memicu lagi nanti).
    if (contextPercent(ctxInput, this.meta.ctxWindow) < AUTO_COMPACT_LOW) this.compactArmed = true
  }
}
