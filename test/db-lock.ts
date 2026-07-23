// KUNCI SATU-PENULIS grove.sqlite (src/main/dbLock.ts) — lintas binary, tahan crash.
// Jalankan: npx tsx test/db-lock.ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentHolder, holdLock } from '../src/main/dbLock'

let failed = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || !extra ? '' : `\n   ${extra}`}`)
  if (!cond) failed++
}

const dir = mkdtempSync(join(tmpdir(), 'grove-lock-'))

check('awalnya bebas', currentHolder(dir) === null)

const release = holdLock(dir, 'dev')
// Proses SENDIRI tak boleh menghalangi dirinya (mis. cek ulang di runtime yang sama).
check('pemegang = proses ini → tidak dianggap penghalang', currentHolder(dir) === null)

// Proses LAIN yang masih hidup → menghalangi. (pid 4 = System di Windows, selalu hidup.)
writeFileSync(join(dir, 'grove.lock'), JSON.stringify({ pid: 4, at: Date.now(), kind: 'terpaket' }), 'utf8')
const h = currentHolder(dir)
check('instance lain yang hidup → terdeteksi', h?.pid === 4 && h?.kind === 'terpaket', JSON.stringify(h))

// Detak berhenti (proses mati tanpa sempat membersihkan) → kunci dianggap basi, app tetap bisa dibuka.
writeFileSync(join(dir, 'grove.lock'), JSON.stringify({ pid: 4, at: Date.now() - 120_000, kind: 'dev' }), 'utf8')
check('kunci tanpa detak (>60s) → dianggap basi', currentHolder(dir) === null)

// PID yang sudah tak ada → basi juga.
writeFileSync(join(dir, 'grove.lock'), JSON.stringify({ pid: 999999, at: Date.now(), kind: 'dev' }), 'utf8')
check('pid mati → dianggap basi', currentHolder(dir) === null)

// File rusak tak boleh membuat app menolak jalan.
writeFileSync(join(dir, 'grove.lock'), 'bukan json', 'utf8')
check('file kunci rusak → tetap boleh jalan', currentHolder(dir) === null)

release()
check('setelah dilepas → bebas lagi', currentHolder(dir) === null)

console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek lulus')
process.exit(failed ? 1 : 0)
