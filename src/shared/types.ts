// Tipe yang dipakai bersama antara main-process dan renderer.
// (renderer hanya mengimpor sebagai type-only, jadi tidak menyeret kode main.)

// CATATAN: status 'waiting' DIHAPUS — tak pernah ada satu pun `setStatus('waiting')` di kode, jadi
// ia hanya status mati. Fitur "butuh jawaban" yang NYATA memakai flag `awaitingInput` (kartu kedip
// kuning), bukan status ini. Baris DB lama berstatus 'waiting' tetap aman: dipetakan ke 'idle'
// saat dibaca (lihat normalizeStatus di db.ts) dan oleh normalizeStaleStatuses().
export type SessionStatus = 'idle' | 'running' | 'done' | 'error'
export type SessionRole = 'root' | 'sub'

export interface TodoItem {
  text: string
  done: boolean
}

export interface SessionMeta {
  id: string // id internal Grove
  sdkSessionId?: string // session_id dari SDK (untuk resume)
  treeId: string
  parentId: string | null
  role: SessionRole
  title: string
  cwd: string
  model?: string
  status: SessionStatus
  ctxInput: number
  ctxOutput: number
  ctxWindow: number
  orderIndex?: number // urutan manual dalam grup (role+parent) hasil drag; undefined → pakai createdAt
  // Akun Claude yang dipakai sesi ini. undefined = BELUM dipilih → sesi TIDAK akan start.
  // Grove berjalan murni dengan CLAUDE_CODE_OAUTH_TOKEN dari akun GUI; tidak ada lagi jalur diam-diam
  // ke ~/.claude/.credentials.json (login CLI), supaya billing tak pernah nyasar tanpa sepengetahuan user.
  accountId?: string
  /** Mode RINGAN (CLI-parity): true = TANPA MCP server grove (0 tool orkestrasi) & TANPA append
   *  protokol multi-agent → prefix prompt = preset claude_code polos, jauh lebih hemat token per
   *  giliran. Dipakai untuk chat solo sepele. false/undefined = mode orkestrator penuh (bisa
   *  spawn_worker dkk). Default: sesi "+Chat" folderless = lite; drop-folder = orkestrator. */
  lite?: boolean
  /** Tingkat mikir sesi ini. undefined = mewarisi (sesi utama → global → default model). */
  effort?: EffortSetting
  createdAt: number
  updatedAt: number
}

export interface BoardEntry {
  sessionId: string
  summary: string
  todo: TodoItem[]
  progress: string
  percent?: number // 0-100 progres kasar (dari report_progress/report_to_parent); undefined = belum ada
  updatedAt: number
}

export interface InboxMessage {
  id: number
  from: string
  to: string | null // null = broadcast
  body: string
  read: boolean
  ts: number
}

/** Provider akun. 'claude' = langganan Claude (CLAUDE_CODE_OAUTH_TOKEN). 'openrouter' = key
 *  OpenRouter, dipakai lewat "Anthropic Skin" (ANTHROPIC_BASE_URL=https://openrouter.ai/api +
 *  ANTHROPIC_AUTH_TOKEN). 'custom' = endpoint Anthropic-compatible SENDIRI (base URL diisi user) —
 *  mis. proxy lokal yang menerjemahkan Anthropic→Gemini (LiteLLM / claude-code-router), jadi bisa
 *  pakai key Gemini gratis langsung. 'cursor' = varian 'custom' khusus: token Cursor (free) dipakai
 *  lewat proxy Anthropic→Cursor lokal — token = WorkosCursorSessionToken, sama-sama base-URL sendiri
 *  + model dikunci proxy. 'deepseek' = API key DeepSeek (sk-…) langsung ke endpoint Anthropic-compatible
 *  RESMI milik DeepSeek (https://api.deepseek.com/anthropic) — TANPA proxy lokal: cukup token, base URL
 *  konstanta, model deepseek-v4-pro/flash. CATATAN: sama seperti OpenRouter, model non-Claude bisa saja
 *  tak 100% patuh protokol tool Claude Code — uji dulu di satu sesi. */
/** 'dzax' = gateway ber-format OPENAI (DZAX / Belo Store, dan endpoint OpenAI-compatible lain).
 *  Beda mendasar dari provider skin lain: mereka menyediakan endpoint ber-format Anthropic, DZAX
 *  tidak. Karena itu Grove menjalankan jembatan penerjemah lokal (src/main/openaiBridge.ts) dan
 *  ANTHROPIC_BASE_URL diarahkan ke sana, bukan ke gateway-nya langsung. */
export type AccountProvider = 'claude' | 'openrouter' | 'custom' | 'cursor' | 'deepseek' | 'dzax'

/** Provider "Anthropic Skin": Grove kirim format Anthropic, endpoint menerjemahkan; model akun WAJIB. */
export function isSkinProvider(p?: AccountProvider): boolean {
  return p === 'openrouter' || p === 'custom' || p === 'cursor' || p === 'deepseek' || p === 'dzax'
}

/**
 * Provider ini bisa MELIHAT gambar?
 *
 * DeepSeek v4 (pro & flash) menerima blok `image` tanpa error — HTTP 200 — lalu MENGABAIKANNYA
 * diam-diam; saat diuji, modelnya menjawab "TIDAK ADA GAMBAR". Kebutaan yang senyap seperti ini
 * lebih berbahaya daripada error, jadi Grove memperlakukannya sebagai buta dan menjembatani gambar
 * lewat akun lain (lihat Session.describeImagesThenSend). Provider lain dianggap bisa melihat.
 */
export function providerSeesImages(p?: AccountProvider): boolean {
  return p !== 'deepseek'
}

/** Provider yang base URL-nya milik akun sendiri (proxy lokal), bukan konstanta tetap. */
export function usesOwnBaseUrl(p?: AccountProvider): boolean {
  return p === 'custom' || p === 'cursor'
}

/** ANTHROPIC_BASE_URL efektif untuk provider skin. Satu tempat supaya provider baru tak diam-diam
 *  jatuh ke base URL OpenRouter (bug lama yang mengintai di percabangan ternary tersebar). */
export function skinBaseUrl(p?: AccountProvider, ownBaseUrl?: string): string {
  if (usesOwnBaseUrl(p)) return ownBaseUrl || CUSTOM_BASE_URL_DEFAULT
  if (p === 'deepseek') return DEEPSEEK_BASE_URL
  return OPENROUTER_BASE_URL
}

/** Akun untuk dipakai per-session. Token/key TIDAK pernah dikirim ke renderer. */
export interface Account {
  id: string
  label: string
  /** undefined/'claude' = akun Claude; 'openrouter' = key OpenRouter; 'custom' = proxy base-URL sendiri. */
  provider?: AccountProvider
  /** Untuk 'openrouter'/'custom': id model yang WAJIB dipakai akun ini (mis.
   *  nvidia/nemotron-3-super-120b-a12b:free, atau gemini-2.5-flash lewat proxy). Alias claude
   *  (opus/sonnet/haiku) tak berlaku di sini. */
  model?: string
  /** Untuk 'custom': base URL endpoint Anthropic-compatible (proxy), mis. http://localhost:4000.
   *  Claude Code menambahkan /v1/messages sendiri. Token akun dipakai sebagai ANTHROPIC_AUTH_TOKEN. */
  baseUrl?: string
  /** Ukuran paket (mis. 20 untuk Max 20x, 5 untuk Max 5x). Dipakai memilih akun terbesar
   *  sebagai cadangan saat SEMUA akun sudah menembus ambang kuota — agar kerja tak terkunci. */
  plan?: number
  /** Ambang usage (persen) yang memicu pindah akun untuk akun INI. undefined → pakai default global.
   *  Ambang hanya bisa ditegakkan bila usage akun ini TERBACA — lihat `usageReadable`. */
  switchPct?: number
  /** Apakah usage akun ini benar-benar bisa dibaca (probe terakhir). undefined = belum pernah diprobe.
   *  Token `setup-token` (tanpa scope user:profile) TETAP terbaca lewat header rate-limit Messages API,
   *  jadi false di sini berarti benar-benar buntu — mis. token dicabut/kedaluwarsa.
   *  false → ambang tidak aktif; proteksi yang tersisa hanya switch REAKTIF saat kena limit. */
  usageReadable?: boolean
  createdAt: number
}

/** Ringkasan token untuk satu jendela waktu. total = input mentah + cache + output (semua yang mengalir). */
export interface UsageTokens {
  input: number // input "fresh" (non-cache) — paling mahal
  cacheRead: number // dibaca dari cache (murah)
  cacheCreation: number // penulisan cache
  output: number // token keluaran — biasanya penanda "kerja" paling relevan
  total: number // input + cacheRead + cacheCreation + output
  calls: number // jumlah respons API tercatat
}

/** Satu hari pada breakdown riwayat (label lokal + ringkasan tokennya). */
export interface UsageDay {
  label: string // mis. "Sen 20/7"
  dayStart: number // epoch ms awal hari LOKAL
  tokens: UsageTokens
}

/** Pemakaian per akun untuk 7 hari terakhir. */
export interface UsageByAccount {
  accountId: string
  label: string
  provider: AccountProvider
  week: UsageTokens
}

/**
 * Riwayat pemakaian token yang TERCATAT DI PC INI (persist di DB Grove). Bukan angka dari server
 * Anthropic (itu utilisasi rolling-window terpisah) — ini akumulasi token nyata tiap respons API,
 * supaya bisa dilihat pola boros/normal lintas hari.
 */
export interface UsageStats {
  hour: UsageTokens // jam berjalan
  day: UsageTokens // 24 jam terakhir
  week: UsageTokens // 7 hari terakhir
  allTime: UsageTokens // sejak mulai tercatat
  daily: UsageDay[] // breakdown per hari (untuk lihat tren)
  byAccount: UsageByAccount[] // per akun, 7 hari terakhir
  todayVsAvg: number | null // token hari ini ÷ rata-rata harian 7 hari (>1 = di atas rata-rata/boros)
}

/** Saldo akun DeepSeek dari platform (otoritatif — memperhitungkan harga jam sibuk & promo apa pun). */
export interface DeepseekBalance {
  available: boolean // is_available: false = saldo habis / akun tak bisa dipakai
  currency: string
  total: number // total_balance
  toppedUp: number // hasil top-up
  granted: number // kredit hadiah
  fetchedAt: number
}

/** Saldo + perkiraan biaya lokal satu akun DeepSeek (untuk panel usage). */
export interface DeepseekAccountCost {
  accountId: string
  label: string
  model: string
  balance: DeepseekBalance | null // null = gagal ambil (token salah/jaringan) — UI wajib jujur
  error?: string
  /** Perkiraan biaya (USD) dari token yang TERCATAT DI PC INI × harga publik model akun. */
  cost: { hour: number; day: number; week: number; allTime: number }
}

/** Kondisi akun + preferensi rotasi, dikirim bareng agar UI tak pernah setengah-sinkron. */
export interface AccountsState {
  accounts: Account[]
  autoSwitch: boolean
  autoResume: boolean
  /** Ambang yang dipakai akun tanpa `switchPct` sendiri. */
  defaultSwitchPct: number
  /** Akun GLOBAL: dipakai pohon yang tak menentukan akunnya sendiri. null = belum diset. */
  defaultAccountId: string | null
  /** Model GLOBAL: dipakai sesi yang tak menentukan model sendiri. null = default SDK. */
  defaultModel: string | null
  /** Tingkat mikir GLOBAL: dipakai sesi yang tak menentukan sendiri. null = default model. */
  defaultEffort: EffortSetting | null
}

/** Base URL "Anthropic Skin" OpenRouter — Claude Code menambahkan /v1/messages sendiri. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api'

/** Base URL "Anthropic Skin" RESMI DeepSeek — Claude Code menambahkan /v1/messages sendiri.
 *  Bukan proxy lokal: DeepSeek sendiri yang menyediakan endpoint format Anthropic (mendukung
 *  streaming SSE, tool_use, dan blok thinking), jadi akun ini cukup TOKEN saja. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic'

/** Model default akun DeepSeek bila user tak mengisi apa pun. */
export const DEEPSEEK_MODEL_DEFAULT = 'deepseek-v4-pro'

/** Model DeepSeek yang bisa dipilih (persis id dari GET https://api.deepseek.com/models). */
export const DEEPSEEK_MODEL_SUGGESTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro · paling pintar (default)' },
  { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash · cepat & hemat' }
]

/** Harga DeepSeek per 1 JUTA token (USD) — sumber: api-docs.deepseek.com/quick_start/pricing.
 *  `hit` = bagian input yang kena cache (DeepSeek meng-cache otomatis; terbaca sebagai
 *  cache_read_input_tokens lewat endpoint Anthropic-nya) dan harganya ±120× lebih murah dari `miss`
 *  — itulah kenapa SATU sesi panjang jauh lebih hemat daripada banyak sesi pendek. */
export const DEEPSEEK_PRICING: Readonly<Record<string, { miss: number; hit: number; out: number }>> = {
  'deepseek-v4-pro': { miss: 0.435, hit: 0.003625, out: 0.87 },
  'deepseek-v4-flash': { miss: 0.14, hit: 0.0028, out: 0.28 }
}

/** Biaya USD NYATA sebuah pemakaian token DeepSeek. null = model tak ada di tabel harga (jangan tebak). */
export function deepseekCostUsd(
  t: { input: number; cacheRead: number; cacheCreation: number; output: number },
  model?: string
): number | null {
  const p = DEEPSEEK_PRICING[(model || DEEPSEEK_MODEL_DEFAULT).toLowerCase()]
  if (!p) return null
  // DeepSeek tak menagih penulisan cache terpisah (cache_creation selalu 0 lewat endpoint Anthropic).
  // Kalau toh terisi, hitung sebagai input biasa supaya angka tak under-estimate.
  return ((t.input + t.cacheCreation) * p.miss + t.cacheRead * p.hit + t.output * p.out) / 1e6
}

/** Ringkas harga sebuah model DeepSeek untuk tooltip. '' bila model tak dikenal. */
export function deepseekPriceLabel(model?: string): string {
  const key = (model || DEEPSEEK_MODEL_DEFAULT).toLowerCase()
  const p = DEEPSEEK_PRICING[key]
  return p ? `$${p.miss}/M input · $${p.hit}/M input ter-cache · $${p.out}/M output` : ''
}

/**
 * DAFTAR MODEL sebuah akun gateway: field `model` boleh berisi BEBERAPA id dipisah koma, mis.
 * "claude-opus-4.8, claude-sonnet-5, glm-5.2". Yang pertama dipakai default; sisanya jadi CADANGAN
 * saat gateway menolak model (kuota model itu habis / tak diizinkan) — Grove pindah sendiri ke
 * kandidat berikutnya alih-alih membuat sesi mati. Sengaja lewat satu field: tak perlu migrasi DB,
 * dan user bisa mengatur urutannya persis sesuai keinginannya.
 */
export function modelCandidates(model?: string | null): string[] {
  return (model ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
}

/** Model itu milik DeepSeek? Dipakai memutuskan override model per-sesi pada akun DeepSeek. */
export function isDeepSeekModel(model?: string | null): boolean {
  return !!model && /^deepseek[-/]/i.test(model)
}

/** Base URL DZAX (Belo Store). Jalur `/v1` = CROSS-PROVIDER routing — diuji 2026-07-23: jalur
 *  per-family (`/kr/v1`, `/gl/v1`) menolak model dari family lain ("does not match provider prefix"),
 *  sedangkan `/v1` menerima model apa pun yang diizinkan key. Jadi inilah default yang benar. */
export const DZAX_BASE_URL_DEFAULT = 'https://code.dzax.cloud/v1'

/** Saran model DZAX. Key hanya boleh memakai family-nya sendiri (kr/* atau gl/* atau cx/*) — daftar
 *  model yang SAH untuk sebuah key bisa dilihat dari pesan error gateway saat model salah. */
export const DZAX_MODEL_SUGGESTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gl/glm-5.2', label: 'gl/glm-5.2 · GLM family' },
  { id: 'gl/kimi-k3', label: 'gl/kimi-k3' },
  { id: 'gl/kimi-k2.7-code', label: 'gl/kimi-k2.7-code · coding' },
  { id: 'gl/deepseek-v4-pro', label: 'gl/deepseek-v4-pro' },
  { id: 'gl/gpt-5.6-sol', label: 'gl/gpt-5.6-sol' },
  { id: 'kr/claude-sonnet-5', label: 'kr/claude-sonnet-5 · Kiro family' },
  { id: 'kr/claude-opus-4.8', label: 'kr/claude-opus-4.8' },
  { id: 'cx/gpt-5.6-codex', label: 'cx/gpt-5.6-codex · Codex family' }
]

/** Base URL default untuk akun 'custom' (proxy lokal). Cuma prefill form — user boleh ganti.
 *  LiteLLM proxy default :4000; claude-code-router default :3456. */
export const CUSTOM_BASE_URL_DEFAULT = 'http://localhost:4000'

/** Saran nama model untuk akun 'custom' (proxy Gemini). Cuma hint datalist — PROXY yang menentukan
 *  nama model yang sah (mis. LiteLLM butuh prefix 'gemini/…' bila tak dipetakan di config). */
export const CUSTOM_MODEL_SUGGESTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash · cepat, hemat kuota' },
  { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro · kualitas tertinggi' },
  { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash' },
  { id: 'gemini/gemini-2.5-flash', label: 'gemini/gemini-2.5-flash · format LiteLLM' }
]

/** Base URL default untuk akun 'cursor'. Prefill form — user boleh ganti. Default = port
 *  claude-code-proxy (raine/claude-code-proxy): proxy Anthropic-native untuk langganan Cursor,
 *  satu hop (tak perlu jembatan OpenAI). Alternatif Cursor-To-OpenAI + bridge pakai port lain. */
export const CURSOR_BASE_URL_DEFAULT = 'http://localhost:18765'

/** Saran nama model untuk akun 'cursor'. Cuma hint datalist — PROXY yang menentukan nama yang sah.
 *  Nilai di bawah = alias claude-code-proxy; proxy lain (Cursor-To-OpenAI) pakai nama modelnya sendiri. */
export const CURSOR_MODEL_SUGGESTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'cursor', label: 'cursor · pilihan model default proxy' },
  { id: 'composer-2.5', label: 'composer-2.5 · Cursor Composer' },
  { id: 'cursor:claude-3.5-sonnet', label: 'cursor:claude-3.5-sonnet · paksa model tertentu' },
  { id: 'cursor:gpt-4o', label: 'cursor:gpt-4o' }
]

/** Satu model OpenRouter (mendukung tools) untuk dropdown pilih model. */
export interface OpenRouterModel {
  id: string // mis. nvidia/nemotron-3-super-120b-a12b:free
  name: string // nama tampil dari OpenRouter
  context: number // panjang context (token)
  paramB: string // ukuran parameter mis. "120B" ('' bila tak diketahui)
  free: boolean // input & output $0
}

/** Saran model OpenRouter gratis untuk dropdown (id persis dari openrouter.ai/api/v1/models). */
export const OPENROUTER_MODEL_SUGGESTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super (free)' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra (free)' },
  { id: 'nvidia/nemotron-3-nano-30b-a3b:free', label: 'Nemotron 3 Nano 30B (free)' }
]

/**
 * Tingkat "mikir" (reasoning) sebuah sesi. 'off' = thinking DIMATIKAN — tercepat & termurah, untuk
 * tugas mekanis. Sisanya = kedalaman penalaran.
 *
 * DIVERIFIKASI LEWAT PROXY PENCATAT (.tmp/logproxy.cjs) — begini kenyataan di kabel:
 *  - Tingkat low..max → CLI mengirim `output_config: {effort: …}`. Berlaku PENUH untuk Claude
 *    maupun DeepSeek (DeepSeek memetakan low & medium → high, xhigh → max).
 *  - 'off' → CLI TIDAK pernah mengirim `thinking: {type:"disabled"}`; ia hanya MENGHILANGKAN field
 *    `thinking` (yang default-nya `{"type":"adaptive"}`). Untuk Claude itu = tanpa extended thinking.
 *    Untuk DeepSeek, default servernya thinking NYALA, jadi 'off' di sana hanya mencabut petunjuk
 *    adaptif — model TETAP menghasilkan blok thinking. Jangan janjikan "tanpa mikir" untuk DeepSeek.
 */
export type EffortSetting = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Pilihan UI untuk tingkat mikir. value '' = ikut warisan (sesi utama → global → default model). */
export const EFFORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '🧠 default' },
  { value: 'off', label: '🧠 off — tanpa extended thinking (Claude)' },
  { value: 'low', label: '🧠 rendah' },
  { value: 'medium', label: '🧠 sedang' },
  { value: 'high', label: '🧠 tinggi' },
  { value: 'xhigh', label: '🧠 sangat tinggi' },
  { value: 'max', label: '🧠 MAX (paling pintar)' }
]

export function isEffort(v: unknown): v is EffortSetting {
  return v === 'off' || v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max'
}

/** Label pendek sebuah tingkat mikir (untuk badge/menu). Kosong/tak dikenal → 'default'. */
export function effortLabel(v?: string | null): string {
  if (!v) return 'default'
  const hit = EFFORT_OPTIONS.find((e) => e.value === v)
  return hit ? hit.label.replace('🧠 ', '') : v
}

/** Sentinel: opsi "ketik model apa pun" di dropdown model (untuk model lama / versi spesifik). */
export const CUSTOM_MODEL = '__custom__'

/** Pilihan model Claude di UI. value '' = mewarisi/default. Alias (opus/sonnet/haiku) = selalu versi
 *  TERBARU; id ber-versi (claude-opus-4-x) = PIN ke versi itu, termasuk yang lama. Backend menerima
 *  string model APA PUN (query({model})), jadi selain daftar ini user bisa ketik id lain via CUSTOM_MODEL. */
export const MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus (terbaru)' },
  { value: 'sonnet', label: 'Sonnet (terbaru)' },
  { value: 'haiku', label: 'Haiku (terbaru)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' }
]

/** Label pendek untuk sebuah nilai model (untuk badge/pilihan). Nilai tak dikenal → apa adanya. */
export function modelLabel(model?: string | null): string {
  if (!model) return 'Default'
  const hit = MODEL_OPTIONS.find((m) => m.value === model)
  return hit ? hit.label : model
}

/** Hasil "compact": ringkasan konsolidasi 1 pohon, disimpan persist di DB Grove. */
export interface Memory {
  id: number
  treeId: string
  sessionId: string // root yang men-compact
  content: string
  createdAt: number
}

export interface ChatMessage {
  /** 'side' = tanya-jawab SAMPINGAN (/btw): dijawab query terpisah, TIDAK masuk konteks sesi utama. */
  role: 'user' | 'assistant' | 'system' | 'tool' | 'side'
  text: string
  ts: number
  images?: string[] // data URL untuk ditampilkan (tidak dipersist ke DB)
  detail?: string // untuk baris tool: input lengkap (+ output tool saat tiba) yang bisa di-expand
  toolUseId?: string // korelasi live untuk menempel output tool (tidak dipersist)
}

/** Gambar dari clipboard untuk dikirim ke Claude. */
export interface ImageAttachment {
  mediaType: string // mis. "image/png"
  data: string // base64 tanpa prefix "data:..."
}

/** Node pohon untuk sidebar (SessionMeta + persen context + board + anak). */
export interface TreeNode extends SessionMeta {
  ctxPercent: number
  board?: BoardEntry
  loopActive?: boolean // auto-check berkala ("udah sampe mana?") aktif (root saja)
  children: TreeNode[]
}

/** Snapshot penuh untuk render awal UI. */
export interface GroveSnapshot {
  trees: TreeNode[]
  board: BoardEntry[]
  messages: InboxMessage[]
  memories: Memory[]
}

export interface UsageWindow {
  utilization: number | null // persen terpakai
  resetsAt: string | null // ISO timestamp
}

/**
 * Kuota akun ber-API-KEY (OpenRouter / DeepSeek). Bentuknya BUKAN jendela 5-jam/7-hari ala langganan
 * Claude, melainkan KREDIT/SALDO — jadi dibawa terpisah, bukan dipaksa masuk ke UsageWindow.
 *
 * Diambil dari API provider ITU SENDIRI (OpenRouter /api/v1/key + /credits, DeepSeek /user/balance).
 * Dulu semua akun ditembak ke endpoint OAuth Anthropic, termasuk yang key-nya OpenRouter → 401 dan
 * UI bilang "token ditolak/kedaluwarsa" padahal tokennya sehat: pesan yang menyesatkan.
 */
export interface CreditInfo {
  provider: AccountProvider
  currency: string // 'USD' (OpenRouter selalu USD; DeepSeek bisa CNY)
  used: number | null // total terpakai (null = provider tak melaporkannya)
  limit: number | null // batas kredit key (null = tak berbatas / tak diketahui)
  remaining: number | null // sisa kredit/saldo
  /** Persen terpakai. null = TIDAK BISA dihitung jujur (mis. key free-tier tanpa batas kredit) →
   *  ambang auto-switch memang tak bisa ditegakkan untuk akun itu, dan UI mengatakannya apa adanya. */
  utilization: number | null
  freeTier?: boolean
  note?: string // penjelasan singkat untuk UI (mis. bentuk batas free-tier)
  fetchedAt: number
}

export interface UsageInfo {
  fiveHour: UsageWindow
  sevenDay: UsageWindow
  sevenDayOpus?: UsageWindow
  sevenDaySonnet?: UsageWindow
  monthly?: {
    enabled: boolean
    limit: number | null
    used: number | null
    utilization: number | null
    currency: string | null
  }
  /** Terisi HANYA untuk akun API-key (skin provider); jendela 5-jam/7-hari di atas dibiarkan null. */
  credit?: CreditInfo
  fetchedAt: number
  stale?: boolean // true = fetch terakhir gagal, ini nilai last-good (token mungkin sedang refresh)
}

/** Kenapa usage sebuah akun tak bisa ditampilkan — supaya UI jujur, bukan diam-diam kosong. */
export type UsageUnavailable =
  | 'no-token' // akun tak punya token tersimpan
  | 'scope' // 403: token `claude setup-token` tak punya scope user:profile (kasus paling umum)
  | 'unauthorized' // 401: token ditolak/kedaluwarsa
  | 'rate-limited' // 429
  | 'unsupported' // provider ini memang tak punya endpoint kuota (proxy 'custom'/'cursor')
  | 'error' // jaringan/lainnya

/**
 * Usage SELALU dibawa bersama identitas akun pemiliknya. Tanpa ini angka jadi ambigu:
 * user tak bisa tahu "5-jam 19%" itu milik akun mana (bug lama: selalu akun login utama).
 * usage null = tak bisa diketahui untuk akun INI — UI menampilkan alasannya, dan JANGAN
 * pernah menggantinya dengan angka akun lain.
 */
export interface UsageSnapshot {
  accountId: string | null // null = login utama (~/.claude/.credentials.json)
  accountLabel: string
  accountEmail: string | null // hanya bisa didapat bila token punya scope user:profile
  usage: UsageInfo | null
  reason?: UsageUnavailable // terisi saat usage null
}

/** Event yang dikirim main → renderer lewat channel 'grove:event'. */
export type GroveEvent =
  | { channel: 'session:new'; payload: SessionMeta & { ctxPercent: number } }
  | {
      channel: 'session:update'
      payload: { id: string } & Partial<SessionMeta> & {
          ctxPercent?: number
          ctxPending?: boolean // true = konteks baru di-reset (compact); UI tampilkan badge netral, bukan 0%
          tokensTotal?: number
          loopActive?: boolean
          apiStopped?: boolean
          awaitingInput?: boolean // turn berhenti menunggu jawaban user/parent → kartu berkedip kuning
          /** Rincian token SATU respons API (call) — dipakai panel LOG untuk diagnosa "kenapa berat".
           *  input=fresh, cacheRead/cacheCreation=konteks ter-cache, output=hasil. ctx call = input+cacheRead+cacheCreation. */
          callUsage?: { input: number; cacheRead: number; cacheCreation: number; output: number }
        }
    }
  | { channel: 'chat:delta'; payload: { id: string; delta: string } }
  | { channel: 'chat:message'; payload: { id: string; message: ChatMessage } }
  | { channel: 'chat:detail'; payload: { id: string; toolUseId: string; detail: string } }
  /** Teks MENTAH yang Grove kirim ke query() tiap giliran (prompt user + reseed konteks + auto-task
   *  yang TAK direkam ke chat). Untuk node "REQUEST" di panel LOG. CATATAN JUJUR: ini teks yang Grove
   *  kontrol/inject, BUKAN body HTTP byte-exact ke /v1/messages (system prompt + transcript + skema
   *  tools dirakit di dalam subprocess SDK, tak ter-expose ke JS). */
  | {
      channel: 'log:request'
      payload: { id: string; kind: 'user' | 'auto' | 'recycle'; text: string; bytes: number; images: number }
    }
  /** Antrian pesan user yang DITAHAN Grove selama turn berjalan (masih bisa diedit/dibatalkan). */
  | { channel: 'queue:update'; payload: { id: string; items: Array<{ qid: number; text: string }> } }
  | { channel: 'board:update'; payload: BoardEntry }
  | { channel: 'message:new'; payload: InboxMessage }
  | { channel: 'memory:new'; payload: Memory }
  | {
      channel: 'accounts:update'
      // Sengaja memakai AccountsState yang SAMA dengan listAccounts() — dulu tipe ini disalin
      // inline, lalu ikut basi tiap kali ada field baru (bug: renderer tak melihat field itu).
      payload: AccountsState
    }
  | { channel: 'session:removed'; payload: { ids: string[] } }
  | { channel: 'session:activity'; payload: { id: string; activity: string } }
  | { channel: 'usage:update'; payload: UsageSnapshot }
  /** Sesi tak bisa jalan karena belum ada akun/token. UI menampilkan banner, app TETAP jalan. */
  | {
      channel: 'auth:missing'
      payload: {
        sessionId: string
        sessionTitle: string
        /** true = akun sudah dipilih tapi tokennya hilang; false = memang belum pilih akun sama sekali. */
        tokenMissing: boolean
        /** Ada tidaknya akun tersimpan — menentukan bunyi ajakan ("tambah akun" vs "pilih akun"). */
        hasAccounts: boolean
      }
    }

/** API yang dibuka preload sebagai window.grove */
export interface GroveApi {
  getPathForFile: (file: File) => string
  dropFolder: (path: string, title?: string) => Promise<SessionMeta>
  newChat: (title?: string) => Promise<SessionMeta>
  /** Sub-worker BARU di bawah sesi `parentId` (klik 3× kartu sesi). Idle & tanpa tugas — nol token
   *  sampai user mengirim pesan pertamanya. */
  newWorker: (parentId: string, title?: string) => Promise<SessionMeta>
  pickFolder: () => Promise<SessionMeta | null>
  /** Kunci sesi yang SUDAH ADA ke folder project (drag-drop folder ke kartu sesi). */
  setSessionCwd: (id: string, path: string) => Promise<SessionMeta>
  sendChat: (id: string, text: string, images?: ImageAttachment[]) => Promise<void>
  /** /btw — pertanyaan SAMPINGAN: dijawab query sekali-jalan yang terpisah, tanpa menyentuh konteks
   *  & antrian sesi utama (boleh dipakai saat sesi sedang bekerja). */
  askSide: (id: string, question: string) => Promise<void>
  /** Saldo DeepSeek (dari platform) + perkiraan biaya lokal per jendela waktu, untuk tiap akun DS. */
  getDeepseekCosts: () => Promise<DeepseekAccountCost[]>
  /** Pesan yang masih ANTRI di sesi ini (dikirim setelah turn berjalan selesai). */
  listQueued: (id: string) => Promise<Array<{ qid: number; text: string }>>
  /** Ubah isi pesan yang masih antri. false = sudah terlanjur terkirim. */
  editQueued: (id: string, qid: number, text: string) => Promise<boolean>
  /** Batalkan pesan yang masih antri. false = sudah terlanjur terkirim. */
  cancelQueued: (id: string, qid: number) => Promise<boolean>
  /** Tautkan referensi SATU ARAH: `helperId` boleh membantu `targetId`. Arah balik ditolak. */
  linkReference: (helperId: string, targetId: string) => Promise<void>
  unlinkReference: (helperId: string, targetId: string) => Promise<void>
  /** Sesi-sesi yang boleh dibantu oleh `helperId`. */
  listReferences: (helperId: string) => Promise<Array<{ id: string; title: string; status: string; cwd: string }>>
  stopSession: (id: string) => Promise<void>
  stopAll: () => Promise<number>
  reorderSessions: (orderedIds: string[]) => Promise<void>
  compactSession: (id: string) => Promise<void>
  setLoop: (id: string, enabled: boolean) => Promise<void>
  listAccounts: () => Promise<AccountsState>
  addAccount: (
    label: string,
    token: string,
    plan?: number,
    switchPct?: number,
    provider?: AccountProvider,
    model?: string,
    baseUrl?: string
  ) => Promise<Account>
  deleteAccount: (id: string) => Promise<void>
  /** Ambang auto-switch akun ini; null → kembali ikut default global. */
  setAccountSwitchPct: (id: string, pct: number | null) => Promise<void>
  /** Ambang default untuk akun yang tak punya ambang sendiri. */
  setDefaultSwitchPct: (pct: number) => Promise<void>
  /** Akun GLOBAL: dipakai semua pohon yang tak menentukan akunnya sendiri. */
  setDefaultAccount: (accountId: string | null) => Promise<void>
  /** Model GLOBAL: dipakai semua sesi yang tak menentukan model sendiri. */
  setDefaultModel: (model: string | null) => Promise<void>
  /** Model sebuah sesi (null = kembali mewarisi dari sesi utama / global). */
  setSessionModel: (id: string, model: string | null) => Promise<void>
  /** Tingkat mikir sebuah sesi (null = kembali mewarisi). Berlaku di giliran berikutnya. */
  setSessionEffort: (id: string, effort: EffortSetting | null) => Promise<void>
  /** Tingkat mikir GLOBAL untuk sesi yang tak menentukan sendiri. */
  setDefaultEffort: (effort: EffortSetting | null) => Promise<void>
  /** Mode ringan (CLI-parity, tanpa protokol/tool orkestrasi) untuk sebuah root. Berlaku pada
   *  giliran berikutnya (query di-restart bila sedang jalan). */
  setLite: (id: string, lite: boolean) => Promise<void>
  /** Model yang bisa dipakai akun gateway: gabungan daftar milik akun + hasil GET <base>/models. */
  listGatewayModels: (accountId: string) => Promise<string[]>
  /** Daftar model OpenRouter (mendukung tools) untuk dropdown; freeOnly default true. */
  listOpenRouterModels: (freeOnly?: boolean) => Promise<OpenRouterModel[]>
  /** Riwayat pemakaian token tercatat di PC ini (jam/hari/minggu + tren) untuk cek boros/normal. */
  getUsageStats: () => Promise<UsageStats>
  setSessionAccount: (id: string, accountId: string | null) => Promise<void>
  setAutoSwitch: (on: boolean) => Promise<void>
  setAutoResume: (on: boolean) => Promise<void>
  interruptSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<string[]>
  getSnapshot: () => Promise<GroveSnapshot>
  getChat: (id: string) => Promise<ChatMessage[]>
  /** Refresh MANUAL usage akun sesi terpilih (tombol ↻). Ber-cooldown 10s di main → klik saat cooldown balik cache. */
  refreshUsage: () => Promise<UsageSnapshot>
  /** Beri tahu main sesi mana yang sedang dipilih; balikan = snapshot cache akun itu (tanpa nunggu fetch). */
  setUsageSession: (sessionId: string | null) => Promise<UsageSnapshot>
  onEvent: (cb: (ev: GroveEvent) => void) => () => void
}

declare global {
  interface Window {
    grove: GroveApi
  }
}
