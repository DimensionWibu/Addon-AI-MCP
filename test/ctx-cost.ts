// BIAYA KONTEKS: dua jalur yang diam-diam menggelembungkan pemakaian token.
// Jalankan: npx tsx test/ctx-cost.ts  (murni, tanpa Electron/SDK)
//
//  A. PLAFON TOKEN auto-compact — pada model berjendela 1 juta, ambang PERSEN baru memicu compact
//     di ratusan ribu token, padahal tiap panggilan tool sesudahnya menagih ULANG konteks sebesar
//     itu. Plafon absolut memotongnya, TANPA mengubah perilaku sesi Claude berjendela 200k.
//  B. CACHE-WARM — jadwal lama (cek 45 mnt, stale 50 mnt) membuat ping nyata jatuh tiap ~90 menit,
//     yaitu SETELAH TTL cache 1 jam habis: tiap ping membayar cache-creation (1,25×) lalu cache-nya
//     mati lagi. Lebih mahal daripada tidak menghangatkan sama sekali, dan berulang selamanya.
import { COMPACT, NO_CACHE_CEILING, WAKE, compactDecision } from '../src/main/orchestrator/wakePolicy'
import { contextWindowFor } from '../src/main/orchestrator/contextWindows'

let failed = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || !extra ? '' : `\n   ${extra}`}`)
  if (!cond) failed++
}

// ---------------------------------------------------------------- A. plafon
const M1 = contextWindowFor('deepseek-v4-pro') // 1.000.000
const CLAUDE = contextWindowFor('opus') // 200.000
check('model DeepSeek dianggap berjendela 1 juta', M1 === 1_000_000, String(M1))

// Sesi CLAUDE 200k: plafon TIDAK boleh mengubah apa pun — persen yang tetap memutuskan.
check(
  'claude 130k (65%) → belum compact (sama seperti sebelum ada plafon)',
  compactDecision('root', 130_000, CLAUDE, true).compact === false
)
check('claude 145k (72%) → compact karena PERSEN', (() => {
  const d = compactDecision('root', 145_000, CLAUDE, true)
  return d.compact && !d.byCeiling
})())

// Sesi berjendela 1 juta: inilah yang dulu bocor.
check('1M · 120k (12%) → belum compact (masih wajar)', compactDecision('root', 120_000, M1, true).compact === false)
check('1M · 130k → nudge handover duluan, belum compact', (() => {
  const d = compactDecision('root', 130_000, M1, true)
  return d.nudge && !d.compact
})())
check('1M · 160k (16%) → COMPACT karena plafon token', (() => {
  const d = compactDecision('root', 160_000, M1, true)
  return d.compact && d.byCeiling
})())
check('1M · sub 200k → belum (plafon sub lebih longgar)', compactDecision('sub', 200_000, M1, true).compact === false)
check('1M · sub 260k → COMPACT karena plafon', compactDecision('sub', 260_000, M1, true).compact === true)
check('plafon tak memicu saat guard mati (armed=false)', compactDecision('root', 900_000, M1, false).compact === false)
check(
  'di atas plafon TIDAK dianggap "lega" walau persennya kecil',
  compactDecision('root', 400_000, M1, true).relaxed === false
)

// Dampak biaya: berapa token yang TIDAK jadi ditagih pada satu turn 15 panggilan tool.
const CALLS = 15
const before = 700_000 // ambang lama pada window 1M (70%)
const after = COMPACT.root.ceiling
const saved = (before - after) * CALLS
console.log(
  `   → satu turn ${CALLS} tool-call di konteks mentok: ${(before * CALLS) / 1e6}M token input LAMA vs ` +
    `${(after * CALLS) / 1e6}M BARU (hemat ${(saved / 1e6).toFixed(1)}M token)`
)
check('hemat > 5 juta token per turn mentok', saved > 5e6)

// ------------------------------------- A2. provider TANPA cache (gateway OpenAI-compatible)
// Di sana tiap token input ditagih PENUH tiap panggilan tool, jadi konteks harus dipadatkan jauh
// lebih awal daripada provider ber-cache.
const CLAUDE_W = 200_000
check('tanpa cache: root 70k sudah COMPACT', compactDecision('root', 70_000, CLAUDE_W, true, true).compact === true)
check('dengan cache: root 70k belum compact', compactDecision('root', 70_000, CLAUDE_W, true, false).compact === false)
check('tanpa cache: sub 90k sudah COMPACT', compactDecision('sub', 90_000, CLAUDE_W, true, true).compact === true)
check('tanpa cache: root 50k masih lega', compactDecision('root', 50_000, CLAUDE_W, true, true).compact === false)
check(
  'tanpa cache: pemicunya plafon (badge % masih kecil)',
  compactDecision('root', 70_000, CLAUDE_W, true, true).byCeiling === true
)
{
  // Dampak pada data NYATA user (98 request, rata-rata 119k input, tarif 1,5x).
  const before = 119_000 * 1.5
  const after = NO_CACHE_CEILING.root * 1.5
  console.log(`   -> per request di gateway tanpa cache: ${(before / 1000).toFixed(0)}k -> maks ${(after / 1000).toFixed(0)}k token tertagih`)
  check('plafon tanpa-cache memangkas >40% biaya per request', after < before * 0.6)
}

// ------------------------------------------------------------ B. cache-warm
/** Simulasi jadwal: kapan ping cache-warm BENAR-BENAR terjadi, dan cache-nya masih hidup atau tidak. */
function simulateWarms(intervalMs: number, staleMs: number, maxPings: number, hours = 12): { at: number; hit: boolean }[] {
  const TTL = 60 * 60_000
  const out: { at: number; hit: boolean }[] = []
  let lastApi = 0
  let pings = 0
  for (let t = intervalMs; t <= hours * 60 * 60_000; t += intervalMs) {
    if (t - lastApi <= staleMs) continue
    if (pings >= maxPings) continue
    pings++
    out.push({ at: t, hit: t - lastApi < TTL }) // hit = cache masih hidup → cache-read (murah)
    lastApi = t
  }
  return out
}

const oldWarms = simulateWarms(45 * 60_000, 50 * 60_000, Number.MAX_SAFE_INTEGER)
const newWarms = simulateWarms(WAKE.cacheWarmIntervalMs, WAKE.cacheWarmStaleMs, WAKE.cacheWarmMaxPings)
check(
  'LAMA: tiap ping jatuh setelah TTL habis → bayar cache-creation',
  oldWarms.length > 0 && oldWarms.every((w) => !w.hit),
  JSON.stringify(oldWarms.map((w) => Math.round(w.at / 60000)))
)
check('BARU: setiap ping masih di dalam TTL → cache-read', newWarms.every((w) => w.hit))
check('BARU: berhenti setelah jatah habis', newWarms.length === WAKE.cacheWarmMaxPings, `${newWarms.length} ping`)
check('LAMA: menghangatkan tanpa batas sepanjang hari', oldWarms.length >= 7)

// Biaya 12 jam menganggur pada konteks 120k, dalam "token setara input"
// (cache-read 0,1× · cache-creation 1,25×).
const CTX = 120_000
const cost = (ws: { hit: boolean }[]): number => ws.reduce((s, w) => s + CTX * (w.hit ? 0.1 : 1.25), 0)
const oldCost = cost(oldWarms)
const newCost = cost(newWarms)
const noWarmCost = CTX * 1.25 // sekali bangun ulang cache saat user kembali
console.log(
  `   → 12 jam menganggur (konteks ${CTX / 1000}k): LAMA ${(oldCost / 1000).toFixed(0)}k setara-input · ` +
    `BARU ${(newCost / 1000).toFixed(0)}k · tanpa warm sama sekali ${(noWarmCost / 1000).toFixed(0)}k`
)
check('BARU jauh lebih murah dari LAMA', newCost < oldCost / 3, `${newCost} vs ${oldCost}`)
check('LAMA bahkan lebih mahal daripada tidak menghangatkan sama sekali', oldCost > noWarmCost)
check('konteks kecil tak dihangatkan sama sekali', WAKE.cacheWarmMinCtx > 0)

console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek lulus')
process.exit(failed ? 1 : 0)
