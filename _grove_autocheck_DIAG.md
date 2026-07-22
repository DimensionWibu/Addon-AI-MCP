# Grove — Diagnosa biaya AUTO-CHECK berkala (`runLoopCheck`) — READ-ONLY, tanpa edit kode

Tanggal: 2026-07-20. Pertanyaan user: apakah auto-check 10-menit masih boros karena memuat ulang
konteks global + konteks sub-session tiap tick?

## VERDICT SINGKAT

**Masih boros — TAPI bukan karena alasan yang dikira.**
- ❌ Bukan karena payload besar: isi ping cuma **~183-451 token** (diukur, lihat §1).
- ❌ Bukan karena cache selalu meleset: CLI meminta **`ttl: "1h"`** (bukti biner, §3) sedangkan
  interval **10 menit** → cache justru **HIT**. Skenario "TTL 5m vs interval 10m → selalu bayar
  cache-WRITE" yang dikhawatirkan **TIDAK terjadi**.
- ✅ Boros karena **tiap tick = SATU giliran root penuh** → seluruh transkrip root yang menumpuk
  dibaca ulang. Isi ping hanya **~0,1-6%** dari biaya turn; sisanya re-read konteks (§2).
- ✅ **Pemborosan MURNI yang terbukti:** tick yang boardnya **TIDAK berubah TETAP menembak**.
  Dari 3 ping pada tree yang diam, **2 di antaranya berpayload BYTE-IDENTIK** (§4).
- ⚠️ **Auto-stop 3-strike bisa TIDAK PERNAH tercapai** karena signature-nya volatil (§4c).

---

## §1 — Isi yang disuntik tiap tick (payload)

`runLoopCheck` → `root.autoCheck(this.loopCheckPrompt(rootId))` (**SessionManager.ts:667**).

- `autoCheck` (**Session.ts:599-603**) menulis nota UI `🔁 Auto-check berkala…` (43 B, **hanya ke
  chat/DB UI — TIDAK masuk konteks SDK**) lalu `injectAutoTask(prompt)`.
- `loopCheckPrompt` (**SessionManager.ts:952-954**) = teks tetap + `treeBoardSummary(treeId)`.
- `treeBoardSummary` (**SessionManager.ts:933-946**): **1 baris per sesi**, tiap baris di-`slice(0,220)`,
  total di-cap **2000 char**. Format: `- [role] title (status, percent%) — progress|summary`.

**Ukuran terukur (Buffer.byteLength, ≈ byte/3.6 token):**

| Bagian | Byte | ~token |
|---|---|---|
| Scaffold `loopCheckPrompt` (tanpa board) | 339 | ~94 |
| + board tree 3 sesi | ~659 | **~183** |
| + board tree 6 sesi | ~980 | **~272** |
| + board tree 12 sesi (maks worker/tree) | ~1.622 | **~451** |
| Cap absolut (board 2000 char) | ~2.339 | **~650** |

**Jawaban: TIDAK ada bagian yang membawa konteks sub-session lebih dari 1 baris ringkas.**
Sub hanya diwakili 1 baris ≤220 char. Transkrip/summary panjang sub TIDAK ikut. Payload ping = kecil.

## §2 — Biaya per tick: yang mahal adalah GILIRAN-nya

Rantai terkonfirmasi: `autoCheck` → `injectAutoTask` (**Session.ts:585-596**) → `beginTurn()` +
`this.inbox.push(text)` → SDK query **long-lived + `resume`** memakannya sebagai **pesan user baru**
= **giliran baru**. Seluruh transkrip root yang sudah menumpuk ikut jadi input turn itu.

Perkiraan untuk root ctx 35% (ping tree 12 sesi = 451 token):

| Window root | ctx 35% | Cache **HIT** (0,1×) | Porsi isi ping |
|---|---|---|---|
| 200k | 70.000 tok | ~**7.000** tok efektif/tick | 451/7.000 ≈ **6%** |
| 1M (`[1m]`) | 350.000 tok | ~**35.000** tok efektif/tick | 451/35.000 ≈ **0,13%** |

→ **Rasio isi-ping : biaya-giliran ≈ 1 : 16 (200k) sampai 1 : 776 (1M).**
Artinya: memperkecil teks ping hampir tak ada gunanya; yang menentukan adalah **jumlah tick**.

Bila loop tak pernah berhenti: 6 tick/jam × 24 = **144 tick/hari per root**
→ ~1,0 juta (200k) s/d ~5,0 juta (1M) token input efektif per hari **per root**. DB saat ini punya 4 tree.

## §3 — Interaksi PROMPT CACHE (bagian terpenting)

**a) Apakah Grove menyetel TTL?** **TIDAK.** Grep `ttl|cache_control|cacheControl|ephemeral` di seluruh
`src/` hanya menemukan hal tak berkaitan: `CTX_PERSIST_MS` (Session.ts:176), `lastCtxPersist`
(Session.ts:354), dan pembacaan `usage.cache_creation_input_tokens` (Session.ts:1108). **Nol** penyetelan
cache. Opsi `query()` di `Session.start()` juga tak memuat opsi cache apa pun.

**b) Lalu TTL efektifnya berapa?** Ditentukan oleh CLI `claude.exe` yang di-spawn SDK. Bukti dari biner
`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` (256 MB):

```
 91  cache_control
 19  ephemeral_1h_input_tokens        3  ttl: "1h
 18  ephemeral_5m_input_tokens        3  ttl": "1h
  9  "1h"                             3  "5m"
```

→ CLI **memakai `cache_control` dan meminta `ttl: "1h"` secara eksplisit** (literal `ttl: "1h`/`ttl": "1h`
ada di biner; **tidak ada** literal `ttl…"5m"` yang setara). Diperkuat keterangan runtime Claude Code
sendiri: *"This session's requests use a 1-hour Anthropic prompt-cache TTL."*

**c) KONFIRMASI skenario yang dikhawatirkan: TIDAK terjadi.**
TTL **60 menit** > interval **10 menit** (`LOOP_INTERVAL_MS = 10 * 60_000`, **SessionManager.ts:31**)
→ saat tick berikutnya datang, prefix root **masih hangat** → **cache-READ (~0,1×)**, bukan
cache-WRITE (~1,25×). Jadi tiap tick **TIDAK** membayar 1,25× konteks penuh.

**d) Apa yang menjaga cache root tetap hangat?** HANYA giliran root itu sendiri.
- Timer usage 5-menit = HTTPS fetch ke `oauth/usage` (**bukan** panggilan model) → **tidak** menghangatkan cache.
- Turn worker = sesi/prefix BERBEDA → **tidak** menghangatkan cache root.
→ Ironisnya, **auto-check itu sendiri yang menjaga cache-nya sendiri tetap hangat.**

**e) Konsekuensi penting untuk usulan fix:** menjarangkan interval **melewati 60 menit** akan membuat
SETIAP tick jadi cache-MISS. Hitungan kasar (root 200k @35%):
- tiap 10 mnt (HIT): 6 × 7.000 = **42.000** tok/jam
- tiap 60+ mnt (MISS): 1 × 87.500 (1,25×) = **87.500** tok/jam → **lebih mahal**
→ **Ada tebing biaya di 60 menit.** "Jauh lebih jarang" ≠ otomatis lebih murah.

## §4 — Apakah tick di-skip saat tak ada perubahan?

Kode: **SessionManager.ts:640-670**.

**(c) Root sedang `running` → YA, di-skip.** Guard `root.meta.status !== 'running'` (**:650**). Tick itu
dilewati dan hanya dijadwalkan ulang (**:669**). Tidak boros. (Catatan: `lastLoopSummary` juga tidak
diperbarui saat skip, jadi state streak konsisten.)
Juga di-skip bila `subs.length === 0` atau **semua** sub `running` (**:648-650**).

**(a) Semua worker idle & tak ada perubahan → TETAP MENEMBAK (pemborosan murni).**
Ini temuan utama. `unchanged` **hanya dipakai untuk menghitung streak, TIDAK untuk mencegah ping**:
```ts
const unchanged = this.lastLoopSummary.get(rootId) === summary   // :656
const streak = unchanged ? (this.loopIdleStreak.get(rootId) ?? 0) + 1 : 0   // :657
if (streak >= IDLE_CHECK_LIMIT) { …stopLoop; return }            // :660-666
root.autoCheck(this.loopCheckPrompt(rootId))                     // :667  ← TETAP JALAN walau unchanged
```
Runut pada tree yang benar-benar diam (`IDLE_CHECK_LIMIT = 3`, **:32**):

| Tick | `unchanged` | streak | Aksi |
|---|---|---|---|
| 1 | false (`lastLoopSummary` kosong) | 0 | **FIRE** |
| 2 | true | 1 | **FIRE — payload BYTE-IDENTIK dgn tick 1** |
| 3 | true | 2 | **FIRE — payload BYTE-IDENTIK lagi** |
| 4 | true | 3 | stopLoop (tak fire) |

→ **3 giliran root; 2 di antaranya 100% redundan.** Loop baru berhenti **40 menit** setelah tree diam.
Biaya sia-sia 2 tick: ~14.000 tok (200k) / ~70.000 tok (1M) **per periode diam per root**.

**(b) Tree sudah selesai tapi `task_done` belum dipanggil → TETAP MENEMBAK.**
`anyStalled = subs.some(s => s.meta.status !== 'running')` (**:649**) — status **`done` ≠ `running`**,
jadi sub yang SUDAH SELESAI tetap dihitung "stalled" → syarat terpenuhi → ping tetap dikirim.
Tree yang seluruh workernya `done` masih menerima hingga 3 ping (≈40 mnt) sebelum berhenti sendiri.

**(c) ⚠️ Auto-stop 3-strike RAPUH — bisa tak pernah tercapai.**
Signature = `treeBoardSummary(rootId)` yang **menyertakan baris ROOT sendiri** (loop `metaSnapshot()`
hanya memfilter `m.treeId !== treeId`; root ber-`treeId === rootId` → ikut) dan memuat field volatil
`title`, `status`, `percent`, `progress|summary`. Maka:
- root membalas ping lalu memanggil `update_summary`/`set_title` → baris root berubah → `unchanged=false`
  → **streak reset ke 0** → hitungan 3-strike mulai lagi dari nol;
- ping menyuruh root "dorong worker idle → `assign_worker`" (**:953**); begitu root menurut, status/progress
  sub berubah → streak reset.
→ Dalam pola pemakaian normal, loop bisa **berjalan tanpa batas**, sehingga angka 144 tick/hari di §2
bukan sekadar teoretis.

**Yang tidak rusak:** `task_done` → `stopLoop` (**:682**) dan toggle manual `setLoop` (**:673-675**)
tetap menghentikan loop dengan benar.

---

## §5 — USULAN FIX BERPERINGKAT (belum diimplementasikan)

Tujuan asli auto-check yang WAJIB dijaga: **root tetap tahu ada worker yang mandek**.

### #1 (TERTINGGI, risiko rendah) — jangan kirim ping saat `unchanged`
Pindahkan `root.autoCheck(...)` ke dalam `if (!unchanged)`; `unchanged` tetap menaikkan streak.
- **Dampak:** menghapus 2 dari 3 giliran per periode diam (**−67% biaya auto-check saat idle**), tanpa
  mengurangi informasi apa pun (root sudah menerima state identik itu di tick 1).
- **Risiko:** bila root GAGAL menindak ping pertama (mis. turn-nya keburu diinterupsi), tak ada
  pengulangan. **Mitigasi:** izinkan tepat SATU pengulangan — kirim saat `streak === 0` **atau**
  `streak === 1`, diam pada streak berikutnya. Tetap memangkas ≥1 giliran/periode.
- **Catatan penting:** worker yang MANDEK justru TIDAK mengubah board, jadi persis di kasus ini ping
  jadi identik. Karena itu jangan menghapus ping pertama — ia yang membawa sinyal mandek.

### #2 (TINGGI, risiko rendah-sedang) — stabilkan signature agar 3-strike benar-benar tercapai
Hitung `unchanged` HANYA dari baris **sub** (kecualikan baris root) dan hanya field yang bermakna
(`status` + `percent` + `progress`), abaikan `title`.
- **Dampak:** auto-stop jadi deterministik; menutup jalur "loop tak pernah berhenti" (§4c) yang merupakan
  sumber biaya tak terbatas.
- **Risiko:** signature terlalu kasar bisa menutupi progres nyata → **jangan** buang `percent`/`progress`.

### #3 (SEDANG) — berhenti saat semua sub `done`
Bedakan `done` (tuntas) vs `idle` (mandek). Bila semua sub `done` & tak ada yang `running`: kirim
SATU ping penutup (ajak sintesis + `task_done`) lalu `stopLoop`.
- **Dampak:** menghapus ekor ping pasca-selesai (kasus §4b).
- **Risiko:** salah klasifikasi. Sub `idle` yang tugasnya BELUM selesai **tidak boleh** dianggap done —
  itu justru kasus mandek yang harus tetap dikejar. Bergantung pada `markDone()`/percent 100 yang akurat.

### #4 (SEDANG, hati-hati) — naikkan interval TAPI TETAP DI BAWAH 60 MENIT
Mis. `LOOP_INTERVAL_MS` 10 → 20-30 menit: jumlah tick turun 2-3×, dan prefix root **masih** dalam TTL 1 jam
→ tetap cache-READ.
- **Dampak:** −50% s/d −67% tick.
- **Risiko:** deteksi worker mandek melambat (maks 30 mnt). **JANGAN lewat 60 menit** — di atas TTL setiap
  tick jadi cache-MISS dan total biaya justru NAIK (§3e).

### #5 (RENDAH) — gabungkan auto-check ke buffer coalesce laporan worker
Bila auto-check jatuh berdekatan dengan flush laporan worker, gabungkan jadi satu giliran.
- **Dampak:** kecil (menghapus tabrakan sesekali). **Risiko:** menambah kompleksitas interaksi dua timer.

**Rekomendasi gabungan:** #1 + #2 lebih dulu (murah, risiko kecil, langsung memotong jalur boros
tak-terbatas), lalu #3; #4 hanya sebagai penyetelan, dengan pagar keras **< 60 menit**.

---

## Catatan metode
- Semua angka byte diukur langsung dari string sumber (`Buffer.byteLength`), token ≈ byte/3,6.
- Bukti TTL dari pemindaian string biner CLI + keterangan runtime Claude Code. Caveat jujur: pemindaian
  string tak bisa membuktikan cabang kode mana yang aktif saat runtime; namun tak ditemukan literal
  `ttl…"5m"` yang setara, dan `"1h"` muncul 3× lebih sering.
- TIDAK ada kode yang diubah pada investigasi ini.
