// Regresi "ganti akun / lanjut tidak jalan": query streaming tetap hidup antar-turn dengan
// iterator terparkir di inbox.next(). Saat query di-restart memakai inbox yang SAMA (ganti akun,
// recycle blokir API, compact, autoResume), resolver parkir milik iterator LAMA tak boleh menelan
// pesan pertama untuk query BARU. Tes ini murni logika antrian — tanpa SDK / panggilan API.
// Jalankan: npx tsx test/inbox-switch.ts
import { AsyncMessageQueue } from '../src/main/orchestrator/Session'

let passed = 0
let failed = 0
function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}`)
  }
}

type Res = { value?: { message?: { content?: unknown } }; done?: boolean; __timeout?: boolean }

/** Ambil satu item dari iterator dengan batas waktu — "menggantung" jadi kegagalan, bukan hang. */
function nextWithin(it: AsyncIterator<unknown>, ms: number): Promise<Res> {
  return Promise.race([
    it.next() as Promise<Res>,
    new Promise<Res>((res) => setTimeout(() => res({ __timeout: true }), ms))
  ])
}
const textOf = (r: Res): unknown => r?.value?.message?.content

async function main(): Promise<void> {
  console.log('\n[inbox-switch] stale-resolver saat restart query pakai inbox yang sama')

  // 1) REPRODUKSI bug: tanpa reset, pesan untuk iterator BARU malah ditelan iterator LAMA.
  {
    const q = new AsyncMessageQueue()
    const oldIt = q[Symbol.asyncIterator]()
    const oldPending = oldIt.next() as Promise<Res> // iterator lama "parkir" (antar-turn)
    const newIt = q[Symbol.asyncIterator]() // query baru pakai inbox yang sama
    q.push('halo akun baru') // TANPA reset → resolvers.shift() ambil resolver lama
    const got = await nextWithin(newIt, 100)
    ok(got.__timeout === true, 'tanpa reset: iterator BARU menggantung (bug ter-reproduksi)')
    const oldGot = await oldPending
    ok(textOf(oldGot) === 'halo akun baru', 'tanpa reset: pesan tertelan iterator LAMA (bocor)')
  }

  // 2) FIX: resetConsumers() sebelum query baru → pesan sampai ke iterator BARU.
  {
    const q = new AsyncMessageQueue()
    void (q[Symbol.asyncIterator]().next() as Promise<Res>) // parkir resolver lama
    q.resetConsumers() // dipanggil di start() tepat sebelum query() baru dibuat
    const newIt = q[Symbol.asyncIterator]()
    const pendingNew = nextWithin(newIt, 300)
    q.push('halo akun baru')
    const got = await pendingNew
    ok(textOf(got) === 'halo akun baru', 'dengan reset: iterator BARU menerima pesan')
  }

  // 3) resetConsumers() TIDAK membuang pesan yang sudah antre di queue.
  {
    const q = new AsyncMessageQueue()
    q.push('sudah antre') // masuk queue (belum ada konsumen)
    q.resetConsumers()
    const got = await nextWithin(q[Symbol.asyncIterator](), 300)
    ok(textOf(got) === 'sudah antre', 'reset: pesan yang sudah antre tetap terkirim')
  }

  console.log(`\n[inbox-switch] passed=${passed} failed=${failed}`)
  process.exit(failed ? 1 : 0)
}
void main()
