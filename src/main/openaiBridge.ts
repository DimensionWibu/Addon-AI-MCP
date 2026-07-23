// JEMBATAN Anthropic ⇄ OpenAI — supaya gateway ber-format OpenAI (DZAX/Belo Store, dan endpoint
// OpenAI-compatible lain) bisa dipakai LANGSUNG oleh Grove tanpa proxy pihak ketiga.
//
// KENAPA PERLU: seluruh Grove berjalan di atas Claude Code CLI, dan CLI itu HANYA bicara Anthropic
// Messages API (`POST /v1/messages`, SSE ala Anthropic). Provider "skin" yang sudah ada (OpenRouter,
// DeepSeek) kebetulan menyediakan endpoint ber-format Anthropic sendiri, jadi cukup base-URL. DZAX
// tidak: ia OpenAI Chat Completions. Tanpa penerjemah, request CLI dijawab 404/400.
//
// CARA KERJA: satu server HTTP lokal (127.0.0.1, port acak) menerima /v1/messages dari CLI,
// menerjemahkannya ke /chat/completions upstream, lalu menerjemahkan balasannya kembali —
// termasuk STREAMING (delta teks & tool-call) yang jadi tulang punggung UX Grove.
//
// Tujuan upstream & model default DIKODE DI PATH (base64url), jadi satu server melayani banyak akun
// tanpa menyimpan state: /u/<base64(baseUrl)>/m/<base64(model)>/v1/messages
// Token TIDAK pernah disimpan di sini — ia diteruskan apa adanya dari header Authorization milik CLI.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')
const unb64 = (s: string): string => Buffer.from(s, 'base64url').toString('utf8')

let server: Server | null = null
let port = 0

/** Nyalakan server jembatan (idempoten). Dipanggil sekali saat app siap. */
export async function startOpenAiBridge(): Promise<number> {
  if (server) return port
  server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: String(e) } })
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  console.log(`[bridge] Anthropic→OpenAI aktif di http://127.0.0.1:${port}`)
  return port
}

export function stopOpenAiBridge(): void {
  server?.close()
  server = null
  port = 0
}

/**
 * Base URL yang dipasang ke ANTHROPIC_BASE_URL untuk sebuah akun. null = jembatan belum menyala.
 * `sessionId` ikut dikodekan supaya jembatan bisa melaporkan token NYATA milik sesi itu (lihat
 * setBridgeUsageSink) — tanpa ini, angka usage yang sampai ke Grove adalah campuran taksiran.
 */
export function bridgeBaseUrl(upstreamBaseUrl: string, model: string, sessionId = ''): string | null {
  if (!port) return null
  return `http://127.0.0.1:${port}/u/${b64(upstreamBaseUrl)}/m/${b64(model)}/s/${b64(sessionId)}`
}

/**
 * PELAPORAN TOKEN YANG JUJUR. Gateway melaporkan token pemakaian di AKHIR respons, sedangkan
 * protokol Anthropic menaruh usage pesan di AWAL — jadi jembatan terpaksa menaksir di awal, dan CLI
 * MENJUMLAHKAN taksiran itu dengan angka akhir (terbukti: 40.480 taksiran + 2.038 nyata = 42.518
 * yang sampai ke Grove). Karena itu angka NYATA dilaporkan langsung dari sini ke SessionManager,
 * dan Session sengaja tidak mencatat apa-apa untuk sesi gateway.
 */
type UsageSink = (sessionId: string, u: { input: number; cacheRead: number; cacheCreation: number; output: number }) => void
let usageSink: UsageSink | null = null
export function setBridgeUsageSink(fn: UsageSink | null): void {
  usageSink = fn
}

// ---------------------------------------------------------------- util HTTP

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Perkiraan token kasar (≈4 char/token) — hanya untuk endpoint count_tokens agar CLI tak 404. */
const roughTokens = (s: string): number => Math.max(1, Math.ceil(s.length / 4))

// ------------------------------------------------------- tipe minimal Anthropic

interface AnthropicBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  content?: unknown
  tool_use_id?: string
  source?: { type?: string; media_type?: string; data?: string }
}
interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicBlock[]
}
interface AnthropicRequest {
  model?: string
  max_tokens?: number
  system?: string | AnthropicBlock[]
  messages?: AnthropicMessage[]
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
  tool_choice?: { type?: string; name?: string }
  stream?: boolean
  temperature?: number
  stop_sequences?: string[]
  output_config?: { effort?: string }
  thinking?: { type?: string }
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<Record<string, unknown>> | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

const textOf = (c: string | AnthropicBlock[] | undefined): string => {
  if (!c) return ''
  if (typeof c === 'string') return c
  return c
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text as string)
    .join('\n')
}

/** Isi tool_result → teks (bisa string, array blok, atau objek). */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const blk = b as AnthropicBlock
        if (blk.type === 'text') return blk.text ?? ''
        if (blk.type === 'image') return '[gambar]'
        return typeof b === 'string' ? b : JSON.stringify(b)
      })
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

/**
 * Anthropic → OpenAI. Yang penting dan gampang salah:
 *  - tool_use (assistant) → tool_calls; tool_result (user) → pesan ber-role 'tool' yang HARUS
 *    muncul SEBELUM sisa isi pesan user itu, karena OpenAI menuntut tool result menempel langsung
 *    pada assistant yang memanggilnya.
 *  - blok `thinking` dibuang: ia milik protokol Anthropic dan tak punya padanan yang aman di sini.
 */
function toOpenAi(req: AnthropicRequest, defaultModel: string): Record<string, unknown> {
  const msgs: OpenAiMessage[] = []
  const sys = textOf(req.system)
  if (sys) msgs.push({ role: 'system', content: sys })

  for (const m of req.messages ?? []) {
    const blocks: AnthropicBlock[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    if (m.role === 'assistant') {
      const text = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text as string)
        .join('\n')
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id ?? `call_${Math.random().toString(36).slice(2)}`,
          type: 'function' as const,
          function: { name: b.name ?? 'tool', arguments: JSON.stringify(b.input ?? {}) }
        }))
      if (text || calls.length) {
        msgs.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) })
      }
      continue
    }
    // role user: tool_result keluar duluan sebagai pesan 'tool'
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        msgs.push({ role: 'tool', tool_call_id: b.tool_use_id ?? '', content: toolResultText(b.content) })
      }
    }
    const parts: Array<Record<string, unknown>> = []
    for (const b of blocks) {
      if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text })
      else if (b.type === 'image' && b.source?.data) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${b.source.media_type ?? 'image/png'};base64,${b.source.data}` }
        })
      }
    }
    if (parts.length) {
      const onlyText = parts.every((p) => p.type === 'text')
      msgs.push({
        role: 'user',
        content: onlyText ? parts.map((p) => String(p.text)).join('\n') : parts
      })
    }
  }

  const out: Record<string, unknown> = {
    model: req.model && req.model.includes('/') ? req.model : defaultModel,
    messages: msgs,
    stream: !!req.stream
  }
  if (req.max_tokens) out.max_tokens = req.max_tokens
  if (typeof req.temperature === 'number') out.temperature = req.temperature
  if (req.stop_sequences?.length) out.stop = req.stop_sequences
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object' } }
    }))
  }
  if (req.tool_choice?.type === 'tool' && req.tool_choice.name) {
    out.tool_choice = { type: 'function', function: { name: req.tool_choice.name } }
  } else if (req.tool_choice?.type === 'any') out.tool_choice = 'required'
  else if (req.tool_choice?.type === 'none') out.tool_choice = 'none'
  // Tingkat mikir: Grove mengirim output_config.effort (low..max); gateway menerima low|medium|high.
  const eff = req.output_config?.effort
  if (eff) out.reasoning_effort = eff === 'xhigh' || eff === 'max' ? 'high' : eff === 'off' ? 'low' : eff
  return out
}

const stopReason = (finish?: string | null): string =>
  finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn'

// ------------------------------------------------------------------ handler

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? ''
  const m = /^\/u\/([^/]+)\/m\/([^/]+)(?:\/s\/([^/]*))?(\/.*)$/.exec(url)
  if (!m) return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `path asing: ${url}` } })
  const upstream = unb64(m[1]).replace(/\/+$/, '')
  const defaultModel = unb64(m[2])
  const sessionId = m[3] ? unb64(m[3]) : ''
  const path = m[4]
  const auth = (req.headers.authorization as string) || (req.headers['x-api-key'] ? `Bearer ${req.headers['x-api-key']}` : '')

  if (req.method !== 'POST') return sendJson(res, 405, { type: 'error', error: { message: 'POST saja' } })
  const raw = await readBody(req)
  const body = JSON.parse(raw || '{}') as AnthropicRequest

  // CLI kadang menghitung token dulu. Jawab perkiraan supaya alurnya tak putus (bukan angka resmi).
  if (path.includes('count_tokens')) {
    const t = roughTokens(textOf(body.system) + JSON.stringify(body.messages ?? []))
    return sendJson(res, 200, { input_tokens: t })
  }

  const payload = toOpenAi(body, defaultModel)
  const upRes = await fetch(`${upstream}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(payload)
  })

  if (!upRes.ok) {
    const text = await upRes.text().catch(() => '')
    return sendJson(res, upRes.status, {
      type: 'error',
      error: { type: upRes.status === 401 ? 'authentication_error' : 'api_error', message: text.slice(0, 2000) }
    })
  }

  if (!body.stream) {
    const j = (await upRes.json()) as {
      id?: string
      model?: string
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const ch = j.choices?.[0]
    const content: unknown[] = []
    if (ch?.message?.content) content.push({ type: 'text', text: ch.message.content })
    for (const c of ch?.message?.tool_calls ?? []) {
      let input: unknown = {}
      try {
        input = JSON.parse(c.function.arguments || '{}')
      } catch {
        input = {}
      }
      content.push({ type: 'tool_use', id: c.id, name: c.function.name, input })
    }
    report(sessionId, j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0)
    return sendJson(res, 200, {
      id: j.id ?? 'msg_bridge',
      type: 'message',
      role: 'assistant',
      model: j.model ?? defaultModel,
      content,
      stop_reason: stopReason(ch?.finish_reason),
      stop_sequence: null,
      usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 }
    })
  }

  // Perkiraan token input untuk message_start: gateway baru melaporkan usage NYATA di chunk TERAKHIR,
  // sedangkan Anthropic menaruh input_tokens di message_start — dan dari situlah Grove menghitung
  // ctx% & memicu auto-compact. Tanpa perkiraan, sesi DZAX tampak selamanya 0% (tak pernah dipadatkan).
  // Angka pastinya tetap dikirim di message_delta begitu tiba.
  const est = roughTokens(JSON.stringify(payload.messages ?? '') + JSON.stringify(payload.tools ?? ''))
  await streamToAnthropic(upRes, res, defaultModel, est, sessionId)
}

/** Terjemahkan SSE OpenAI → SSE Anthropic sambil jalan (tanpa menunggu selesai). */
/** Laporkan token NYATA dari gateway ke Grove (bukan taksiran). */
function report(sessionId: string, input: number, output: number): void {
  if (!sessionId || !usageSink || (!input && !output)) return
  usageSink(sessionId, { input, cacheRead: 0, cacheCreation: 0, output })
}

async function streamToAnthropic(
  upRes: Response,
  res: ServerResponse,
  defaultModel: string,
  estInput = 0,
  sessionId = ''
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const msgId = `msg_${Math.random().toString(36).slice(2)}`
  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: defaultModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: estInput, output_tokens: 0 }
    }
  })

  let nextIndex = 0
  let textIndex: number | null = null
  const toolIdx = new Map<number, number>() // index tool_call OpenAI → index blok Anthropic
  let finish: string | undefined
  let usage = { input_tokens: estInput, output_tokens: 0 }

  const closeText = (): void => {
    if (textIndex != null) {
      send('content_block_stop', { type: 'content_block_stop', index: textIndex })
      textIndex = null
    }
  }

  const reader = upRes.body?.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string
            reasoning_content?: string
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
          }
          finish_reason?: string
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      try {
        chunk = JSON.parse(payload)
      } catch {
        continue
      }
      const ch = chunk.choices?.[0]
      if (chunk.usage && process.env.BRIDGE_DEBUG === '1') console.log('[bridge] usage dari gateway:', JSON.stringify(chunk.usage), '| taksiran awal:', estInput)
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
          output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens
        }
      }
      if (ch?.finish_reason) finish = ch.finish_reason
      const d = ch?.delta
      if (!d) continue
      // reasoning_content SENGAJA DIBUANG: blok `thinking` Anthropic butuh signature yang tak kita
      // punya, dan mengirimnya tanpa itu membuat giliran berikutnya ditolak. Teks jawabannya utuh.
      if (d.content) {
        if (textIndex == null) {
          textIndex = nextIndex++
          send('content_block_start', {
            type: 'content_block_start',
            index: textIndex,
            content_block: { type: 'text', text: '' }
          })
        }
        send('content_block_delta', {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: d.content }
        })
      }
      for (const tc of d.tool_calls ?? []) {
        const oi = tc.index ?? 0
        let idx = toolIdx.get(oi)
        if (idx == null) {
          closeText()
          idx = nextIndex++
          toolIdx.set(oi, idx)
          send('content_block_start', {
            type: 'content_block_start',
            index: idx,
            content_block: { type: 'tool_use', id: tc.id ?? `call_${oi}`, name: tc.function?.name ?? 'tool', input: {} }
          })
        }
        if (tc.function?.arguments) {
          send('content_block_delta', {
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
          })
        }
      }
    }
  }
  closeText()
  for (const idx of toolIdx.values()) send('content_block_stop', { type: 'content_block_stop', index: idx })
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason(finish), stop_sequence: null },
    usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens }
  })
  send('message_stop', { type: 'message_stop' })
  // usage.input_tokens di sini sudah TERTIMPA angka gateway bila ia mengirimnya; kalau tidak, yang
  // tersisa taksiran — dan itu memang yang terbaik yang bisa diketahui.
  report(sessionId, usage.input_tokens, usage.output_tokens)
  res.end()
}
