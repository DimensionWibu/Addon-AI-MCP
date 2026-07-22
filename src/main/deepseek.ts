// Saldo akun DeepSeek — angka OTORITATIF dari platform (beda dari perkiraan biaya lokal Grove yang
// dihitung dari token tercatat × harga publik). Endpoint resmi: GET https://api.deepseek.com/user/balance
// Balasan: { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
import type { DeepseekBalance } from '../shared/types'

const URL = 'https://api.deepseek.com/user/balance'
const TTL_MS = 60_000 // saldo tak berubah tiap detik; cache 1 menit supaya panel tak menghujani API

const cache = new Map<string, { at: number; value: DeepseekBalance }>()

export async function fetchDeepseekBalance(token: string): Promise<DeepseekBalance> {
  const hit = cache.get(token)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const res = await fetch(URL, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`balance HTTP ${res.status}`)
  const j = (await res.json()) as {
    is_available?: boolean
    balance_infos?: Array<{ currency?: string; total_balance?: string; topped_up_balance?: string; granted_balance?: string }>
  }
  // Utamakan USD; kalau akun bermata uang lain (CNY), pakai baris pertama apa adanya & sebut mata uangnya.
  const info = j.balance_infos?.find((b) => b.currency === 'USD') ?? j.balance_infos?.[0]
  const value: DeepseekBalance = {
    available: !!j.is_available,
    currency: info?.currency ?? 'USD',
    total: Number(info?.total_balance ?? 0),
    toppedUp: Number(info?.topped_up_balance ?? 0),
    granted: Number(info?.granted_balance ?? 0),
    fetchedAt: Date.now()
  }
  cache.set(token, { at: Date.now(), value })
  return value
}
