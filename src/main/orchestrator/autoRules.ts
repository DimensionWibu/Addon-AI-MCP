// ATURAN OTOMATIS BUATAN USER — jaring KEDUA di atas deteksi bawaan (isTransientError, isLimitError,
// isModelRejected, dst di Session.ts).
//
// Kenapa perlu: pola kegagalan provider berubah terus. Tiap kali OpenRouter/proxy memunculkan kalimat
// error baru ("ResourceExhausted", "no endpoints found", "Provider returned error"), dulu satu-satunya
// jalan adalah menambah regex di kode lalu build ulang. Dengan aturan ini user bisa menambahkan kata
// kuncinya sendiri lewat panel Setting dan memilih apa yang harus Grove lakukan.
//
// Disengaja: aturan user dicek SESUDAH deteksi bawaan. Bawaan sudah teruji dan punya penanganan yang
// lebih kaya (mis. limit → rotasi akun + pin dikembalikan); aturan user mengisi yang BELUM dikenali,
// bukan menimpanya.
import type { AutoRule, AutoRuleAction } from '../../shared/types'

/** Teks yang dipindai dibatasi agar regex user tak pernah jadi beban di transkrip raksasa. */
const MAX_SCAN_CHARS = 8000
const MAX_RULES = 100
const MAX_PATTERN_CHARS = 300

/** Aksi → kalimat pendek untuk catatan di chat ("aturan X cocok → …"). */
export const AUTO_ACTION_LABEL: Record<AutoRuleAction, string> = {
  retry: 'coba ulang otomatis (backoff)',
  model: 'ganti ke model cadangan',
  account: 'ganti akun',
  resend: 'ulangi permintaan terakhir'
}

/**
 * Contoh bawaan — sengaja diisi pola yang MEMANG sering muncul di OpenRouter/gateway, sekaligus jadi
 * contoh format buat user. Semuanya boleh dihapus/diubah dari panel Setting.
 */
export const DEFAULT_AUTO_RULES: AutoRule[] = [
  {
    id: 'seed-resource-exhausted',
    label: 'Kapasitas provider penuh',
    pattern: 'ResourceExhausted',
    action: 'retry',
    enabled: true
  },
  {
    id: 'seed-no-endpoints',
    label: 'Model tak punya endpoint aktif',
    pattern: 'no endpoints found',
    action: 'model',
    enabled: true
  },
  {
    id: 'seed-too-many-requests',
    label: 'Rate-limit sesaat',
    pattern: 'too many requests',
    action: 'retry',
    enabled: true
  }
]

const ACTIONS: AutoRuleAction[] = ['retry', 'model', 'account', 'resend']

/**
 * Bersihkan daftar aturan dari sumber yang TIDAK dipercaya (isi DB lama, file config hasil import).
 * Baris yang bentuknya salah dibuang diam-diam — satu baris rusak tak boleh menjatuhkan seluruh
 * daftar (dan tak boleh menghentikan Session yang sedang jalan).
 */
export function sanitizeRules(raw: unknown): AutoRule[] {
  if (!Array.isArray(raw)) return []
  const out: AutoRule[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Partial<AutoRule>
    const pattern = typeof r.pattern === 'string' ? r.pattern.trim().slice(0, MAX_PATTERN_CHARS) : ''
    if (!pattern) continue
    const action = ACTIONS.includes(r.action as AutoRuleAction) ? (r.action as AutoRuleAction) : 'retry'
    let id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 64) : `rule-${out.length + 1}`
    while (seen.has(id)) id = `${id}-x` // id kembar (mis. dua file config digabung) → dibedakan
    seen.add(id)
    out.push({
      id,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 80) : pattern.slice(0, 80),
      pattern,
      regex: r.regex === true,
      action,
      enabled: r.enabled !== false // tak disebut → dianggap aktif
    })
    if (out.length >= MAX_RULES) break
  }
  return out
}

/** Baca JSON aturan dari DB / file config. JSON rusak → daftar kosong (jangan menjatuhkan startup). */
export function parseRules(json: string): AutoRule[] {
  try {
    return sanitizeRules(JSON.parse(json))
  } catch {
    return []
  }
}

/** Regex user yang tak valid TIDAK boleh melempar — kembalikan null, aturan itu sekadar tak pernah cocok. */
function compile(rule: AutoRule): RegExp | null {
  try {
    return new RegExp(rule.regex ? rule.pattern : escapeLiteral(rule.pattern), 'i')
  } catch {
    return null
  }
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Aturan AKTIF pertama yang cocok dengan `text`. null = tak ada yang cocok.
 * Urutan daftar = prioritas (yang di atas menang) supaya user bisa mengatur mana yang didahulukan.
 */
export function matchAutoRule(text: string, rules: AutoRule[]): AutoRule | null {
  if (!text) return null
  const hay = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  for (const rule of rules) {
    if (!rule.enabled) continue
    const re = compile(rule)
    if (re?.test(hay)) return rule
  }
  return null
}
