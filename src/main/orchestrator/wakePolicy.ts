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
  /** Seberapa sering kondisi cache-warm DIPERIKSA (bukan seberapa sering ping dikirim). */
  cacheWarmIntervalMs: number
  /** Anggap cache prefix stale bila tak ada aktivitas API selama ini. */
  cacheWarmStaleMs: number
  /** Ping cache-warm BERUNTUN maksimal tanpa aktivitas nyata; setelahnya berhenti total. */
  cacheWarmMaxPings: number
  /** Konteks di bawah ini tak layak dihangatkan (hematannya tak sepadan satu giliran). */
  cacheWarmMinCtx: number
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
  // BUG BIAYA YANG DIPERBAIKI (angka lama: cek 45 mnt + stale 50 mnt): syarat stale baru terpenuhi
  // pada pemeriksaan BERIKUTNYA, jadi ping nyata terjadi tiap ~90 menit — melewati TTL cache 1 jam.
  // Akibatnya tiap ping justru membayar CACHE CREATION (1,25× harga input) atas SELURUH konteks,
  // lalu cache-nya mati lagi sebelum ping berikutnya: kebalikan dari tujuannya, dan berulang
  // selamanya pada sesi yang menganggur. Sekarang: periksa tiap 15 mnt, ping saat diam ≥40 mnt →
  // ping paling lambat di menit ke-55, masih DI DALAM TTL, jadi yang dibayar cache-read (0,1×).
  cacheWarmIntervalMs: 15 * 60_000,
  cacheWarmStaleMs: 40 * 60_000,
  // Sesi yang benar-benar ditinggalkan tak boleh membakar kuota tanpa batas: setelah 4 ping beruntun
  // tanpa aktivitas NYATA (≈3 jam), cache-warm berhenti total. Menghangatkan lebih lama tak pernah
  // impas — sekali bayar cache-creation saat user kembali jauh lebih murah daripada menghangatkan
  // konteks besar seharian. Jatah ini pulih begitu ada tugas baru (enableLoop).
  cacheWarmMaxPings: 4,
  cacheWarmMinCtx: 20_000,
  idleCheckLimit: 3,
  boardLineMaxChars: 160,
  boardMaxChars: 1200
}

/**
 * Ambang auto-compact per ROLE (ctx%).
 * - high = picu compact; low = ambang re-arm (hysteresis anti-thrash).
 * - nudge = ambang PRA-compact: sekali lewat sini, giliran BERIKUTNYA disisipi permintaan agar model
 *   memperbarui file handover-nya (.grove/checkpoint-<id>.md) selagi konteksnya masih utuh. Sengaja
 *   MENUMPANG giliran yang memang akan terjadi — bukan giliran tersendiri — jadi biayanya cuma teks
 *   instruksi, bukan satu putaran penuh atas konteks yang sedang besar. Kalau model tak menurut,
 *   Grove tetap menulis versi deterministiknya sendiri saat compact (lihat handover.ts).
 * - ROOT sengaja JAUH lebih rendah (70/50): root adalah pihak yang paling sering dibangunkan, jadi
 *   tiap persen konteksnya dikalikan banyak giliran. Root juga butuh HEADROOM — kalau ia baru
 *   dipadatkan di 88%, tiap ping sisa hidupnya ditagih ~88% window. Compact root TIDAK memakai
 *   giliran model (SessionManager.compactSession menyusun ringkasan sendiri dari board), jadi
 *   memadatkan lebih awal nyaris gratis.
 * - SUB tetap 88/70: worker menyimpan detail kerja yang mahal kalau hilang, dan ia jarang
 *   dibangunkan ulang → tak sepadan memadatkannya lebih awal.
 *
 * `ceiling` = PLAFON TOKEN ABSOLUT, penjaga kedua di samping persentase. Persen saja tidak cukup
 * karena BIAYA satu giliran ditentukan jumlah token, bukan rasio terhadap window: pada model
 * berjendela 1 juta (DeepSeek v4, varian Claude [1m]) ambang 70% baru memicu compact di ~700k, dan
 * SETIAP panggilan tool sesudahnya menagih ulang konteks sebesar itu — di akun langganan Claude
 * inilah yang membuat kuota membengkak diam-diam. Angkanya sengaja DI ATAS ambang persen untuk
 * window 200k (root 70% = 140k, sub 88% = 176k), jadi perilaku sesi Claude biasa tidak berubah
 * sama sekali; plafon ini hanya menggigit pada window besar.
 */
export const COMPACT: Record<SessionRole, { high: number; low: number; nudge: number; ceiling: number }> = {
  root: { high: 70, low: 50, nudge: 58, ceiling: 150_000 },
  sub: { high: 88, low: 70, nudge: 76, ceiling: 250_000 }
}

/**
 * PLAFON UNTUK PROVIDER TANPA CACHE PROMPT (mis. gateway OpenAI-compatible seperti Shiteru/DZAX —
 * diperiksa: balasannya tak punya field cached_tokens sama sekali).
 *
 * Seluruh tuning Grove yang lain berasumsi ada cache: konteks besar boleh dibiarkan karena
 * pengirimannya ulang ditagih ~0,1x. Di gateway tanpa cache, SETIAP token input ditagih PENUH tiap
 * panggilan tool — dan pada model bertarif kelipatan (Opus 4.8 = 1,5x) biayanya berlipat lagi.
 * Diukur dari log nyata user: 98 request dalam 16 menit = 11,7 juta token input (rata-rata 119k) dan
 * 17,6 juta token tertagih, sementara OUTPUT-nya cuma 53k (0,45%). Menjaga konteks di bawah 80k pada
 * data yang sama memangkas ~37% tagihan.
 */
export const NO_CACHE_CEILING: Record<SessionRole, number> = {
  root: 60_000,
  sub: 80_000
}

export function compactThresholds(role: SessionRole): {
  high: number
  low: number
  nudge: number
  ceiling: number
} {
  return COMPACT[role] ?? COMPACT.sub
}

/** Apa yang harus dilakukan pada akhir sebuah giliran, dilihat dari ukuran konteks. */
export interface CompactDecision {
  /** Konteks lega → reset guard "compact berulang tak menolong". */
  relaxed: boolean
  /** Titipkan permintaan update handover ke giliran berikutnya (pra-compact). */
  nudge: boolean
  /** Padatkan sekarang. */
  compact: boolean
  /** Pemicunya PLAFON TOKEN, bukan persen — dipakai menjelaskan ke user kenapa badge % masih kecil. */
  byCeiling: boolean
}

/**
 * Keputusan compact akhir-giliran. Fungsi MURNI (di sini, bukan di Session) supaya bisa diuji tanpa
 * SDK — inilah jalur yang menentukan biaya: salah sedikit, tiap panggilan tool menagih ulang konteks
 * raksasa. Dua pemicu, sengaja OR: persen window (menjaga sesi tak mentok) dan plafon token
 * (menjaga biaya per giliran, satu-satunya yang relevan pada model berjendela 1 juta).
 */
export function compactDecision(
  role: SessionRole,
  ctxInput: number,
  ctxWindow: number,
  armed: boolean,
  noCache = false
): CompactDecision {
  const t = compactThresholds(role)
  const { high, low, nudge } = t
  // Tanpa cache prompt, ukuran konteks berbanding LURUS dengan tagihan tiap panggilan tool → dipadatkan
  // jauh lebih awal. Dengan cache, plafon longgar memang lebih murah daripada sering membangun ulang.
  const ceiling = noCache ? Math.min(t.ceiling, NO_CACHE_CEILING[role] ?? t.ceiling) : t.ceiling
  const pct = ctxWindow > 0 ? (ctxInput / ctxWindow) * 100 : 0
  const overCeiling = ctxInput >= ceiling
  const full = pct >= high || overCeiling
  return {
    relaxed: pct < low && !overCeiling,
    nudge: !full && (pct >= nudge || ctxInput >= ceiling * 0.85),
    compact: armed && full,
    byCeiling: overCeiling && pct < high
  }
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
