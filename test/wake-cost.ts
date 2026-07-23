// Uji kebijakan WAKE (jalur "apa yang membangunkan root") + REGRESI BIAYA.
// Jalankan: npx tsx test/wake-cost.ts        (murni, tanpa Electron & tanpa API)
//
// Dua bagian:
//  A. UNIT — fungsi murni di src/main/orchestrator/wakePolicy.ts (signature, dedupe, ambang compact).
//  B. REGRESI BIAYA — simulator jam-virtual yang menjalankan SATU timeline kejadian yang sama lewat
//     DUA kebijakan: LAMA (sebelum fix) dan BARU (WAKE sekarang), lalu membandingkan
//     (jumlah giliran root) dan (total token input root yang ditagih).
//
//     Simulator ini MODEL, bukan kode produksi — ia sengaja meniru algoritma di SessionManager
//     (queueParentReport / flushParentReports / scheduleRootStatus) supaya kebijakan LAMA masih bisa
//     diukur setelah kodenya dihapus. Perilaku kode NYATA diuji terpisah di test/wake-integration.ts.
import { WAKE, COMPACT, compactThresholds, reportSignature, shouldSkipWake } from '../src/main/orchestrator/wakePolicy'

let failed = 0
let passed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)

// ---------------------------------------------------------------- A. UNIT ---
console.log('\n--- A. unit: wakePolicy ---')

const item = (workerId: string, percent: number | undefined, line: string, done = false): {
  workerId: string
  percent?: number
  line: string
  done: boolean
} => ({ workerId, percent, line, done })

// 1. Signature TIDAK bergantung urutan kedatangan (dua flush isi sama = sama).
eq(
  '1. signature stabil lintas urutan',
  reportSignature([item('b', 50, 'dua'), item('a', 25, 'satu')]),
  reportSignature([item('a', 25, 'satu'), item('b', 50, 'dua')])
)

// 2. Persen berubah = info baru → signature WAJIB berbeda (jangan sampai progres nyata di-skip).
check(
  '2. persen berubah → signature beda',
  reportSignature([item('a', 25, 'x')]) !== reportSignature([item('a', 50, 'x')])
)

// 3. Transisi "belum selesai → SELESAI" wajib lolos dedupe walau teksnya sama persis.
check(
  '3. flag done ikut signature (SELESAI tak pernah di-skip)',
  reportSignature([item('a', 100, 'siap')]) !== reportSignature([item('a', 100, 'siap', true)])
)

// 4. Whitespace/newline dinormalkan → laporan sama yang cuma beda pembungkus tak memicu wake.
eq(
  '4. whitespace dinormalkan',
  reportSignature([item('a', 10, 'baris  satu\n dua ')]),
  reportSignature([item('a', 10, 'baris satu dua')])
)

// 5. Wake PERTAMA tak pernah di-skip (belum ada yang pernah dikirim).
eq('5. wake pertama selalu lolos', shouldSkipWake(undefined, 'sig'), false)

// 6. Isi identik dengan yang SUDAH terkirim → skip (ini inti FIX 6).
eq('6. isi identik → skip wake', shouldSkipWake('sig', 'sig'), true)
eq('6b. isi berbeda → tetap wake', shouldSkipWake('sig', 'sig2'), false)

// 7. Ambang compact per role: root JAUH lebih awal daripada sub (FIX 5).
eq('7. ambang root', compactThresholds('root'), { high: 70, low: 50, nudge: 58, ceiling: 150_000 })
eq('7b. ambang sub', compactThresholds('sub'), { high: 88, low: 70, nudge: 76, ceiling: 250_000 })
check('7c. root dipadatkan lebih awal dari sub', COMPACT.root.high < COMPACT.sub.high)
// 7d. Nudge handover HARUS di antara low & high: di bawah low ia terpicu saat konteks masih lega
// (buang giliran), di atas/di high compact keburu jalan sebelum model sempat menulis checkpoint.
check(
  '7d. ambang nudge di antara low & high',
  COMPACT.root.low < COMPACT.root.nudge &&
    COMPACT.root.nudge < COMPACT.root.high &&
    COMPACT.sub.low < COMPACT.sub.nudge &&
    COMPACT.sub.nudge < COMPACT.sub.high
)

// 8. Invarian tuning: hysteresis (low < high) & jendela prioritas < jendela normal.
check('8. hysteresis root & sub valid (low < high)', COMPACT.root.low < COMPACT.root.high && COMPACT.sub.low < COMPACT.sub.high)
check('8b. priorityMs < coalesceMs < rootStatusDebounceMs', WAKE.priorityMs < WAKE.coalesceMs && WAKE.coalesceMs < WAKE.rootStatusDebounceMs)
check('8c. cache-warm di bawah TTL cache 1 jam', WAKE.cacheWarmIntervalMs < 60 * 60_000)
// 8d. INVARIAN BIAYA yang dulu dilanggar: ping cache-warm baru terjadi pada pemeriksaan PERTAMA
// setelah syarat stale terpenuhi → jarak terburuknya stale + interval. Kalau itu melewati TTL 1 jam,
// tiap ping membayar cache-creation (1,25×) lalu cache-nya mati lagi = lebih mahal daripada tidak
// menghangatkan sama sekali. (Angka lama 50 + 45 = 95 menit → gagal di sini.)
check(
  '8d. ping cache-warm terburuk masih di dalam TTL 1 jam',
  WAKE.cacheWarmStaleMs + WAKE.cacheWarmIntervalMs < 60 * 60_000,
  `${(WAKE.cacheWarmStaleMs + WAKE.cacheWarmIntervalMs) / 60000} menit`
)
check('8e. cache-warm punya batas ping (bukan selamanya)', WAKE.cacheWarmMaxPings > 0 && WAKE.cacheWarmMaxPings <= 8)
// 8f. Plafon token HARUS di atas ambang persen untuk window 200k, supaya sesi Claude biasa tidak
// berubah perilakunya — plafon ini memang hanya untuk model berjendela besar.
check(
  '8f. plafon token tak mengubah sesi window 200k',
  COMPACT.root.ceiling > 200_000 * (COMPACT.root.high / 100) && COMPACT.sub.ceiling > 200_000 * (COMPACT.sub.high / 100)
)

// ------------------------------------------------- B. REGRESI BIAYA (SIM) ---
console.log('\n--- B. regresi biaya: LAMA vs BARU pada timeline yang sama ---')

/** Jam virtual + antrian timer — deterministik, tanpa menunggu waktu nyata. */
class Clock {
  now = 0
  private seq = 0
  private timers: { at: number; seq: number; fn: () => void; id: number }[] = []
  private nextId = 1
  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++
    this.timers.push({ at: this.now + ms, seq: this.seq++, fn, id })
    return id
  }
  clearTimeout(id: number | null): void {
    if (id != null) this.timers = this.timers.filter((t) => t.id !== id)
  }
  /** Jalankan sampai `until`; kejadian dari `events` disuntik pada waktunya. */
  run(until: number, events: { at: number; fn: () => void }[]): void {
    const queue = [...events].sort((a, b) => a.at - b.at)
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq)
      const t = this.timers[0]
      const e = queue[0]
      const nextAt = Math.min(t ? t.at : Infinity, e ? e.at : Infinity)
      if (nextAt === Infinity || nextAt > until) break
      if (e && e.at === nextAt) {
        this.now = nextAt
        queue.shift()!.fn()
      } else {
        this.now = nextAt
        this.timers.shift()!.fn()
      }
    }
    this.now = until
  }
}

interface Entry { workerId: string; percent?: number; line: string; done: boolean; awaitTurnEnd: boolean }
interface Policy {
  coalesceMs: number
  priorityMs: number
  rootStatusMs: number
  /** LAMA: laporan progres membangunkan root lewat ping board tersendiri. */
  progressPingsRoot: boolean
  /** BARU: laporan NON-FINAL tak memasang timer — menumpang wake berikutnya. */
  nonFinalRidesAlong: boolean
  /** LAMA: laporan 100% di tengah turn langsung di-flush (hasil akhir menyusul → wake kedua). */
  fastFlushMidTurn: boolean
  /** LAMA: dedupe di-BYPASS bila ada worker done. */
  dedupeSkippedWhenDone: boolean
  /** LAMA: dedupe ping board pakai ringkasan yang memuat baris root → praktis tak pernah kena. */
  pingDedupeEffective: boolean
}

const OLD: Policy = {
  coalesceMs: 12_000,
  priorityMs: 800,
  rootStatusMs: 60_000,
  progressPingsRoot: true,
  nonFinalRidesAlong: false,
  fastFlushMidTurn: true,
  dedupeSkippedWhenDone: true,
  pingDedupeEffective: false
}
const NEW: Policy = {
  coalesceMs: WAKE.coalesceMs,
  priorityMs: WAKE.priorityMs,
  rootStatusMs: WAKE.rootStatusDebounceMs,
  progressPingsRoot: false,
  nonFinalRidesAlong: true,
  fastFlushMidTurn: false,
  dedupeSkippedWhenDone: false,
  pingDedupeEffective: true
}

const ROOT_BUSY_MS = 15_000 // satu giliran root (baca board + balas user) ≈ 15 detik

/** Meniru SessionManager untuk SATU root + N worker anak-langsung. Menghitung wake root. */
class Sim {
  wakes = 0
  private buf = new Map<string, Entry>()
  private timer: number | null = null
  private pingTimer: number | null = null
  private lastSig: string | undefined
  private lastPing: string | undefined
  private busyUntil = 0
  private board = new Map<string, string>() // workerId → status board (untuk signature ping)
  constructor(private readonly p: Policy, private readonly clock: Clock) {}

  private get rootRunning(): boolean {
    return this.clock.now < this.busyUntil
  }
  private wake(): void {
    this.wakes++
    this.busyUntil = this.clock.now + ROOT_BUSY_MS
  }

  /** = SessionManager.reportToParent (worker anak-langsung root). */
  reportToParent(workerId: string, percent: number, line: string, midTurn: boolean): void {
    this.board.set(workerId, `${percent}|${line}`)
    const done = percent >= 100
    if (this.p.progressPingsRoot) {
      this.scheduleRootStatus()
      if (done && this.p.fastFlushMidTurn) this.flushSoon() // buffer sering kosong → no-op
      return
    }
    this.queue({ workerId, percent, line, done, awaitTurnEnd: done && midTurn })
  }

  /** = SessionManager.notifyTurnEnd(outcome) → autoReportFinal → queueParentReport. */
  turnEnd(workerId: string, finalLine: string): void {
    this.board.set(workerId, `done|${finalLine}`)
    this.queue({ workerId, percent: 100, line: finalLine, done: true, awaitTurnEnd: false })
  }

  private queue(e: Entry): void {
    this.buf.set(e.workerId, e)
    if (e.done && !e.awaitTurnEnd) {
      this.flushSoon()
      return
    }
    if (this.p.nonFinalRidesAlong && !e.done) return // non-final: numpang wake berikutnya
    if (this.timer != null) return
    this.timer = this.clock.setTimeout(() => this.flush(), this.p.coalesceMs)
  }
  private flushSoon(): void {
    if (!this.buf.size) return
    this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => this.flush(), this.p.priorityMs)
  }
  private flush(): void {
    this.timer = null
    if (!this.buf.size) return
    if (this.rootRunning) {
      this.timer = this.clock.setTimeout(() => this.flush(), this.p.coalesceMs)
      return
    }
    const items = [...this.buf.values()]
    const sig = reportSignature(items)
    const anyDone = items.some((i) => i.done)
    this.buf.clear()
    const skip = this.p.dedupeSkippedWhenDone && anyDone ? false : shouldSkipWake(this.lastSig, sig)
    if (skip) return
    this.lastSig = sig
    this.wake()
  }

  private scheduleRootStatus(): void {
    this.clock.clearTimeout(this.pingTimer)
    this.pingTimer = this.clock.setTimeout(() => {
      this.pingTimer = null
      if (this.rootRunning) {
        this.scheduleRootStatus()
        return
      }
      const sig = [...this.board.entries()].sort().map(([k, v]) => `${k}|${v}`).join('\n')
      // LAMA: ringkasan memuat baris ROOT (status/judul berubah tiap root membalas) → tak pernah sama.
      const prev = this.p.pingDedupeEffective ? this.lastPing : `${this.lastPing}#${this.wakes}`
      if (shouldSkipWake(prev, sig)) return
      this.lastPing = sig
      this.wake()
    }, this.p.rootStatusMs)
  }
}

/**
 * Skenario NYATA sesi multi-worker: 3 worker paralel selama ~30 menit. Tiap worker melapor progres
 * di ~3 milestone (sesuai instruksi prompt "lapor tiap ~25%"), lalu lapor 100% DI TENGAH turn dan
 * menutup turn-nya beberapa puluh detik kemudian. Ditutup satu turn-end ulangan tanpa info baru
 * (worker menjawab ping root) — kasus yang dulu tetap membangunkan root karena dedupe di-bypass.
 * Jarak antar-laporan sengaja > 1 menit: itu kondisi TERBURUK bagi coalesce (tak ada yang menyatu
 * karena kebetulan berbarengan), jadi angka penghematannya bukan hasil skenario yang dimanjakan.
 */
const MIN = 60_000
function scenario(sim: Sim): { at: number; fn: () => void }[] {
  const ev: { at: number; fn: () => void }[] = []
  const W = ['w1', 'w2', 'w3']
  W.forEach((w, i) => {
    const off = i * 1.5 * MIN
    ev.push({ at: 2 * MIN + off, fn: () => sim.reportToParent(w, 25, `${w} baca file`, true) })
    ev.push({ at: 8 * MIN + off, fn: () => sim.reportToParent(w, 50, `${w} analisa`, true) })
    ev.push({ at: 14 * MIN + off, fn: () => sim.reportToParent(w, 75, `${w} tulis fix`, true) })
    ev.push({ at: 20 * MIN + off, fn: () => sim.reportToParent(w, 100, `${w} beres`, true) })
    ev.push({ at: 20.5 * MIN + off, fn: () => sim.turnEnd(w, `${w} hasil akhir`) })
    ev.push({ at: 25 * MIN + off, fn: () => sim.turnEnd(w, `${w} hasil akhir`) })
  })
  return ev
}

function runPolicy(p: Policy): number {
  const clock = new Clock()
  const sim = new Sim(p, clock)
  clock.run(45 * MIN, scenario(sim))
  return sim.wakes
}

const wakesOld = runPolicy(OLD)
const wakesNew = runPolicy(NEW)
const wakeCut = 1 - wakesNew / wakesOld
console.log(`giliran root : LAMA=${wakesOld}  BARU=${wakesNew}  → turun ${(wakeCut * 100).toFixed(1)}%`)

/**
 * Token input root yang DITAGIH = Σ konteks root pada tiap giliran. Konteks tumbuh tiap giliran dan
 * di-reset saat auto-compact (ambang berbeda root: 88% LAMA vs 70% BARU → FIX 5 ikut terukur di sini).
 */
function billedTokens(wakes: number, highPct: number): number {
  const WINDOW = 200_000
  const GROWTH = 6_000 // tambahan konteks per giliran (laporan + balasan root)
  const AFTER_COMPACT = 15_000 // konteks tepat setelah compact (ringkasan board)
  let ctx = 20_000
  let total = 0
  for (let i = 0; i < wakes; i++) {
    ctx += GROWTH
    if ((ctx / WINDOW) * 100 >= highPct) ctx = AFTER_COMPACT
    total += ctx
  }
  return total
}
const tokOld = billedTokens(wakesOld, 88)
const tokNew = billedTokens(wakesNew, COMPACT.root.high)
const tokCut = 1 - tokNew / tokOld
console.log(
  `token input  : LAMA=${(tokOld / 1000).toFixed(0)}k  BARU=${(tokNew / 1000).toFixed(0)}k  → turun ${(tokCut * 100).toFixed(1)}%`
)

check(`R1. jumlah giliran root turun ≥ 40% (${(wakeCut * 100).toFixed(1)}%)`, wakeCut >= 0.4)
check(`R2. total token input root turun ≥ 40% (${(tokCut * 100).toFixed(1)}%)`, tokCut >= 0.4)
check('R3. laporan tetap sampai (root tetap dibangunkan, bukan nol)', wakesNew > 0)
check('R4. tiap worker tuntas tetap memicu minimal satu giliran root', wakesNew >= 3)

console.log(`\n${failed === 0 ? '✅ SEMUA LULUS' : `❌ ${failed} GAGAL`}  (${passed} lulus)`)
process.exit(failed === 0 ? 0 : 1)
