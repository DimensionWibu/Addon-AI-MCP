// Kebijakan "KAPAN root/parent dibangunkan" + ambang auto-compact.
// DIPISAH dari SessionManager karena dua alasan:
//  1. SessionManager mengimpor `electron` → tak bisa di-import test headless (tsx). File ini murni.
//  2. Semua angka tuning biaya ada di SATU tempat (tabel parameter di _grove_wake_FIX.md).
//
// MODEL BIAYA (dasar semua keputusan di sini): satu "wake" = SATU GILIRAN root, dan tiap giliran
// menagih ULANG seluruh konteks root yang menumpuk. Jadi:
//     total token root ≈ (jumlah wake) × (ukuran konteks root)
// Menekan JUMLAH WAKE jauh lebih besar efeknya daripada memperkecil teks ping (~200-450 token)
// — ukuran ping cuma ~1-5% dari biaya satu giliran root.
import type { SessionRole } from '../../shared/types'

/** Angka tuning jalur wake. MUTABLE by design: test menurunkan jendela ms agar cepat. */
export interface WakeTuning {
  /**
   * Jendela gabung laporan worker → parent (batching jendela TETAP, bukan debounce geser).
   * Dipakai untuk: (a) jaring pengaman laporan TUNTAS yang menunggu turn-end, dan (b) coba-lagi
   * saat parent sedang running. Laporan NON-FINAL tidak memasang timer sama sekali — ia menumpang
   * wake berikutnya (lihat queueParentReport).
   */
  coalesceMs: number
  /** Flush dipercepat saat ada worker TUNTAS — tetap menggabung burst laporan berbarengan. */
  priorityMs: number
  /** Debounce ping board ke root (dipakai HANYA untuk worker yang bukan anak langsung root). */
  rootStatusDebounceMs: number
  /** Interval auto-check berkala "udah sampe mana?". */
  loopIntervalMs: number
  /** Interval ping cache-warm setelah auto-check berhenti (harus < TTL cache 1 jam). */
  cacheWarmIntervalMs: number
  /** Anggap cache prefix stale bila tak ada aktivitas API selama ini. */
  cacheWarmStaleMs: number
  /** Auto-check beruntun tanpa perubahan sebelum beralih ke mode cache-warm. */
  idleCheckLimit: number
  /** Batas panjang satu baris ringkasan board yang disuntik ke ping. */
  boardLineMaxChars: number
  /** Batas total ringkasan board yang disuntik ke ping. */
  boardMaxChars: number
}

export const WAKE: WakeTuning = {
  // 12s → 30s: jendela lama terlalu sempit untuk menangkap worker yang melapor tidak berbarengan
  // (worker A di detik 0, worker B di detik 18 → DUA giliran root). 30s masih jauh di bawah rasa
  // "telat" bagi user karena root tetap di-flush CEPAT (priorityMs) begitu ada worker TUNTAS.
  coalesceMs: 30_000,
  priorityMs: 800,
  rootStatusDebounceMs: 60_000,
  loopIntervalMs: 10 * 60_000,
  cacheWarmIntervalMs: 45 * 60_000,
  cacheWarmStaleMs: 50 * 60_000,
  idleCheckLimit: 3,
  boardLineMaxChars: 160,
  boardMaxChars: 1200
}

/**
 * Ambang auto-compact per ROLE (ctx%).
 * - high = picu compact; low = ambang re-arm (hysteresis anti-thrash).
 * - ROOT sengaja JAUH lebih rendah (70/50): root adalah pihak yang paling sering dibangunkan, jadi
 *   tiap persen konteksnya dikalikan banyak giliran. Root juga butuh HEADROOM — kalau ia baru
 *   dipadatkan di 88%, tiap ping sisa hidupnya ditagih ~88% window. Compact root TIDAK memakai
 *   giliran model (SessionManager.compactSession menyusun ringkasan sendiri dari board), jadi
 *   memadatkan lebih awal nyaris gratis.
 * - SUB tetap 88/70: worker menyimpan detail kerja yang mahal kalau hilang, dan ia jarang
 *   dibangunkan ulang → tak sepadan memadatkannya lebih awal.
 */
export const COMPACT: Record<SessionRole, { high: number; low: number }> = {
  root: { high: 70, low: 50 },
  sub: { high: 88, low: 70 }
}

export function compactThresholds(role: SessionRole): { high: number; low: number } {
  return COMPACT[role] ?? COMPACT.sub
}

/** Satu baris laporan yang ikut menentukan "apakah ada info baru". */
export interface ReportSigItem {
  workerId: string
  percent?: number
  line: string
  done: boolean
}

/**
 * SIGNATURE isi laporan gabungan. Sengaja HANYA field materiil (worker, persen, isi, tuntas) —
 * TANPA timestamp/judul, supaya dua flush dengan isi sama benar-benar terdeteksi sama.
 * Diurutkan per workerId agar urutan kedatangan tak membuat signature palsu-berbeda.
 */
export function reportSignature(items: ReportSigItem[]): string {
  return [...items]
    .sort((a, b) => (a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0))
    .map((i) => `${i.workerId}|${i.percent ?? ''}|${i.done ? 'D' : '-'}|${i.line.replace(/\s+/g, ' ').trim()}`)
    .join('\n')
}

/**
 * FIX 6 — apakah wake ini boleh DILEWATI karena isinya sama persis dengan yang SUDAH dikirim?
 * `prev` hanya di-set saat laporan BENAR-BENAR terkirim, jadi "sama" = parent sudah punya info ini.
 * Berlaku juga untuk laporan TUNTAS: dulu `anyDone` mem-bypass dedupe, sehingga worker yang
 * menutup turn dua kali (mis. lapor 100% lalu turn-end) membangunkan root dua kali dengan isi identik.
 */
export function shouldSkipWake(prev: string | undefined, sig: string): boolean {
  return prev !== undefined && prev === sig
}
