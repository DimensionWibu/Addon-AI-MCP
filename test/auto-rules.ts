// Uji modul aturan otomatis (panel Setting) — murni, tanpa SDK/electron:
//   npx tsx test/auto-rules.ts
// Yang dijaga di sini: aturan buatan user tak boleh bisa MENJATUHKAN sesi (regex rusak, JSON rusak,
// daftar raksasa), dan urutan daftar benar-benar menentukan prioritas.
import { DEFAULT_AUTO_RULES, matchAutoRule, parseRules, sanitizeRules } from '../src/main/orchestrator/autoRules'
import type { AutoRule } from '../src/shared/types'

let pass = 0
let fail = 0
const ok = (cond: boolean, what: string): void => {
  if (cond) {
    pass++
    console.log(`  ✓ ${what}`)
  } else {
    fail++
    console.error(`  ✗ ${what}`)
  }
}

const rule = (p: Partial<AutoRule>): AutoRule => ({
  id: p.id ?? 'r',
  label: p.label ?? 'r',
  pattern: p.pattern ?? 'x',
  regex: p.regex,
  action: p.action ?? 'retry',
  enabled: p.enabled !== false
})

console.log('\n1. sanitizeRules — bersihkan masukan tak dipercaya')
{
  const cleaned = sanitizeRules([
    { pattern: '  penuh  ', action: 'model', label: ' Penuh ' },
    { pattern: '', action: 'retry' }, // tanpa kata kunci → dibuang
    { pattern: 'abc', action: 'ngaco' }, // aksi tak dikenal → jatuh ke retry
    { id: 'dup', pattern: 'a' },
    { id: 'dup', pattern: 'b' }, // id kembar → dibedakan
    'bukan objek',
    null
  ])
  ok(cleaned.length === 4, `baris rusak dibuang (sisa ${cleaned.length}, harusnya 4)`)
  ok(cleaned[0].pattern === 'penuh' && cleaned[0].label === 'Penuh', 'spasi tepi dirapikan')
  ok(cleaned[0].action === 'model', 'aksi valid dipertahankan')
  ok(cleaned[1].action === 'retry', 'aksi tak dikenal → retry')
  ok(cleaned[2].id !== cleaned[3].id, 'id kembar dibedakan')
  ok(cleaned[1].label === 'abc', 'label kosong → pakai kata kuncinya')
  ok(sanitizeRules('bukan array').length === 0, 'bukan array → daftar kosong')
  ok(sanitizeRules(Array.from({ length: 500 }, () => ({ pattern: 'a' }))).length === 100, 'jumlah aturan dibatasi 100')
}

console.log('\n2. matchAutoRule — pencocokan')
{
  const rules = [rule({ id: 'a', pattern: 'ResourceExhausted', action: 'retry' })]
  ok(matchAutoRule('Error: nvidia ResourceExhausted, coba lagi', rules)?.id === 'a', 'cocok sebagai bagian teks')
  ok(matchAutoRule('resourceexhausted', rules)?.id === 'a', 'tak peduli besar-kecil huruf')
  ok(matchAutoRule('semuanya lancar', rules) === null, 'teks lain tidak cocok')
  ok(matchAutoRule('', rules) === null, 'teks kosong tidak cocok')
}

console.log('\n3. literal vs regex')
{
  const literal = [rule({ pattern: 'error (429)' })] // tanda kurung HARUS diperlakukan apa adanya
  ok(matchAutoRule('http error (429) dari upstream', literal) !== null, 'karakter regex di mode literal aman')
  ok(matchAutoRule('error 429', literal) === null, 'literal tidak diperlakukan sebagai pola')

  const re = [rule({ pattern: '5\\d\\d (bad gateway|unavailable)', regex: true })]
  ok(matchAutoRule('upstream 503 unavailable', re) !== null, 'regex cocok')
  ok(matchAutoRule('upstream 200 ok', re) === null, 'regex tidak salah-cocok')

  const rusak = [rule({ pattern: '([unclosed', regex: true }), rule({ id: 'b', pattern: 'penuh' })]
  ok(matchAutoRule('server penuh', rusak)?.id === 'b', 'regex rusak dilewati, tidak melempar')
}

console.log('\n4. aktif/nonaktif & prioritas')
{
  const rules = [
    rule({ id: 'mati', pattern: 'penuh', action: 'account', enabled: false }),
    rule({ id: 'hidup', pattern: 'penuh', action: 'retry' })
  ]
  ok(matchAutoRule('server penuh', rules)?.id === 'hidup', 'aturan nonaktif dilewati')

  const urut = [rule({ id: 'atas', pattern: 'penuh' }), rule({ id: 'bawah', pattern: 'penuh' })]
  ok(matchAutoRule('penuh', urut)?.id === 'atas', 'yang di atas menang (urutan = prioritas)')
}

console.log('\n5. parseRules — JSON dari DB/file')
{
  ok(parseRules('[{"pattern":"abc","action":"resend"}]')[0].action === 'resend', 'JSON valid terbaca')
  ok(parseRules('{bukan json').length === 0, 'JSON rusak → daftar kosong (tidak melempar)')
  ok(parseRules('null').length === 0, 'null → daftar kosong')
}

console.log('\n6. contoh bawaan')
{
  ok(sanitizeRules(DEFAULT_AUTO_RULES).length === DEFAULT_AUTO_RULES.length, 'contoh bawaan lolos sanitize')
  ok(
    matchAutoRule('Provider error: ResourceExhausted', DEFAULT_AUTO_RULES)?.action === 'retry',
    'contoh bawaan menangkap ResourceExhausted → retry'
  )
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} lulus, ${fail} gagal\n`)
process.exit(fail === 0 ? 0 : 1)
