// HANDOVER FILE — jaring pengaman konteks saat compact.
//
// Masalahnya: compact MELEPAS transkrip SDK (sdkSessionId dibuang) dan hanya menyisakan ringkasan
// board beberapa baris. Kalau model belum sempat menulis checkpoint-nya sendiri, detail kerja
// (file yang disentuh, keputusan, langkah berikutnya) HILANG dan sesi berikutnya menebak-nebak.
//
// Karena itu tiap sesi punya SATU file markdown di working directory-nya:
//     .grove/checkpoint-<8 char id sesi>.md
// Per-sesi (bukan satu file bersama) karena root & semua sub-worker berbagi cwd yang sama — satu
// file bersama pasti saling menimpa.
//
// STRATEGI HIBRIDA (dua lapis, sengaja):
//   1. MODEL yang menulis — file inilah yang paling kaya (keputusan & alasan hanya ada di kepalanya).
//      Diminta lewat system prompt (prompts.ts) + nudge saat konteks mendekati ambang (Session).
//   2. GROVE yang menulis — dipakai HANYA bila lapis 1 tak menghasilkan file yang segar. Isinya
//      sebatas yang Grove memang lihat: papan tugas, jejak tool tulis-file, ekor percakapan.
// Jadi setelah compact SELALU ada file untuk dibaca, dan file model tak pernah ditimpa versi miskin.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatMessage, TodoItem } from '../../shared/types'

/** Umur maksimal checkpoint tulisan model yang masih dianggap mewakili keadaan sekarang. */
const FRESH_MS = 45 * 60_000
const MAX_TAIL_MSG = 10 // ekor percakapan yang ikut ditulis
const MAX_TAIL_CHARS = 400 // per pesan
const MAX_FILES = 25
const MAX_PREV_CHARS = 1200 // potongan checkpoint lama yang diselamatkan

/** Path RELATIF (untuk ditulis ke prompt/ringkasan — enak dibaca & tak membocorkan path absolut). */
export function handoverRel(sessionId: string): string {
  return `.grove/checkpoint-${sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}.md`
}

/** Path ABSOLUT file handover sesi ini. */
export function handoverPath(cwd: string, sessionId: string): string {
  return join(cwd, handoverRel(sessionId))
}

/** mtime file (ms). 0 = tak ada / tak terbaca. */
export function handoverMtime(path: string): number {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : 0
  } catch {
    return 0
  }
}

/**
 * File yang ada sekarang layak dipercaya sebagai handover MODEL?
 * Syarat: ditulis SETELAH compact terakhir (jadi mewakili konteks yang sedang dipotong) DAN belum
 * basi. `since` = waktu compact terakhir sesi ini (0 bila belum pernah).
 */
export function handoverIsFresh(path: string, since: number, now = Date.now()): boolean {
  const m = handoverMtime(path)
  return m > 0 && m > since && m > now - FRESH_MS
}

export interface HandoverInput {
  sessionId: string
  title: string
  role: string
  status: string
  cwd: string
  /** Kenapa file ini ditulis (auto-compact / compact manual / save_compaction). */
  reason: string
  /** Ringkasan yang sama dengan yang di-seed ke konteks baru (board pohon / board sesi). */
  summary: string
  progress?: string
  percent?: number
  todo?: TodoItem[]
  /** File yang sesi ini TULIS/EDIT selama hidupnya (jejak tool, bukan tebakan). */
  files: string[]
  /** File yang sudah DIBACA (jejak tool Read). */
  filesRead?: string[]
  /** Pencarian yang sudah DIJALANKAN (Grep/Glob). */
  searches?: string[]
  /** Ekor percakapan (user/assistant saja) — sudah termasuk yang terbaru di akhir. */
  chatTail: ChatMessage[]
}

const clip = (s: string, n: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

/**
 * Tulis handover versi GROVE (deterministik, tanpa giliran model). Isi file lama — kalau ada —
 * diselamatkan sebagian di bagian akhir: kalaupun itu tulisan model yang sudah basi, "Key Decisions"
 * di dalamnya sering masih berharga, dan menimpanya diam-diam justru membuang informasi.
 * Mengembalikan false bila gagal menulis (folder read-only dll) — pemanggil wajib jujur soal itu.
 */
export function writeHandover(path: string, h: HandoverInput): boolean {
  let prev = ''
  try {
    if (existsSync(path)) prev = readFileSync(path, 'utf8')
  } catch {
    /* file lama tak terbaca → lanjut saja */
  }
  const L: string[] = []
  L.push(`# Handover — ${h.title}`)
  L.push('')
  L.push(
    `_Ditulis OTOMATIS oleh Grove ${new Date().toLocaleString()} karena konteks dipadatkan (${h.reason}). ` +
      `Sumbernya papan tugas + jejak tool + ekor percakapan — bukan ingatan model, jadi anggap ini kerangka, ` +
      `bukan catatan lengkap._`
  )
  L.push('')
  L.push('## Goal')
  L.push(h.summary.trim() || '(tidak ada ringkasan papan — lihat ekor percakapan di bawah)')
  L.push('')
  L.push('## Current State')
  L.push(`- sesi: ${h.title} (${h.role}, status ${h.status}${h.percent != null ? `, ${h.percent}%` : ''})`)
  L.push(`- working directory: ${h.cwd}`)
  if (h.progress) L.push(`- progres terakhir: ${clip(h.progress, 300)}`)
  if (h.todo?.length) {
    L.push('- checklist:')
    for (const t of h.todo.slice(0, 20)) L.push(`  - [${t.done ? 'x' : ' '}] ${clip(t.text, 160)}`)
  }
  L.push('')
  L.push('## Files Changed')
  if (h.files.length) for (const f of h.files.slice(-MAX_FILES)) L.push(`- ${f}`)
  else L.push('- (belum ada file yang ditulis/diedit sesi ini)')
  L.push('')
  // JEJAK PENJELAJAHAN — bagian terpenting untuk sesi ANALISIS (yang cuma membaca, tak menulis).
  // Tanpa ini, sesudah compact model mengulang Grep/Read yang sama persis karena transkripnya hilang.
  L.push('## Already Explored — JANGAN diulang')
  if (h.filesRead?.length) {
    L.push('File yang SUDAH dibaca (rujuk isinya dari ingatan/handover ini; baca ulang hanya kalau benar-benar perlu bagian lain):')
    for (const f of h.filesRead.slice(-MAX_FILES)) L.push(`- ${f}`)
  }
  if (h.searches?.length) {
    L.push('Pencarian yang SUDAH dijalankan (jangan ulangi pola yang sama di folder yang sama):')
    for (const s of h.searches.slice(-MAX_FILES)) L.push(`- ${clip(s, 160)}`)
  }
  if (!h.filesRead?.length && !h.searches?.length) L.push('- (belum ada jejak baca/cari)')
  L.push('')
  L.push('## Conversation Tail')
  const tail = h.chatTail.slice(-MAX_TAIL_MSG)
  if (tail.length) for (const m of tail) L.push(`- **${m.role}**: ${clip(m.text, MAX_TAIL_CHARS)}`)
  else L.push('- (kosong)')
  L.push('')
  L.push('## Next Steps')
  const open = (h.todo ?? []).filter((t) => !t.done)
  if (open.length) for (const t of open.slice(0, 10)) L.push(`- ${clip(t.text, 160)}`)
  else L.push('- Lanjutkan dari "Current State" di atas; pastikan dulu apa yang sudah selesai sebelum mengulang kerja.')
  if (prev.trim()) {
    L.push('')
    L.push('## Catatan checkpoint sebelumnya (mungkin sudah basi)')
    L.push('```')
    L.push(prev.trim().slice(0, MAX_PREV_CHARS))
    L.push('```')
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${L.join('\n')}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
