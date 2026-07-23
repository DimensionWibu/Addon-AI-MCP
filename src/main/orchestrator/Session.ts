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
import { groveAppend, GROVE_REFERENCE } from './prompts'
import { compactDecision, compactThresholds } from './wakePolicy'
import { handoverRel } from './handover'

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

/**
 * Detail baris tool untuk tool yang MENGUBAH FILE (Edit/Write/MultiEdit) → format DIFF baris-per-baris
 * ("- " dibuang, "+ " ditambah) dengan penanda hunk "@@". Renderer memakai penanda ini untuk mewarnai
 * dan untuk menampilkan pratinjau ringkas saat baris belum diklik. Tool lain memakai format lama.
 */
function formatToolDetail(name = '', input?: Record<string, unknown>): string {
  const i = input ?? {}
  const path = typeof i.file_path === 'string' ? i.file_path : typeof i.path === 'string' ? i.path : ''
  const mark = (s: string, m: string): string =>
    clip(s, 6000)
      .replace(/\n+$/, '')
      .split('\n')
      .map((l) => m + l)
      .join('\n')
  if (name === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    const head = `file: ${path}${i.replace_all ? ' · semua kemunculan' : ''}`
    return `${head}\n@@ edit @@\n${mark(i.old_string, '- ')}\n${mark(i.new_string, '+ ')}`
  }
  if (name === 'Write' && typeof i.content === 'string') {
    const n = i.content.replace(/\n+$/, '').split('\n').length
    return `file: ${path}\n@@ tulis ${n} baris @@\n${mark(i.content, '+ ')}`
  }
  if (name === 'MultiEdit' && Array.isArray(i.edits)) {
    const blocks = (i.edits as Array<Record<string, unknown>>)
      .map((e, n) => {
        const o = typeof e.old_string === 'string' ? e.old_string : ''
        const w = typeof e.new_string === 'string' ? e.new_string : ''
        return `@@ edit ${n + 1} @@\n${mark(o, '- ')}\n${mark(w, '+ ')}`
      })
      .join('\n')
    return `file: ${path}\n${blocks}`
  }
  return formatToolInput(input)
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

// Auto-retry beruntun error koneksi transient sebelum menyerah. 5× dengan backoff eksponensial
// (2s→4s→8s→16s→30s, total ~1 menit) karena gangguan provider (DeepSeek/OpenRouter penuh, 5xx,
// koneksi drop di tengah stream) sering butuh lebih dari 4 detik untuk pulih — 3× backoff linear
// dulu terlalu cepat menyerah dan memaksa user mengetik ulang.
const MAX_TRANSIENT_RETRIES = 5
const RETRY_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000]
// Ambang auto-compact (ctx%) ada di ./wakePolicy dan BEDA PER ROLE — root dipadatkan jauh lebih
// awal (70/50 vs 88/70) karena root-lah yang paling sering dibangunkan, jadi tiap persen konteksnya
// ditagih berkali-kali; compact root pun tak memakai giliran model. Lihat COMPACT di wakePolicy.ts.
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
/**
 * Sesi SDK yang dirujuk sudah tak ada di folder project ini.
 *
 * Claude Code menyimpan transkrip PER FOLDER PROJECT. Kalau id sesi milik folder A dipakai untuk
 * resume di folder B, CLI membalas "No conversation found with session ID: …" dan sesi jadi buntu
 * total. Penyebab yang sudah diperbaiki: kolom cwd tak ikut tersimpan saat folder sesi dipindah
 * (lihat db.upsertSession). Deteksi ini tetap dipertahankan sebagai jaring pengaman — id sesi juga
 * bisa hilang karena transkripnya dihapus/dibersihkan di luar Grove.
 */
/**
 * Gateway MENOLAK model yang dipakai — bukan gangguan sesaat, melainkan keputusan tetap:
 * kuota model itu habis ("subscription_not_eligible"), tak diizinkan untuk key ini
 * ("model_not_allowed"), atau namanya tak dikenal. Retry model yang sama percuma; yang benar adalah
 * pindah ke model cadangan.
 */
export function isModelRejected(raw: string): boolean {
  return /subscription_not_eligible|model_not_allowed|model_not_found|is not available|not allowed to use model|tidak diizinkan untuk key/i.test(raw)
}

export function isStaleSdkSession(raw: string): boolean {
  return /no conversation found with session id/i.test(raw)
}

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
  private staleSessionPending = false // id sesi SDK tak dikenali di folder ini → mulai sesi bersih & ulangi
  private modelRejectedPending = false // gateway menolak model ini → pindah ke model cadangan akun
  private transientSeen = false // teks asisten menyebut error koneksi transient pada turn ini
  private transientRetries = 0 // retry transient beruntun tanpa turn sukses (guard anti-loop; reset saat sukses)
  private retryTimer: NodeJS.Timeout | null = null // timer backoff auto-retry (di-clear saat stop)
  private compactArmed = true // auto-compact hanya menyala bila konteks NYATA pernah turun < LOW (hysteresis anti-thrash)
  private compactStreak = 0 // compact beruntun tanpa turn yang berakhir < LOW (guard anti-freeze; lihat limitStreak)
  private compactWarned = false // peringatan "konteks tetap penuh" sudah dikirim untuk streak ini (anti-spam)
  private lastCompactAt = 0 // kapan konteks terakhir dipadatkan (penentu "checkpoint model masih segar?")
  private checkpointNudge = false // ctx lewat ambang pra-compact → giliran berikutnya minta model update handover
  /** File yang sesi ini TULIS/EDIT (jejak tool_use, bukan tebakan) → bahan "Files Changed" handover. */
  private readonly filesTouched = new Set<string>()
  /** File yang sudah DIBACA & pencarian yang sudah DIJALANKAN → agar sesudah compact tak diulang. */
  private readonly filesRead = new Set<string>()
  private readonly searches = new Set<string>()
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
  /** Token yang SUDAH tercatat pada turn berjalan — pembanding untuk rekonsiliasi di akhir turn. */
  private turnUsage = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }
  private lastUsageMsgId: string | null = null // id respons API terakhir yang usage-nya sudah dicatat (anti hitung-ganda)
  // Pesan user yang DITAHAN karena turn masih berjalan → masih bisa diedit/dibatalkan user.
  private queued: Array<{ qid: number; text: string; images?: ImageAttachment[] }> = []
  private qidSeq = 1
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

  /** Jejak file yang ditulis/diedit sesi ini (urut kemunculan) — dipakai menyusun handover. */
  getFilesTouched(): string[] {
    return [...this.filesTouched]
  }

  /** File yang sudah dibaca sesi ini — supaya sesi lanjutan tak membaca ulang setelah compact. */
  getFilesRead(): string[] {
    return [...this.filesRead]
  }

  /** Pencarian (Grep/Glob) yang sudah dijalankan — supaya tak diulang setelah compact. */
  getSearches(): string[] {
    return [...this.searches]
  }

  /** Kapan konteks sesi ini terakhir dipadatkan (0 = belum pernah). Penentu kesegaran handover. */
  getLastCompactAt(): number {
    return this.lastCompactAt
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
        // TINGKAT MIKIR (reasoning). low..max → CLI mengirim output_config.effort (jalan di Claude
        // MAUPUN DeepSeek — dibuktikan lewat proxy pencatat). 'off' → CLI hanya MENGHILANGKAN field
        // `thinking` (tak pernah mengirim type:"disabled"): efektif mematikan extended thinking di
        // Claude, tapi DeepSeek yang default-nya nyala TETAP mikir. undefined = default model.
        ...(launch.effort === 'off'
          ? { thinking: { type: 'disabled' as const } }
          : launch.effort
            ? { effort: launch.effort }
            : {}),
        cwd: this.meta.cwd,
        includePartialMessages: true,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          // Instruksi referensi hanya ikut bila sesi ini memang punya tautan → sesi biasa tak membayarnya.
          // Path checkpoint DIPERSONALISASI per sesi (.grove/checkpoint-<id>.md): root & semua
          // sub-worker berbagi cwd, jadi satu nama file bersama pasti saling menimpa.
          append: lite
            ? ''
            : groveAppend(this.meta.role, handoverRel(this.meta.id)) +
              (this.host.hasReferences(this.meta.id) ? `\n\n${GROVE_REFERENCE}` : ''),
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
    // HANDOVER DULU, baru konteks dilepas: pastikan ada file .md di working directory yang memuat
    // detail kerja (checkpoint tulisan model bila masih segar, kalau tidak versi Grove). Ringkasan
    // board saja terlalu miskin untuk melanjutkan pekerjaan nyata.
    const handover = this.host.beforeCompact(this.meta.id, summary)
    this.lastCompactAt = Date.now()
    this.checkpointNudge = false // konteks sudah dipotong → nudge lama tak relevan
    this.interrupting = true // turn dipotong paksa → jangan dianggap "worker selesai"
    this.reseedText = handover
      ? `${summary}\n\nHANDOVER: file \`${handover}\` di working directory berisi konteks detail (file yang sudah dibaca/diubah, pencarian yang sudah dijalankan, keputusan, langkah berikutnya). BACA file itu SEBELUM mulai bekerja. JANGAN mengulang pencarian atau pembacaan yang sudah tercatat di sana — lanjutkan dari temuannya; perbarui file yang sama saat ada kemajuan berarti.`
      : summary
    this.meta.sdkSessionId = undefined // start berikutnya FRESH (tanpa resume) → konteks lama dilepas
    this.resetCtx() // ctx% turun ke 0 seketika
    this.compactArmed = false // jangan auto-compact lagi sampai konteks NYATA turun < LOW (anti-thrash)
    this.compactStreak++ // hitung compact beruntun → guard anti-freeze bila konteks tetap penuh
    this.db.upsertSession(this.meta)
    this.started = false
    const q = this.q
    this.q = null
    this.disposeQuery(q) // interrupt SAJA meninggalkan proses CLI hidup (lihat disposeQuery)
    this.record({
      role: 'system',
      text: handover
        ? `⟲ Konteks dipadatkan (compact). Ringkasan disimpan ke Memori & handover ditulis ke \`${handover}\` — pesan berikutnya melanjutkan dari ringkasan + file itu.`
        : '⚠️ Konteks dipadatkan (compact), TAPI file handover gagal ditulis (folder tak bisa ditulisi?) — sesi hanya melanjutkan dari ringkasan papan.',
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
    this.checkpointNudge = false
    this.filesTouched.clear() // topik baru → jejak file topik lama jangan ikut ke handover berikutnya
    this.filesRead.clear()
    this.searches.clear()
    // Checkpoint yang ada di disk milik TOPIK LAMA. Ditandai basi (bukan dihapus: isinya masih
    // diselamatkan sebagai kutipan) supaya compact berikutnya menulis ulang untuk topik baru ini.
    this.lastCompactAt = Date.now()
    this.db.upsertSession(this.meta)
    this.started = false
    const q = this.q
    this.q = null
    // hentikan query long-lived lama SAMPAI prosesnya mati (cegah interleave + kebocoran proses)
    this.disposeQuery(q)
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
   * Dekorasi pesan keluar: reseed pasca-compact + NUDGE handover pra-compact.
   *
   * Nudge sengaja MENUMPANG giliran yang memang akan terjadi (bukan giliran tersendiri): konteks
   * sudah dekat ambang, jadi satu giliran khusus untuk "tolong tulis checkpoint" berarti membayar
   * ulang seluruh konteks besar itu hanya untuk sebuah file. Kalau model mengabaikannya, Grove
   * tetap menulis versi deterministiknya sendiri saat compact — itulah sisi kedua strategi hibrida.
   * Sesi LITE dilewati: ia memang dibeli untuk murah, dan jaring pengaman Grove sudah menutupinya.
   */
  private decorate(text: string, noNudge = false): string {
    const t = this.withReseed(text)
    if (noNudge || !this.checkpointNudge || this.meta.lite) return t
    this.checkpointNudge = false
    const pct = contextPercent(this.meta.ctxInput, this.meta.ctxWindow)
    return (
      `[GROVE] Konteks sesi ini sudah ${pct}% penuh dan akan segera DIPADATKAN (compact) — riwayat percakapan akan hilang. ` +
      `SEBELUM mengerjakan permintaan di bawah, perbarui file handover-mu \`${handoverRel(this.meta.id)}\` ` +
      `(Goal / Files Changed / Key Decisions / Current State / Next Steps, di bawah 2k karakter) supaya pekerjaan ini bisa dilanjutkan setelah compact. ` +
      `Lakukan itu di giliran yang sama, jangan jadi balasan terpisah.\n\n---\n${t}`
    )
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
    this.turnUsage = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 } // hitungan token turn baru
  }

  /** Dipanggil host saat worker memanggil report_to_parent dgn percent 100 → auto-report jangan dobel. */
  markFinalReported(): void {
    this.finalReportSent = true
  }

  /**
   * Dorong konten ke query SEKALIGUS surface "raw request" ke panel LOG (renderer). rawText = teks
   * yang Grove kontrol (prompt user + reseed + auto-task); byte-nya diukur UTF-8. JUJUR: ini BUKAN
   * body HTTP byte-exact — system prompt/transcript/skema tools dirakit di subprocess SDK.
   */
  private pushRequest(content: string | unknown[], kind: 'user' | 'auto' | 'recycle', rawText: string, images = 0): void {
    this.emit({
      channel: 'log:request',
      payload: { id: this.meta.id, kind, text: rawText, bytes: Buffer.byteLength(rawText, 'utf8'), images }
    })
    this.inbox.push(content)
  }

  /** Kirim pesan user (opsional dengan gambar); start otomatis bila dormant. */
  /** Pesan yang MASIH ANTRI di chat aktif (untuk UI: bisa diedit/dibatalkan sebelum terkirim). */
  listQueued(): Array<{ qid: number; text: string }> {
    return this.queued.map((q) => ({ qid: q.qid, text: q.text }))
  }

  /** Ubah isi pesan yang masih antri. false = sudah terlanjur terkirim (tak ada di antrian lagi). */
  editQueued(qid: number, text: string): boolean {
    const q = this.queued.find((x) => x.qid === qid)
    if (!q) return false
    q.text = text
    this.emitQueue()
    return true
  }

  /** Batalkan pesan yang masih antri. false = sudah terlanjur terkirim. */
  cancelQueued(qid: number): boolean {
    const i = this.queued.findIndex((x) => x.qid === qid)
    if (i < 0) return false
    this.queued.splice(i, 1)
    this.emitQueue()
    return true
  }

  private emitQueue(): void {
    this.emit({ channel: 'queue:update', payload: { id: this.meta.id, items: this.listQueued() } })
  }

  /**
   * Kirim satu pesan yang tertahan (dipanggil saat turn selesai). Sisa antrian tetap menunggu turn
   * berikutnya — satu giliran satu pesan, supaya urutannya tetap terbaca oleh user.
   */
  private flushQueued(): void {
    const next = this.queued.shift()
    if (!next) return
    this.emitQueue()
    this.sendUserMessage(next.text, next.images, true)
  }

  /**
   * @param fromQueue true = sudah pernah antri (jangan diantrikan lagi). Pesan user yang datang saat
   * turn MASIH JALAN ditahan di Grove, BUKAN didorong ke SDK — dengan begitu ia masih bisa diedit
   * atau dibatalkan (permintaan: "kalau prompt yang dituju masih antre harusnya dia ngedit antrian").
   * Auto-task internal (injectAutoTask) memakai jalur lain & tak pernah lewat antrian ini.
   */
  sendUserMessage(text: string, images?: ImageAttachment[], fromQueue = false, displayImagesOnly = false): void {
    if (!fromQueue && this.meta.status === 'running' && this.started) {
      const qid = this.qidSeq++
      this.queued.push({ qid, text, images })
      this.emitQueue()
      this.emitActivity(`antri ${this.queued.length} pesan`)
      return
    }
    // JEMBATAN GAMBAR: model sesi ini buta gambar (DeepSeek menerima blok image lalu mengabaikannya
    // TANPA error) → gambar dideskripsikan dulu oleh akun yang bisa melihat, hasilnya masuk sebagai
    // teks. Tanpa ini, user mengira gambarnya terkirim padahal model tak pernah melihat apa pun.
    if (images?.length && !displayImagesOnly && !this.host.sessionSeesImages(this.meta.id)) {
      void this.describeImagesThenSend(text, images)
      return
    }
    this.beginTurn()
    this.lastUserPrompt = text // prompt user SEBELUM kena flag → diulang saat recycle
    this.apiRetries = 0 // prompt baru → reset hitungan recycle
    this.limitStreak = 0 // prompt user baru → reset rantai pindah-akun akibat limit
    this.setApiStopped(false)
    text = this.decorate(text)
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
    // displayImagesOnly = gambar sudah dideskripsikan lewat jembatan; di chat tetap ditampilkan
    // (supaya user melihat apa yang ia kirim) tapi TIDAK dikirim ke model yang tak bisa melihatnya.
    if (images?.length && !displayImagesOnly) {
      const content: unknown[] = []
      if (text) content.push({ type: 'text', text })
      for (const im of images) {
        content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })
      }
      this.pushRequest(content, 'user', text, images.length)
    } else {
      this.pushRequest(text, 'user', text)
    }
  }

  /**
   * Inject instruksi otomatis (mis. permintaan rangkuman progres dari worker) ke query.
   * Masuk konteks SDK sebagai giliran user, TAPI tidak direkam ke chat/DB agar UI tetap bersih —
   * yang tampil ke user cukup BALASAN root-nya. Start bila dormant (resume, konteks nyambung).
   */
  injectAutoTask(text: string, opts?: { noNudge?: boolean }): void {
    if (this.stopped) return
    this.beginTurn()
    // noNudge: ping cache-warm menuntut balasan SATU KATA tanpa tool — menempelkan permintaan
    // "tulis file handover" di situ hanya membuat instruksinya bertabrakan.
    text = this.decorate(text, opts?.noNudge)
    if (!this.started) {
      this.start()
      if (!this.started) return // start dibatalkan (akun tanpa token) → jangan tandai running
    }
    this.setStatus('running')
    this.emitActivity('menyusun update progres…')
    this.pushRequest(text, 'auto', text)
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
    this.injectAutoTask(
      '[GROVE CACHE-WARM] Prefix cache refresh. Reply with exactly one word: OK — no tools, no analysis, no other text.',
      { noNudge: true }
    )
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

  /**
   * Catat file yang BENAR-BENAR ditulis/diedit (dari input tool_use). Jejak ini yang mengisi bagian
   * "Files Changed" pada handover Grove — jauh lebih tepat daripada menebaknya dari teks percakapan.
   * Dibatasi 60 entri terakhir supaya sesi panjang tak menumpuk memori.
   */
  private noteFileTouched(name?: string, input?: unknown): void {
    if (!name) return
    const i = (input ?? {}) as Record<string, unknown>
    const add = (set: Set<string>, v: unknown, cap: number): void => {
      if (typeof v !== 'string' || !v || set.has(v)) return
      if (set.size >= cap) set.delete(set.values().next().value as string)
      set.add(v)
    }
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
      add(this.filesTouched, i.file_path ?? i.path ?? i.notebook_path, 60)
      return
    }
    // JEJAK PENJELAJAHAN — alasan kenapa ini dicatat: sesudah compact, transkrip hilang dan model
    // TIDAK ingat apa yang sudah ia cari, jadi ia meng-Grep pola yang sama berulang-ulang di folder
    // yang sama (terlihat jelas di panel LOG). Menuliskannya ke handover membuat sesi lanjutan tahu
    // apa yang SUDAH dijelajahi, jadi ia melanjutkan alih-alih mengulang dari nol.
    if (name === 'Read') add(this.filesRead, i.file_path ?? i.path, 40)
    else if (name === 'Grep') {
      const pat = typeof i.pattern === 'string' ? i.pattern : ''
      const where = typeof i.path === 'string' ? ` in ${i.path}` : ''
      add(this.searches, pat ? `Grep ${pat}${where}` : '', 30)
    } else if (name === 'Glob') {
      const pat = typeof i.pattern === 'string' ? i.pattern : ''
      const where = typeof i.path === 'string' ? ` in ${i.path}` : ''
      add(this.searches, pat ? `Glob ${pat}${where}` : '', 30)
    }
  }

  /** Simpan ke riwayat in-memory + DB + kirim ke UI. Kembalikan rowid DB. (Gambar tak dipersist.) */
  private record(m: ChatMessage): number {
    this.history.push(m)
    const dbText = m.text || (m.images?.length ? '🖼️ [gambar]' : '')
    const rowId = this.db.addChatMessage(this.meta.id, m.role, dbText, m.ts, m.detail)
    this.emit({ channel: 'chat:message', payload: { id: this.meta.id, message: m } })
    return rowId
  }

  /**
   * BUANG query lama SAMPAI PROSESNYA MATI.
   *
   * DIUKUR (test/proc-leak.ts, bukan dugaan): `interrupt()` hanya menghentikan GILIRAN — pada mode
   * streaming-input subprocess CLI tetap hidup menunggu input berikutnya. Proses anak yang terhitung:
   *   query hidup → +2 (claude.exe + conhost.exe) · setelah interrupt() → TETAP 2 · setelah return() → 0.
   * Karena Grove mengganti query pada compact, ganti akun/model, reset worker, dan recycle blokir API,
   * tiap kejadian itu dulu meninggalkan satu claude.exe ~200-250MB. Itulah "2 sesi tapi 7 proses
   * Claude Code, RAM 2GB". `return()` mengakhiri async generator → SDK membereskan subprocess-nya.
   *
   * interrupt() TETAP dipanggil lebih dulu: ia menghentikan giliran yang sedang berjalan dengan rapi
   * (dan pada CLI baru mengembalikan tanda terima), baru sesudahnya prosesnya ditutup.
   */
  private disposeQuery(q: ReturnType<typeof query> | null): void {
    if (!q) return
    void (async () => {
      try {
        await q.interrupt?.()
      } catch {
        /* query mungkin sudah mati — lanjut ke penutupan */
      }
      try {
        await q.return?.(undefined as never)
      } catch {
        /* abaikan */
      }
    })()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null } // batalkan auto-retry yang tertunda
    this.flushDelta() // B2: keluarkan sisa token & batalkan timer saat sesi ditutup
    this.interrupting = true // ditutup paksa → bukan "turn selesai wajar"
    this.setAwaitingInput(false) // sesi ditutup → kedip jangan nyangkut
    this.inbox.close()
    const q = this.q
    this.q = null
    this.disposeQuery(q) // sesi ditutup → subprocess CLI ikut mati, bukan cuma turn-nya
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
      } else if (isModelRejected(raw)) this.modelRejectedPending = true // model ditolak → pindah cadangan
      else if (isStaleSdkSession(raw)) this.staleSessionPending = true // transkrip lama tak ketemu → sesi bersih
      else if (isApiBlock(raw)) this.apiBlockPending = true
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
      // JARING PENGAMAN PROSES: apa pun yang mengakhiri loop pesan (selesai, error, blokir API,
      // limit), subprocess CLI-nya belum tentu mati — interrupt() terbukti meninggalkannya hidup.
      // Membuangnya di sini menutup SEMUA jalur sekaligus, termasuk recycle blokir-API yang langsung
      // start() query baru sesudahnya.
      this.disposeQuery(myQ)
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
    this.disposeQuery(q) // interrupt SAJA meninggalkan proses CLI hidup (lihat disposeQuery)
    this.setStatus('idle')
    this.emitActivity('idle')
  }

  /**
   * Gateway menolak model yang sedang dipakai → PINDAH ke kandidat berikutnya milik akun, lalu ulangi
   * permintaan terakhir. Tanpa ini sesi mati total begitu satu model kehabisan kuota, padahal akun
   * yang sama masih punya model lain yang sah.
   */
  private recoverRejectedModel(): void {
    const next = this.host.nextModelCandidate(this.meta.id)
    if (!next) {
      this.record({
        role: 'system',
        text:
          '⛔ Gateway menolak model sesi ini (kuota model itu habis / tak diizinkan untuk key ini) dan TIDAK ada model cadangan. ' +
          'Isi daftar model akun dengan beberapa id dipisah koma (mis. "claude-opus-4.8, claude-sonnet-5, glm-5.2") lewat ⚙ Akun, atau ganti model sesi ini lewat klik-kanan kartu.',
        ts: Date.now()
      })
      this.setStatus('error')
      this.emitActivity('model ditolak')
      return
    }
    this.record({
      role: 'system',
      text: `🔀 Model sebelumnya ditolak gateway (kuota habis / tak diizinkan) → pindah ke "${next}" dan mengulang permintaan terakhir.`,
      ts: Date.now()
    })
    this.restartQuery() // model efektif dibaca lagi saat start berikutnya
    if (this.lastUserPrompt) this.injectAutoTask(this.lastUserPrompt, { noNudge: true })
    else {
      this.setStatus('idle')
      this.emitActivity('idle')
    }
  }

  /**
   * PULIHKAN sesi yang id SDK-nya tak dikenali di folder ini: lepas id lama (mulai percakapan bersih
   * di folder sekarang) lalu ULANGI permintaan terakhir user. Tanpa ini, sesi terjebak — tiap pesan
   * berikutnya gagal dengan error yang sama dan satu-satunya jalan keluar adalah Compact manual.
   * Konteks percakapan lama memang hilang; itu konsekuensi jujur dari transkrip yang tak ditemukan.
   */
  private recoverStaleSession(): void {
    this.meta.sdkSessionId = undefined
    this.db.upsertSession(this.meta)
    this.started = false
    this.record({
      role: 'system',
      text:
        '⟲ Percakapan lama tak ditemukan untuk folder kerja ini (biasanya karena folder sesi sempat berpindah). ' +
        'Sesi dimulai bersih di folder sekarang dan permintaan terakhirmu diulang otomatis — konteks percakapan sebelumnya tidak terbawa.',
      ts: Date.now()
    })
    if (this.lastUserPrompt) this.injectAutoTask(this.lastUserPrompt, { noNudge: true })
    else {
      this.setStatus('idle')
      this.emitActivity('idle')
    }
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
        text: `🚫 Koneksi ke API putus ${MAX_TRANSIENT_RETRIES}× berturut selama ~1 menit (retry otomatis menyerah). Penyebab lazim: kapasitas provider sedang penuh (OpenRouter gratis / DeepSeek sibuk) atau jaringan lokal. Konteks sesi TIDAK hilang — kirim pesan apa saja untuk melanjutkan, atau klik-kanan kartu sesi → ganti model/akun.`,
        ts: Date.now()
      })
      this.setStatus('error')
      this.emitActivity('koneksi putus')
      return
    }
    this.transientRetries++
    const n = this.transientRetries
    const delayMs = RETRY_BACKOFF_MS[Math.min(n - 1, RETRY_BACKOFF_MS.length - 1)] // 2s→4s→8s→16s→30s
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
        '[GROVE] Koneksi ke API sempat terputus lalu tersambung lagi. LANJUTKAN pekerjaan dari titik terakhir — jangan mengulang dari awal. ' +
          'PENTING: perintah terakhir mungkin SUDAH terlanjur jalan meski hasilnya tak sempat kembali. Sebelum menjalankan ulang apa pun yang berefek samping ' +
          '(request jaringan, tulis/hapus file, deploy), CEK dulu jejaknya (file output, log, state) dan lanjutkan dari sana — jangan menduplikasi pekerjaan.'
      )
    }, delayMs)
  }

  /**
   * JEMBATAN GAMBAR untuk sesi yang modelnya buta gambar (DeepSeek). Gambar dikirim ke akun LAIN yang
   * bisa melihat (mis. Claude), diminta dideskripsikan seteliti mungkin, lalu deskripsinya disisipkan
   * sebagai TEKS ke pesan user di sesi ini.
   *
   * Kejujuran yang dijaga: user diberi tahu jembatan ini dipakai & akun mana yang menagihnya; kalau
   * tak ada akun yang bisa melihat, sesi TIDAK pura-pura menerima gambar — pesannya tetap dikirim
   * dengan catatan tegas bahwa gambarnya tak terbaca.
   */
  private async describeImagesThenSend(text: string, images: ImageAttachment[]): Promise<void> {
    const candidates = this.host.getVisionLaunches()
    if (!candidates.length) {
      this.record({
        role: 'system',
        text:
          '🖼️ Model sesi ini TIDAK bisa melihat gambar (DeepSeek mengabaikan gambar tanpa error), dan belum ada akun lain ' +
          'yang bisa melihat. Gambar tidak dikirim. Tambahkan akun Claude di ⚙ Akun untuk mengaktifkan jembatan gambar, ' +
          'atau jelaskan isi gambar lewat teks.',
        ts: Date.now()
      })
      this.sendUserMessage(text, images, true, true)
      return
    }
    // Jembatan makan waktu (satu panggilan model penuh) → tandai sesi BEKERJA, jangan biarkan tampak
    // idle. Tanpa ini kartu sesi diam saja padahal ada giliran berbayar yang sedang jalan.
    this.setStatus('running')
    this.emitActivity('🖼️ membaca gambar')
    let desc = ''
    let usedLabel = ''
    // CADANGAN BERANTAI: akun pertama kena limit/koneksi putus → turun ke akun berikutnya yang bisa
    // melihat gambar. Kegagalan tiap akun dilaporkan apa adanya, bukan disembunyikan.
    for (const vision of candidates) {
      this.record({
        role: 'system',
        text: `🖼️ Model sesi ini tak bisa melihat gambar → dideskripsikan dulu lewat akun "${vision.label}" (giliran ini ditagih ke akun itu)…`,
        ts: Date.now()
      })
      try {
      const content: unknown[] = [
        {
          type: 'text',
          text:
            'Deskripsikan gambar berikut SETELITI mungkin untuk agen lain yang tidak bisa melihatnya. Wajib sebutkan: ' +
            'semua teks yang terbaca (persis, termasuk angka/error/path), elemen UI & tata letaknya, status/warna penting, ' +
            'dan apa pun yang tampak salah. Jangan menebak maksud pengguna, jangan memberi saran — hanya deskripsi faktual.' +
            (text ? `\n\nKonteks pertanyaan pengguna (untuk fokus deskripsi): ${text.slice(0, 500)}` : '')
        },
        ...images.map((im) => ({
          type: 'image',
          source: { type: 'base64', media_type: im.mediaType, data: im.data }
        }))
      ]
      const q = query({
        prompt: (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: content as never },
            parent_tool_use_id: null
          }
        })(),
        options: {
          ...(vision.model ? { model: vision.model } : {}),
          cwd: this.meta.cwd,
          permissionMode: 'bypassPermissions',
          allowedTools: [],
          systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
          settingSources: [],
          env: vision.env,
          ...(CLAUDE_EXE ? { pathToClaudeCodeExecutable: CLAUDE_EXE } : {})
        }
      })
        let failure = ''
        for await (const m of q as AsyncIterable<Record<string, unknown>>) {
          if (String(m.type) === 'assistant') {
            const blocks = (m.message as { content?: Array<{ type: string; text?: string }> })?.content ?? []
            for (const b of blocks) {
              if (b.type === 'text' && b.text) {
                // Limit datang sebagai TEKS asisten ("You've hit your session limit · resets …"),
                // bukan exception → tanpa cek ini, "limit" ikut jadi "deskripsi" gambar.
                if (isLimitNotice(b.text) || isTransientError(b.text)) failure = b.text
                else desc += b.text
              }
            }
          }
          if (String(m.type) === 'result') {
            const r = m as { subtype?: string; errors?: unknown[] }
            if (r.subtype && r.subtype !== 'success') {
              failure ||= `${r.subtype}${Array.isArray(r.errors) && r.errors.length ? `: ${String(r.errors[0])}` : ''}`
            }
            break
          }
        }
        if (failure) throw new Error(failure)
        if (desc.trim()) {
          usedLabel = vision.label
          break // berhasil → tak perlu akun cadangan berikutnya
        }
        throw new Error('deskripsi kosong')
      } catch (e) {
        desc = ''
        const why = String(e)
        const limited = isLimitNotice(why) || isLimitError(why)
        const more = candidates.indexOf(vision) < candidates.length - 1
        this.record({
          role: 'system',
          text:
            `⚠️ Akun "${vision.label}" gagal membaca gambar (${limited ? 'kuota/limit' : why.slice(0, 140)})` +
            (more ? ' → mencoba akun berikutnya…' : ' — tak ada akun cadangan lagi.'),
          ts: Date.now()
        })
      }
    }
    const bridged = desc.trim()
      ? `${text}\n\n[DESKRIPSI GAMBAR — sesi ini tak bisa melihat gambar, deskripsi dibuat oleh akun "${usedLabel}"]\n${desc.trim()}`
      : `${text}\n\n[CATATAN: ada ${images.length} gambar terlampir, tapi model sesi ini tak bisa melihatnya dan SEMUA akun jembatan gagal (limit/gangguan). Jawab dengan jujur bahwa gambarnya tak terbaca — jangan menebak isinya.]`
    if (!desc.trim()) {
      this.record({
        role: 'system',
        text: `🚫 Gambar tidak terbaca: ${candidates.length} akun jembatan dicoba, semuanya gagal. Coba lagi nanti, atau pindahkan sesi ini ke akun yang bisa melihat gambar (klik-kanan kartu sesi → Akun).`,
        ts: Date.now()
      })
    }
    this.sendUserMessage(bridged, images, true, true)
  }

  /**
   * /btw — PERTANYAAN SAMPINGAN. Dijawab oleh query SEKALI-JALAN yang benar-benar terpisah:
   * tak me-resume sdkSessionId sesi ini, tak masuk inbox/antrian, tak menambah apa pun ke konteks
   * yang dikirim ulang tiap giliran. Jadi boleh ditanyakan SAAT sesi sedang bekerja — turn yang
   * berjalan tidak terganggu sama sekali.
   *
   * Yang dibawa hanya potongan kecil percakapan terakhir supaya jawabannya nyambung, dan tool
   * DIMATIKAN (allowedTools: []) — ini kanal tanya-jawab, bukan kanal kerja. Biayanya tetap nyata
   * (satu prefix baru), karena itu jawabannya diminta ringkas.
   */
  async askSide(question: string): Promise<void> {
    const q0 = question.trim()
    if (!q0) return
    const launch = this.host.getSessionLaunch(this.meta.id)
    this.record({ role: 'side', text: `❯ ${q0}`, ts: Date.now() })
    if (!launch) {
      this.record({ role: 'side', text: '⛔ Belum ada akun/token untuk sesi ini.', ts: Date.now() })
      this.host.onAccountMissing(this.meta.id)
      return
    }
    const tail = this.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-4)
      .map((m) => `${m.role === 'user' ? 'USER' : 'ASISTEN'}: ${m.text.slice(0, 400)}`)
      .join('\n')
    const prompt =
      '[PERTANYAAN SAMPINGAN] Jawab RINGKAS (maksimal beberapa kalimat). Jangan memakai tool, jangan mengubah file apa pun, ' +
      'jangan melanjutkan pekerjaan yang sedang berjalan — ini hanya pertanyaan sisipan dari user.\n' +
      (tail ? `\nKonteks singkat percakapan yang sedang berjalan (untuk pemahaman saja):\n${tail}\n` : '') +
      `\nPertanyaan: ${q0}`
    this.emitActivity('💬 /btw')
    try {
      const sideQ = query({
        prompt,
        options: {
          model: launch.model,
          ...(launch.effort === 'off'
            ? { thinking: { type: 'disabled' as const } }
            : launch.effort
              ? { effort: launch.effort }
              : {}),
          cwd: this.meta.cwd,
          permissionMode: 'bypassPermissions',
          allowedTools: [], // kanal tanya-jawab: tanpa tool → tak ada efek samping & prefix lebih kecil
          systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
          settingSources: [],
          env: launch.env,
          ...(CLAUDE_EXE ? { pathToClaudeCodeExecutable: CLAUDE_EXE } : {})
        }
      })
      let out = ''
      for await (const m of sideQ as AsyncIterable<Record<string, unknown>>) {
        const type = String(m.type)
        if (type === 'assistant') {
          const content = (m.message as { content?: Array<{ type: string; text?: string }> })?.content ?? []
          for (const b of content) if (b.type === 'text' && b.text) out += b.text
        }
        if (type === 'result') {
          // Biaya /btw NYATA → tetap dicatat ke riwayat pemakaian, jangan disembunyikan.
          const u = m.usage as Record<string, number> | undefined
          if (u) {
            this.host.recordUsage(this.meta.id, {
              input: u.input_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheCreation: u.cache_creation_input_tokens ?? 0,
              output: u.output_tokens ?? 0
            })
          }
          break
        }
      }
      this.record({ role: 'side', text: out.trim() || '(tak ada jawaban)', ts: Date.now() })
    } catch (e) {
      this.record({ role: 'side', text: `⚠️ /btw gagal: ${String(e)}`, ts: Date.now() })
    } finally {
      this.emitActivity(this.meta.status === 'running' ? 'bekerja…' : 'idle')
    }
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
    this.pushRequest(prompt, 'recycle', prompt)
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
        const message = (msg as { message?: { id?: string; content?: unknown[]; usage?: Record<string, number> } })
          .message
        // SDK memecah SATU respons API jadi BEBERAPA pesan 'assistant' — satu per blok konten
        // (thinking / text / tool_use) — semuanya membawa message.id DAN usage yang SAMA
        // (dibuktikan .tmp/probe-assistant-msgs.ts: 1 respons → 3 pesan, usage identik).
        // Tanpa dedup ini, token satu respons tercatat 2-3× → riwayat pemakaian, tokensTotal, dan
        // biaya (mis. panel DeepSeek) menggelembung, dan baris metrik di chat muncul dobel.
        if (!message?.id || message.id !== this.lastUsageMsgId) {
          this.lastUsageMsgId = message?.id ?? null
          this.applyUsage(message?.usage)
        }
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
            const input = formatToolDetail(block.name, block.input)
            const rowId = this.record({
              role: 'tool',
              text: summarizeTool(block.name, block.input),
              ts: Date.now(),
              detail: input,
              toolUseId: block.id
            })
            this.noteFileTouched(block.name, block.input)
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
        this.reconcileTurnUsage(msg as { usage?: Record<string, number> })
        const r = msg as { subtype?: string; errors?: unknown[]; stop_reason?: string }
        const subtype = r.subtype
        const rawResult = JSON.stringify(msg)
        if (isModelRejected(rawResult)) this.modelRejectedPending = true
        if (isStaleSdkSession(rawResult)) this.staleSessionPending = true
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
        // Pesan user yang tertahan selama turn berjalan → kirim SEKARANG (satu per turn). Ditunda bila
        // turn ini akan di-retry/di-recycle/kena limit: pesan user tak boleh nyelip di tengah pemulihan.
        if (!this.transientPending && !this.apiBlockPending && !this.limitHitPending && !this.pendingCompactSeed) {
          this.flushQueued()
        }
        // Model ditolak gateway → pindah ke model cadangan akun lalu ulangi permintaan terakhir.
        if (this.modelRejectedPending && !this.stopped) {
          this.modelRejectedPending = false
          this.recoverRejectedModel()
          break
        }
        // Id sesi SDK basi → mulai sesi bersih di folder SEKARANG lalu ulangi permintaan terakhir.
        if (this.staleSessionPending && !this.stopped) {
          this.staleSessionPending = false
          this.recoverStaleSession()
          break
        }
        // Bila ada permintaan compact tertunda, padatkan konteks sekarang (turn sudah selesai).
        if (this.pendingCompactSeed) this.doCompact()
        else {
          // Keputusan (persen window ATAU plafon token) ada di wakePolicy.compactDecision — fungsi
          // murni yang bisa diuji tanpa SDK, karena inilah jalur penentu biaya per giliran.
          const d = compactDecision(
            this.meta.role,
            this.meta.ctxInput,
            this.meta.ctxWindow,
            this.compactArmed,
            !this.host.providerCachesPrompt(this.meta.id)
          )
          // Pra-compact: titipkan permintaan update handover ke giliran BERIKUTNYA (lihat decorate()).
          if (d.nudge) this.checkpointNudge = true
          if (d.relaxed) {
            // Turn berakhir lega → reset guard futility (compact sebelumnya benar memberi headroom).
            this.compactStreak = 0
            this.compactWarned = false
          } else if (d.compact) {
            if (d.byCeiling) {
              // Persen masih terlihat lega (window besar) → katakan alasan sebenarnya, jangan bikin
              // user mengira badge %-nya rusak.
              this.record({
                role: 'system',
                text: `⟲ Konteks ${Math.round(this.meta.ctxInput / 1000)}k token melewati plafon biaya ${Math.round(compactThresholds(this.meta.role).ceiling / 1000)}k (badge % masih kecil karena window model ini besar). Dipadatkan supaya tiap panggilan tool berikutnya tak menagih ulang konteks sebesar itu.`,
                ts: Date.now()
              })
            }
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

  /**
   * REKONSILIASI TOKEN AKHIR-TURN — sumber kebenarannya pesan `result`, yang membawa TOTAL turn.
   *
   * Kenapa perlu: usage per-pesan tidak selalu lengkap. Untuk akun gateway (jembatan Anthropic→
   * OpenAI), jumlah token keluaran baru diketahui gateway di chunk TERAKHIR, sementara protokol
   * Anthropic menaruh usage pesan di awal — jadi `assistant.usage.output_tokens` selalu 0 dan
   * riwayat pemakaian lokal mencatat 0 output selamanya (diprobe: assistant out=0 vs result out=54).
   *
   * Yang dicatat hanya SELISIHNYA terhadap yang sudah tercatat, jadi akun Claude — yang usage
   * per-pesannya memang sudah benar — tidak terhitung dua kali (selisihnya nol).
   */
  private reconcileTurnUsage(msg: { usage?: Record<string, number> }): void {
    const u = msg.usage
    if (!u) return
    // Sesi gateway: angka di `result` pun campuran (CLI menjumlahkan taksiran message_start dengan
    // angka akhir). Untuk mereka, jembatan yang melaporkan angka nyata — jangan dicatat dua kali.
    if (!this.host.perMessageUsageReliable(this.meta.id)) return
    const total = {
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0
    }
    const missing = {
      input: Math.max(0, total.input - this.turnUsage.input),
      cacheRead: Math.max(0, total.cacheRead - this.turnUsage.cacheRead),
      cacheCreation: Math.max(0, total.cacheCreation - this.turnUsage.cacheCreation),
      output: Math.max(0, total.output - this.turnUsage.output)
    }
    if (!missing.input && !missing.cacheRead && !missing.cacheCreation && !missing.output) return
    this.host.recordUsage(this.meta.id, missing)
    this.turnUsage.input += missing.input
    this.turnUsage.cacheRead += missing.cacheRead
    this.turnUsage.cacheCreation += missing.cacheCreation
    this.turnUsage.output += missing.output
    if (missing.output) {
      // Counter output di UI ikut dibetulkan (dulu diam di 0 untuk akun gateway).
      this.tokensTotal += missing.output
      this.emit({
        channel: 'session:update',
        payload: { id: this.meta.id, tokensTotal: this.tokensTotal, callUsage: missing }
      })
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
    this.lastApiActivity = Date.now()
    // BIAYA: hanya dicatat bila angka per-pesan memang bisa dipercaya. Untuk akun gateway, angka
    // per-pesan cuma taksiran jembatan (gateway melaporkan token sebenarnya di akhir turn) — kalau
    // ikut dicatat, input tercatat berlipat. Angka aslinya masuk lewat reconcileTurnUsage().
    if (this.host.perMessageUsageReliable(this.meta.id)) {
      const rec = {
        input: usage.input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreation: usage.cache_creation_input_tokens ?? 0,
        output: ctxOutput
      }
      this.host.recordUsage(this.meta.id, rec)
      this.turnUsage.input += rec.input
      this.turnUsage.cacheRead += rec.cacheRead
      this.turnUsage.cacheCreation += rec.cacheCreation
      this.turnUsage.output += rec.output
    }
    // UKURAN KONTEKS (badge %, ambang compact) tetap diperbarui untuk SEMUA provider — untuk gateway
    // ini taksiran, tapi taksiran ukuran jauh lebih berguna daripada 0 (tanpa itu auto-compact mati).
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
        ctxPending: false, // ada pengukuran nyata → badge keluar dari mode pending
        callUsage: {
          input: usage.input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheCreation: usage.cache_creation_input_tokens ?? 0,
          output: ctxOutput
        }
      }
    })
    // Hysteresis: begitu konteks NYATA turun < LOW **dan** di bawah plafon token, persenjatai ulang
    // auto-compact. Syarat plafon ikut di sini supaya pada window besar (persen selalu terlihat
    // kecil) hysteresis tak langsung menyala lagi begitu selesai memadatkan.
    const th = compactThresholds(this.meta.role)
    if (contextPercent(ctxInput, this.meta.ctxWindow) < th.low && ctxInput < th.ceiling) this.compactArmed = true
  }
}
