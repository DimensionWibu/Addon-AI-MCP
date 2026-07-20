// Daftar model OpenRouter untuk dropdown "Tambah akun". Diambil LIVE dari API publik OpenRouter
// (tanpa key) supaya selalu terkini — model gratis datang & pergi, jadi hardcode pasti basi.
//
// Grove HANYA menawarkan model yang mendukung tools: seluruh alur Grove (Read/Edit/Bash + MCP grove)
// bertumpu pada tool-calling; model tanpa tools mustahil dipakai di sini, jadi menampilkannya cuma
// menyesatkan. Uji langsung 2026-07-20 membuktikan Nemotron 3 Super membalas tool_use lewat
// "Anthropic Skin" OpenRouter — fondasinya jalan.
import type { OpenRouterModel } from '../shared/types'

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_MS = 60 * 60_000 // 1 jam; daftar model jarang berubah
let cache: { at: number; models: OpenRouterModel[] } | null = null

/** Ekstrak ukuran parameter (mis. "120B") dari id/nama — OpenRouter tak selalu memberi field khusus. */
function paramB(id: string, name: string): string {
  const m = `${id} ${name}`.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b(?![a-z])/)
  return m ? `${m[1]}B` : ''
}

interface RawModel {
  id: string
  name?: string
  context_length?: number
  supported_parameters?: string[]
  pricing?: { prompt?: string | number; completion?: string | number }
}

/**
 * Model OpenRouter yang mendukung tools. `freeOnly` (default true) menyaring yang input & output $0.
 * Diurutkan context terbesar dulu. Gagal jaringan → lempar; pemanggil boleh fallback ke saran statis.
 */
export async function fetchOpenRouterModels(freeOnly = true): Promise<OpenRouterModel[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.models
  const res = await fetch(MODELS_URL)
  if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}`)
  const data = ((await res.json()) as { data?: RawModel[] }).data ?? []
  const models = data
    .filter((m) => (m.supported_parameters ?? []).includes('tools'))
    .filter((m) => !freeOnly || (String(m.pricing?.prompt) === '0' && String(m.pricing?.completion) === '0'))
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      context: m.context_length ?? 0,
      paramB: paramB(m.id, m.name ?? ''),
      free: String(m.pricing?.prompt) === '0' && String(m.pricing?.completion) === '0'
    }))
    .sort((a, b) => b.context - a.context)
  cache = { at: Date.now(), models }
  return models
}
