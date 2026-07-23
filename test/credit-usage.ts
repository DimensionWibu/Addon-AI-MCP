// Uji kuota akun ber-API-KEY (src/main/usage.ts) — TANPA jaringan & tanpa key asli: fetch di-stub,
// jadi yang diuji adalah PEMETAAN balasan API → CreditInfo (bagian yang gampang salah diam-diam).
// Jalankan: npx tsx test/credit-usage.ts
//
// Yang dibuktikan:
//  1. Akun OpenRouter/DeepSeek TIDAK PERNAH menyentuh api.anthropic.com (dulu selalu → 401 palsu).
//  2. Key berbatas kredit → persen terpakai terhitung (ambang auto-switch bisa ditegakkan).
//  3. Key free-tier tanpa batas → utilization null + catatan, BUKAN 0% palsu.
//  4. Saldo DeepSeek habis → 100% (memicu proteksi); masih ada saldo → null (jujur: tak ada persen).
//  5. Provider proxy ('custom'/'cursor') → alasan 'unsupported', bukan "token ditolak".
import { fetchUsage } from '../src/main/usage'

let failed = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || !extra ? '' : `\n   ${extra}`}`)
  if (!cond) failed++
}

const hits: string[] = []
const json = (body: unknown, status = 200): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map(),
  json: async () => body
})

/** Stub fetch: catat URL yang ditembak, balas sesuai rute. */
function stub(routes: Record<string, unknown>): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    hits.push(url)
    for (const [frag, res] of Object.entries(routes)) if (url.includes(frag)) return res
    throw new Error(`URL tak terduga: ${url}`)
  }) as unknown as typeof fetch
}

// --- 1 & 2: OpenRouter dengan batas kredit -----------------------------------
stub({
  '/v1/key': json({ data: { label: 'k', limit: 10, usage: 4, limit_remaining: 6, is_free_tier: false } }),
  '/v1/credits': json({ data: { total_credits: 10, total_usage: 4 } })
})
let r = await fetchUsage({ id: 'or-limit', token: 'sk-or-x', provider: 'openrouter' })
check('OpenRouter: tak menyentuh api.anthropic.com', !hits.some((h) => h.includes('anthropic.com')), hits.join(', '))
check('OpenRouter: credit terisi', !!r.usage?.credit, JSON.stringify(r))
check('OpenRouter: 4/10 → 40%', Math.round(r.usage?.credit?.utilization ?? -1) === 40, String(r.usage?.credit?.utilization))
check('OpenRouter: sisa 6', r.usage?.credit?.remaining === 6)
check('OpenRouter: jendela 5-jam sengaja null', r.usage?.fiveHour.utilization === null)

// --- 3: OpenRouter free-tier tanpa batas -------------------------------------
stub({
  '/v1/key': json({
    data: { label: 'free', limit: null, usage: 0.2, limit_remaining: null, is_free_tier: true, rate_limit: { requests: 20, interval: '10s' } }
  }),
  '/v1/credits': json({ data: { total_credits: 0, total_usage: 0.2 } })
})
r = await fetchUsage({ id: 'or-free', token: 'sk-or-y', provider: 'openrouter' })
check('OpenRouter free: utilization null (bukan 0% palsu)', r.usage?.credit?.utilization === null, String(r.usage?.credit?.utilization))
check('OpenRouter free: ada catatan alasan', !!r.usage?.credit?.note, r.usage?.credit?.note ?? '')
check('OpenRouter free: terpakai tetap terbaca', r.usage?.credit?.used === 0.2)

// --- 3b: key ditolak → alasan jujur ------------------------------------------
stub({ '/v1/key': json({}, 401) })
r = await fetchUsage({ id: 'or-bad', token: 'sk-or-z', provider: 'openrouter' })
check('OpenRouter 401 → unauthorized', r.reason === 'unauthorized', String(r.reason))

// --- 4: DeepSeek -------------------------------------------------------------
stub({
  'api.deepseek.com/user/balance': json({
    is_available: true,
    balance_infos: [{ currency: 'USD', total_balance: '3.50', topped_up_balance: '3.50', granted_balance: '0' }]
  })
})
r = await fetchUsage({ id: 'ds-ok', token: 'sk-ds-1', provider: 'deepseek' })
check('DeepSeek: saldo terbaca', r.usage?.credit?.remaining === 3.5, JSON.stringify(r.usage?.credit))
check('DeepSeek: masih bersaldo → utilization null', r.usage?.credit?.utilization === null)

stub({
  'api.deepseek.com/user/balance': json({
    is_available: false,
    balance_infos: [{ currency: 'USD', total_balance: '0', topped_up_balance: '0', granted_balance: '0' }]
  })
})
r = await fetchUsage({ id: 'ds-dry', token: 'sk-ds-2', provider: 'deepseek' })
check('DeepSeek: saldo habis → 100% (memicu proteksi)', r.usage?.credit?.utilization === 100, String(r.usage?.credit?.utilization))

// --- 5: proxy custom/cursor --------------------------------------------------
hits.length = 0
stub({})
r = await fetchUsage({ id: 'cust', token: 'tok', provider: 'custom' })
check("custom → reason 'unsupported'", r.reason === 'unsupported', String(r.reason))
check('custom: tak menembak endpoint apa pun', hits.length === 0, hits.join(', '))

console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek lulus')
process.exit(failed ? 1 : 0)
