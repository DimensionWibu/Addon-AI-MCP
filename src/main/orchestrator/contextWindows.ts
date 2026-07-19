// Ukuran context window per model → dipakai menghitung % context.
// Dibuat konfigurabel; default 200k. Varian [1m] = 1 juta token.

const DEFAULT_WINDOW = 200_000

export function contextWindowFor(model?: string): number {
  if (!model) return DEFAULT_WINDOW
  const m = model.toLowerCase()
  if (m.includes('[1m]') || m.includes('-1m') || m.includes('1m]')) return 1_000_000
  // opus / sonnet / haiku modern = 200k
  return DEFAULT_WINDOW
}

/** Persen isi window saat ini. ctxUsed diperlakukan sebagai token input turn terakhir
 *  (mencerminkan isi window nyata), di-clamp 0..100. */
export function contextPercent(ctxUsed: number, ctxWindow: number): number {
  if (!ctxWindow || ctxWindow <= 0) return 0
  const p = (ctxUsed / ctxWindow) * 100
  return Math.max(0, Math.min(100, Math.round(p * 10) / 10))
}
