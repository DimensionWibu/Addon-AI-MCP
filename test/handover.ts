// Uji jaring pengaman handover (src/main/orchestrator/handover.ts) — tanpa Electron/SDK.
// Jalankan: npx tsx test/handover.ts
//
// Yang dibuktikan:
//  1. Tiap sesi punya nama file SENDIRI (root & sub berbagi cwd → nama bersama pasti bentrok).
//  2. writeHandover menghasilkan file berisi bagian-bagian yang dibutuhkan sesi lanjutan.
//  3. Isi checkpoint LAMA tidak hilang diam-diam — diselamatkan sebagai kutipan.
//  4. handoverIsFresh: file tulisan model dihormati hanya bila ditulis SETELAH compact terakhir
//     dan belum basi (inilah yang menentukan Grove menimpa atau tidak).
import { mkdtempSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { handoverIsFresh, handoverPath, handoverRel, writeHandover } from '../src/main/orchestrator/handover'

let failed = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || !extra ? '' : `\n   ${extra}`}`)
  if (!cond) failed++
}

const cwd = mkdtempSync(join(tmpdir(), 'grove-handover-'))
const ROOT = 'root-1234-abcd'
const SUB = 'sub-9876-zyxw'

// 1. nama file unik per sesi
check('path per-sesi berbeda', handoverRel(ROOT) !== handoverRel(SUB), `${handoverRel(ROOT)} vs ${handoverRel(SUB)}`)
check('path di bawah .grove/', handoverRel(ROOT).startsWith('.grove/'), handoverRel(ROOT))

// 2. isi file
const p = handoverPath(cwd, ROOT)
const ok = writeHandover(p, {
  sessionId: ROOT,
  title: 'Perbaiki panel usage',
  role: 'root',
  status: 'running',
  cwd,
  reason: 'compact',
  summary: 'Tujuan: kuota akun API dibaca dari API provider sendiri.',
  progress: 'menulis fetcher OpenRouter',
  percent: 40,
  todo: [
    { text: 'fetch /v1/key', done: true },
    { text: 'render panel kredit', done: false }
  ],
  files: ['src/main/usage.ts', 'src/renderer/main.ts'],
  chatTail: [
    { role: 'user', text: 'kuota openrouter kok kosong?', ts: 1 },
    { role: 'assistant', text: 'karena semua akun ditembak ke endpoint Anthropic.', ts: 2 }
  ]
})
check('writeHandover berhasil', ok)
const body = readFileSync(p, 'utf8')
for (const h of ['## Goal', '## Current State', '## Files Changed', '## Conversation Tail', '## Next Steps']) {
  check(`ada bagian ${h}`, body.includes(h))
}
check('file yang disentuh ikut tercatat', body.includes('src/main/usage.ts'))
check('todo yang BELUM selesai jadi Next Steps', body.split('## Next Steps')[1].includes('render panel kredit'))
check('todo yang sudah selesai tak jadi Next Steps', !body.split('## Next Steps')[1].includes('fetch /v1/key'))
check('ekor percakapan ikut', body.includes('kuota openrouter kok kosong?'))

// 3. checkpoint lama diselamatkan
writeFileSync(p, '## Key Decisions\n- pakai /v1/credits untuk saldo akun\n', 'utf8')
writeHandover(p, {
  sessionId: ROOT,
  title: 'Perbaiki panel usage',
  role: 'root',
  status: 'idle',
  cwd,
  reason: 'compact',
  summary: 'ringkasan baru',
  files: [],
  chatTail: []
})
const body2 = readFileSync(p, 'utf8')
check('isi checkpoint lama diselamatkan', body2.includes('pakai /v1/credits untuk saldo akun'))

// 4. kesegaran
const fresh = join(cwd, '.grove', 'fresh.md')
mkdirSync(dirname(fresh), { recursive: true })
writeFileSync(fresh, 'x', 'utf8')
const now = Date.now()
check('file baru ditulis = segar', handoverIsFresh(fresh, now - 60_000, now))
check('file ditulis SEBELUM compact terakhir = basi', !handoverIsFresh(fresh, now + 1_000, now))
const old = (now - 60 * 60_000) / 1000 // 1 jam lalu (> ambang 45 menit)
utimesSync(fresh, old, old)
check('file berumur 1 jam = basi', !handoverIsFresh(fresh, 0, now))
check('file tak ada = basi', !handoverIsFresh(join(cwd, '.grove', 'nope.md'), 0, now))

console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek lulus')
process.exit(failed ? 1 : 0)
