# Grove — Desain Fitur "Kartu Sesi MENYALA KUNING + BERKEDIP saat AWAITING-INPUT"

Read-only investigation. Belum ada kode diubah. Semua file:line di bawah adalah TITIK EDIT yang diusulkan.

## Ringkasan keputusan
- **Representasi state:** tambah flag boolean **`awaitingInput`** yang di-layer DI ATAS `status='idle'`
  (BUKAN nilai `SessionStatus` baru). Alasannya: `status` dipakai di banyak tempat (dot, timer turn,
  `active-proc` board, `updateNodeTime`, tombol Stop, `normalizeStaleStatuses`, DB). Menambah enum baru
  = invasif & rawan regresi. Pola flag-boolean sudah ADA persis untuk `apiStopped` — kita tiru itu.
- **Deteksi:** app memakai `permissionMode:'bypassPermissions'` + `allowDangerouslySkipPermissions:true`
  (Session.ts:349-350) dan **TIDAK ADA `canUseTool`/approval di seluruh repo** (grep bersih). Jadi TIDAK ada
  permission-prompt yang menahan giliran. ⇒ satu-satunya sinyal realistis = **heuristik saat turn berakhir
  wajar + teks asisten terakhir berupa pertanyaan/konfirmasi**.
- **Root vs Sub:** deteksi ada di `Session.handle('result')` yang jalan untuk SEMUA sesi (tak peduli role),
  jadi ROOT (nunggu USER) & SUB (nunggu PARENT) sama-sama bisa berkedip. Sesuai permintaan user.
- **Preload & ipc.ts: TIDAK PERLU DIUBAH.** `session:update` adalah passthrough generik; payload sudah tipe
  partial-fleksibel (types.ts:145-154), dan preload cuma meneruskan channel `grove:event`.

---

## Pola acuan (contek `apiStopped`)
- Field privat Session: `private apiStopped = false` (Session.ts:294-306 area).
- Setter yang meng-emit: `setApiStopped()` (Session.ts:626-630) → `emit('session:update',{id,apiStopped})`.
- Tipe payload: `apiStopped?: boolean` (types.ts:152).
- Renderer Node type: `apiStopped?: boolean` (main.ts:19).
- Toggle kelas: `refs.wrap.classList.toggle('api-stopped', !!n.apiStopped)` (main.ts:532).
- CSS: `.node.api-stopped .node-title{...}` (styles.css:146).
`awaitingInput` mengikuti 6 titik yang sama.

---

## 1) MAIN — deteksi & set/clear flag (`src/main/orchestrator/Session.ts`)

### 1a. Field baru — dekat deklarasi field lain (setelah baris ~306, mis. dekat `interrupting`)
```ts
private awaitingInput = false // turn berhenti nunggu jawaban/konfirmasi user/parent → kartu berkedip kuning
```

### 1b. Setter yang meng-emit — letakkan tepat SETELAH `setApiStopped()` (Session.ts:626-630)
```ts
private setAwaitingInput(v: boolean): void {
  if (this.awaitingInput === v) return
  this.awaitingInput = v
  this.emit({ channel: 'session:update', payload: { id: this.meta.id, awaitingInput: v } })
}
```

### 1c. Helper heuristik — letakkan dekat detektor lain (mis. setelah `isApiBlock`, ~Session.ts:197)
```ts
/**
 * Heuristik "turn berhenti menunggu jawaban" — dipakai karena app bypassPermissions (tak ada
 * permission-prompt yang menahan giliran). Sinyal: PENUTUP pesan asisten berupa pertanyaan/konfirmasi.
 * Diikat ke ~2 baris tak-kosong TERAKHIR agar '?' di tengah penjelasan tak salah-picu.
 */
function looksLikeAwaitingInput(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  const tail = t.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(-2).join(' ')
  if (!tail) return false
  if (/\?\s*$/.test(tail)) return true // diakhiri tanda tanya
  return /\b(y\/n|ya\/tidak|iya\/tidak)\b|(konfirmasi|lanjutkan\?|setuju\?|pilih (yang )?mana|mau yang mana|butuh (jawaban|keputusan|konfirmasi)|tolong (konfirmasi|pilih)|apakah (kamu|anda|saya perlu|perlu))|\b(confirm|proceed\?|which (one|option)|should i|do you want|let me know|please (confirm|choose|clarify|advise)|waiting for (your )?(input|confirmation|answer|decision))\b/i.test(tail)
}
```

### 1d. Set flag saat turn berakhir wajar — di handler `'result'`, tepat setelah blok `cleanEnd` (Session.ts:843-848)
`cleanEnd` sudah dihitung di 843-848 (`subtype==='success' && !interrupting && !stopped && !apiBlockPending && !limitHitPending`). Tambahkan SEBELUM `this.host.notifyTurnEnd(...)` (Session.ts:851):
```ts
// Turn berhenti wajar & penutupnya berupa pertanyaan → tandai "menunggu jawaban" (kartu berkedip kuning).
if (cleanEnd && looksLikeAwaitingInput(this.turnText || this.lastAssistantText)) {
  this.setAwaitingInput(true)
}
```
Catatan: `setStatus('idle')` (836) sudah emit status; ini emit event kedua `awaitingInput:true`. Renderer
me-merge keduanya (Object.assign) → status idle + berkedip.

### 1e. CLEAR flag saat giliran baru dimulai — di `beginTurn()` (Session.ts:414-419)
`beginTurn()` adalah CHOKE-POINT tunggal yang dipanggil di SETIAP jalur dorong kerja baru: `sendUserMessage`
(user/parent menjawab), `injectAutoTask` (auto-report/ganti akun/limit), `autoCheck`, `autoResume`, recycle.
Tambah 1 baris di akhir:
```ts
this.setAwaitingInput(false) // kerja baru masuk (user/parent menindak) → matikan kedip
```
Ini otomatis mematikan kedip saat user membalas ROOT, atau saat root men-`assign_worker` SUB (assign →
`sendUserMessage` → `beginTurn`).

### 1f. (Defensif) CLEAR saat interupsi/stop
- `interruptTurn()` (Session.ts:691-702): tambah `this.setAwaitingInput(false)` sebelum/So sesudah interrupt.
- `stop()` (Session.ts:503-513): tambah `this.setAwaitingInput(false)`.
(Opsional tapi rapi; mencegah kedip nyangkut kalau user menekan Stop pada sesi yang tadinya awaiting.)

---

## 2) SHARED TYPES (`src/shared/types.ts`)

### 2a. Payload `session:update` — tambah field (types.ts:148-153, sebaris dgn `apiStopped`)
```ts
          apiStopped?: boolean
          awaitingInput?: boolean // turn berhenti menunggu jawaban user/parent → kartu berkedip kuning
```

### 2b. (OPSIONAL) Snapshot awal — hanya jika ingin kedip bertahan lintas reload renderer (HMR)
`awaitingInput` adalah state RUNTIME (tidak dipersist ke DB → reset saat app restart, itu benar). Kalau mau
tampil juga di `getSnapshot()` (mis. renderer reload sementara main hidup): tambah `awaitingInput?: boolean`
ke `TreeNode` (types.ts:84-89), expose getter di Session, isi di `SessionManager.getSnapshot()` (SessionManager.ts:812-839).
Tidak wajib untuk MVP.

---

## 3) RENDERER (`src/renderer/main.ts`)

### 3a. Tipe `Node` — tambah field (main.ts:19)
```ts
type Node = SessionMeta & { ctxPercent: number; tokensTotal: number; loopActive?: boolean; apiStopped?: boolean; ctxPending?: boolean; awaitingInput?: boolean }
```

### 3b. Toggle kelas — di `updateNodeVisual()` (main.ts:532, sebaris dgn api-stopped)
```ts
refs.wrap.classList.toggle('awaiting-input', !!n.awaitingInput) // menunggu jawaban → kedip kuning
```
`session:update` handler (main.ts:962-977) sudah `Object.assign(cur, ev.payload)` (969) lalu memanggil
`updateNodeVisual` (971) untuk SETIAP payload — jadi event `{id,awaitingInput:true/false}` langsung berefek.
**Tidak perlu perubahan lain di renderer.**

---

## 4) CSS (`src/renderer/styles.css`) — blink kuning, letakkan dekat `.node.api-stopped` (styles.css:145-150)
```css
/* sesi berhenti menunggu jawaban/konfirmasi user/parent → kartu berkedip kuning agar user sadar menindak */
@keyframes awaitBlink {
  0%, 100% { background: rgba(217, 164, 65, 0.10); }
  50%      { background: rgba(217, 164, 65, 0.34); }
}
.node.awaiting-input {
  animation: awaitBlink 1.15s ease-in-out infinite;
  border-color: var(--warn);
}
.node.awaiting-input .node-title { color: #f4d68a; }
.node.awaiting-input .dot { background: var(--warn); box-shadow: 0 0 6px var(--warn); } /* dot kuning walau status idle */
.node.awaiting-input.active { border-color: var(--warn); } /* tetap kelihatan saat sesi dipilih */
@media (prefers-reduced-motion: reduce) {
  .node.awaiting-input { animation: none; background: rgba(217, 164, 65, 0.24); } /* aksesibilitas: tak berkedip */
}
```
Warna kuning = `--warn: #d9a441` (styles.css:11) — konsisten dgn dot `.s-waiting` (styles.css:169).

---

## 5) (OPSIONAL) Legend di `src/renderer/index.html` (index.html:19-24)
Tambah keterangan agar user paham arti kedip kuning:
```html
        <span class="dot s-waiting"></span>awaiting
```
(atau elemen kecil dgn kelas khusus). Kosmetik, tidak memengaruhi logika.

---

## Ringkasan file yang diubah
| File | Perubahan | Wajib? |
|---|---|---|
| `src/main/orchestrator/Session.ts` | field `awaitingInput`, `setAwaitingInput()`, helper `looksLikeAwaitingInput()`, set di `handle('result')`, clear di `beginTurn()` (+interrupt/stop) | WAJIB |
| `src/shared/types.ts` | `awaitingInput?` di payload `session:update` (+opsional TreeNode) | WAJIB |
| `src/renderer/main.ts` | `awaitingInput?` di type `Node`; 1 baris toggle kelas di `updateNodeVisual` | WAJIB |
| `src/renderer/styles.css` | `@keyframes awaitBlink` + `.node.awaiting-input{…}` | WAJIB |
| `src/renderer/index.html` | legend "awaiting" | opsional |
| `src/preload/index.ts`, `src/main/ipc.ts` | — | TIDAK diubah (passthrough generik) |
| `src/main/orchestrator/SessionManager.ts` | — (hanya bila mau opsi snapshot 2b) | opsional |

## Risiko & keputusan
1. **False positive/negative heuristik.** Tanpa permission-API, deteksi bergantung pola teks penutup.
   Mitigasi: hanya cek ~2 baris terakhir + allowlist frasa; hanya pada `cleanEnd`. Tetap bisa salah
   (pertanyaan retoris → kedip; pertanyaan tanpa '?'/frasa dikenal → tak kedip). Bisa diperketat kemudian.
2. **Interaksi auto-check loop (root).** Bila root sedang "awaiting user" lalu loop 10-menit meng-inject
   `[GROVE AUTO-CHECK]` (SessionManager.ts:501-531) → `beginTurn` → kedip mati. Dampak kecil: kalau root
   bertanya lagi, kedip nyala lagi. Bisa dikecualikan nanti (skip loop saat `awaitingInput`).
3. **Sub selalu auto-report ke parent tiap turn.** `autoReportFinal` menyuntik hasil ke PARENT, bukan ke sub
   sendiri → tidak menghapus kedip sub. Kedip sub baru mati saat parent benar-benar men-`assign_worker`
   (yang memicu `beginTurn` sub). Ini perilaku yang diinginkan (kedip s/d ditindak).
4. **Tidak dipersist.** `awaitingInput` runtime-only → reset saat app restart. Disengaja (kedip basi lintas
   restart tak bermakna). Opsi 2b bila perlu bertahan lintas reload renderer.
5. **Non-invasif.** Flag layered di atas `status='idle'` → tak menyentuh logika timer/board/DB/enum status.
