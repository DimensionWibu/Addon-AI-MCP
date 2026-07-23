// KUNCI SATU-PENULIS untuk grove.sqlite — lintas BINARY, bukan cuma lintas proses.
//
// KENAPA PERLU: `app.requestSingleInstanceLock()` milik Electron hanya mengikat instance dari
// executable yang SAMA. Terbukti (diuji 2026-07-23): app terpaket (Grove.exe) dan app dev
// (electron.exe) bisa berjalan BERSAMAAN dan keduanya membuka grove.sqlite yang sama. Karena DB
// memakai sql.js — seluruh isi ditahan di memori lalu ditulis ulang utuh saat flush — penulis kedua
// akan menimpa pekerjaan penulis pertama. Ini bukan teori: entri akun yang ditulis dari luar sempat
// hilang persis begitu.
//
// Kuncinya sengaja SEDERHANA & tahan crash: satu file berisi pid + waktu, di-refresh berkala.
// Pemegang yang mati (pid tak ada / detak terlalu tua) dianggap tak memegang apa-apa.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'grove.lock'
const BEAT_MS = 15_000 // detak; harus jauh di bawah STALE_MS
const STALE_MS = 60_000 // tak berdetak selama ini → dianggap mati (mis. proses di-kill paksa)

export interface LockInfo {
  pid: number
  at: number
  kind: string // 'dev' | 'packaged' — hanya untuk pesan ke user
}

function lockPath(userData: string): string {
  return join(userData, FILE)
}

function readLock(userData: string): LockInfo | null {
  try {
    const p = lockPath(userData)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8')) as LockInfo
    return typeof j?.pid === 'number' ? j : null
  } catch {
    return null
  }
}

/**
 * Proses itu masih hidup? (signal 0 = cek saja, tak mengirim apa pun)
 * EPERM berarti prosesnya ADA tapi kita tak berhak mengirim sinyal (mis. milik user/level lain) —
 * itu tetap "hidup". Tanpa membedakannya, kunci milik proses yang sah dikira basi lalu ditabrak.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Pemegang kunci yang MASIH HIDUP, atau null bila bebas. Proses sendiri tak dihitung.
 * Kunci dianggap basi bila pid-nya sudah tak ada ATAU detaknya berhenti — jadi crash tak
 * meninggalkan aplikasi yang tak bisa dibuka lagi.
 */
export function currentHolder(userData: string): LockInfo | null {
  const l = readLock(userData)
  if (!l || l.pid === process.pid) return null
  if (!alive(l.pid)) return null
  if (Date.now() - l.at > STALE_MS) return null
  return l
}

/** Ambil kunci untuk proses ini + jaga detaknya. Kembalikan fungsi pelepas. */
export function holdLock(userData: string, kind: string): () => void {
  const write = (): void => {
    try {
      writeFileSync(lockPath(userData), JSON.stringify({ pid: process.pid, at: Date.now(), kind }), 'utf8')
    } catch {
      /* kunci hanyalah penjaga; kegagalan menulis tak boleh menggagalkan app */
    }
  }
  write()
  const timer = setInterval(write, BEAT_MS)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    try {
      const l = readLock(userData)
      if (l?.pid === process.pid) unlinkSync(lockPath(userData))
    } catch {
      /* abaikan */
    }
  }
}
