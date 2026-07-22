# Grove — Implementasi Optimasi Perf (LOW-RISK) — Changelog

Tanggal: 2026-07-20. Basis: `_grove_perf_DESIGN.md`. **Tanpa restart/dev/dist** (sesi live).
Cakupan: 4 item LOW-RISK. **B1-a (migrasi better-sqlite3) DITUNDA** — butuh keputusan user
(packaging native module untuk ABI Electron); tidak disentuh di sini.

## Verifikasi
- `npx tsc --noEmit -p tsconfig.json` → **exit 0** ✅
- `npm run build` (electron-vite build) → **exit 0** ✅ (main 103.49 kB, preload 2.10 kB, renderer 38.56 kB)

---

## B2 — Coalesce `chat:delta` (buffer + flush ~40ms, bukan per token)
**File:** `src/main/orchestrator/Session.ts`

- `:175` konstanta `DELTA_FLUSH_MS = 40`.
- `:351-353` field baru `deltaBuf`, `deltaTimer`, (+`lastCtxPersist` utk B3).
- `:585-609` metode `queueDelta()` (tampung + set timer) & `flushDelta()` (emit satu event tergabung + batalkan timer).
- `:886` jalur stream_event `text_delta` sekarang panggil `this.queueDelta(...)` — **bukan** `emit(chat:delta)` per token.
- `:895` `flushDelta()` di awal `case 'assistant'` — **invariant kunci:** buffer dikosongkan SEBELUM blok difinalkan (`chat:message`), jadi tak ada stray delta menyusul finalisasi (cegah gelembung dobel) & urutan teks terjaga.
- `:954` `flushDelta()` di awal `case 'result'` (turn berakhir → sisa token keluar).
- `:426, :461, :619, :696, :827` `flushDelta()` di semua jalur terminasi query (`compactWith`, `resetForNewTask`, `stop`, `applyAccountChange`, `interruptTurn`) — deterministik, tak ada timer nyangkut/emit setelah state reset.

**Efek:** jumlah IPC/serialisasi per-token turun drastis (batch ~40ms) untuk SEMUA sesi →
main-thread lebih lega saat banyak sesi paralel; streaming sesi aktif lebih mulus.
**Keutuhan teks:** aman — finalisasi renderer (`chat:message` → `renderMarkdown(full)`) tetap
merender teks penuh apa pun kondisi buffer; tak ada token hilang.

### Keputusan: suppress delta sesi NON-FOKUS → **TIDAK dipakai** (sengaja)
Menekan emit untuk sesi non-aktif butuh main melacak `activeId` (plumbing ke ipc/SessionManager)
dan berisiko **salah tampil** saat user pindah fokus di tengah stream (teks parsial belum
tersimpan ke DB → bisa kosong sampai blok berikutnya). Demi LOW-RISK, cukup **coalesce** —
sudah memangkas beban IPC termasuk untuk sesi background (yang toh dibuang di `main.ts:981`).
Suppress non-fokus ditunda sebagai opsi terpisah.

---

## B3 — Throttle persist ctx/usage ke DB (in-memory + UI tetap instan)
**File:** `src/main/orchestrator/Session.ts`

- `:176` konstanta `CTX_PERSIST_MS = 2000`.
- `:353` field `lastCtxPersist`.
- `:508` `beginTurn()` reset `lastCtxPersist = 0` → usage PERTAMA tiap turn dipersist segera (angka fresh).
- `:1044-1055` `applyUsage()`: update meta in-memory + `emit(session:update)` **tetap instan** (badge ctx% real-time), tapi `this.db.upsertSession(...)` hanya dipanggil bila `now - lastCtxPersist >= CTX_PERSIST_MS`.

**Nilai final tidak hilang:** saat turn selesai, `case 'result'` memanggil `setStatus('idle')`
(status `running→idle` berubah) yang meng-`upsertSession(meta)` dengan ctx terkini → ctx final
selalu tersimpan. Angka ctx bersifat ephemeral (dihitung ulang tiap turn dari `usage`), jadi
menjarangkan tulisan DB aman.

**Efek:** memangkas sumber mutasi DB terbesar kedua (dulu tiap pesan assistant = 2 INSERT +
schedule-save). Sinergis dengan B1-c.

---

## B1-c — Export DB dirty-only + debounce lebih longgar
**File:** `src/main/orchestrator/db.ts`

- `:80` konstanta `SAVE_DEBOUNCE_MS = 1500` (dari 250ms) — export sql.js (O(ukuran DB), di main-thread) jadi jauh lebih jarang.
- `:85` field `dirty = false`.
- `:132` `run()` set `this.dirty = true` di tiap mutasi (semua tulisan lewat sini).
- `:147` `writeAtomic()` **skip `db.export()` bila `!dirty`**, dan set `dirty = false` setelah tulis sukses.
- `:163` `scheduleSave()` pakai `SAVE_DEBOUNCE_MS`.

**Keamanan data:** `flush()` (yang menghormati `dirty`) sudah dipanggil di `index.ts:203`
(`app.on('before-quit')`) → simpan final saat keluar. Idle read-only (getSnapshot/getChat) kini
**tak** memicu tulis disk sama sekali. Saat streaming aktif, cadence export turun ~6× (250ms→1500ms)
+ dilewati bila tak ada perubahan → micro-freeze berkala berkurang tanpa ganti engine.

---

## B4 — Typewriter append-only (hilangkan O(n²))
**File:** `src/renderer/main.ts`

- `:42` var `pendingTextNode: Text | null` — node teks streaming yang stabil.
- `:288-305` `flushPending()`: dari `pendingEl.textContent = pendingText.slice(0, n)` (menyalin ulang string yang tumbuh tiap frame → **O(n²)**) menjadi `pendingTextNode.appendData(pendingText.slice(shownLen, next))` (**O(char baru)** saja). Efek bertahap tetap dipertahankan.
- `:992-993` `chat:delta` handler: buat `document.createTextNode('')` + `appendChild` saat gelembung streaming dibuat.
- Reset `pendingTextNode = null` di semua titik `pendingEl` di-null-kan: finalisasi `chat:message` `:1009`, `selectSession` `:603`, `applyRemoved` `:618`, `freshChat` `:1215`. `flushPending` guard `!pendingTextNode`.

**Efek:** pesan panjang tidak lagi menyalin ulang seluruh string tiap frame → CPU renderer turun,
teks terasa lebih instan. Kosmetik, di renderer.

---

## Catatan risiko / status
- Semua 4 item **LOW-RISK**, lulus tsc + build. Tak ada perubahan skema DB, tak ada API baru ke renderer.
- **B1-a (better-sqlite3) DITUNDA** — akar micro-freeze sistemik (export seluruh DB O(size))
  baru tuntas dengan engine inkremental/native; perlu keputusan user soal packaging native
  module. B1-c hanya meredakan gejalanya (aman, tanpa ganti engine).
- Tidak menyentuh: `contextWindows.ts` (bukan bottleneck), penambahan worker_threads (tak dijustifikasi untuk item ini).
- Latency inference model tetap di server Anthropic — tak tersentuh (memang tak bisa dari klien).
