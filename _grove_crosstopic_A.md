# Grove — Root cause: "sub-worker kebawa topik sibling"

Investigasi jalur pembentukan **context session worker**. File yang diaudit:
`SessionManager.ts`, `Session.ts`, `db.ts`, `shared/types.ts`, `mcpTools.ts`, dan internal SDK
`@anthropic-ai/claude-agent-sdk@0.3.214` (`sdk.mjs`).

## TL;DR

Bug BUKAN kolisi/resume sessionId di layer SDK, BUKAN query DB yang bocor, BUKAN state modul
bersama. **Root cause = reuse worker TANPA reset konteks di `assign_worker`.** Worker yang sudah
mengerjakan sub-tugas A, saat diberi tugas baru B lewat `assign_worker`, tugas B hanya di-`push`
ke `inbox` dari `query()` streaming yang SAMA — seluruh transkrip sub-tugas A masih utuh di
konteks SDK worker itu, sehingga worker "nyambung/campur" topik A ke B. Diperparah prompt root
yang MEMERINTAHKAN reuse ("keeps its full prior context"). Semua direct-worker satu root adalah
sibling, jadi dari sisi user terlihat sebagai "sub kebawa topik sibling".

---

## Q1 — spawn_worker: pembuatan sessionId worker baru & risiko resume ke sibling

Jalur: `SessionManager.spawnWorker` → `newMeta` → `registerSession` → `Session.start` → SDK `query`.

- `SessionManager.ts:87` id internal Grove = `randomUUID()` (fresh, unik).
- `SessionManager.ts:88-96` meta dibuat via `newMeta` (`SessionManager.ts:338-363`) yang **TIDAK**
  mengeset `sdkSessionId` → `undefined`. (`spawnWorker` hanya menyalin `accountId` dari parent,
  `SessionManager.ts:97` — bukan `sdkSessionId`.)
- `Session.start` (`Session.ts:332-354`) memanggil SDK dengan `resume: this.meta.sdkSessionId`
  (`Session.ts:352`). Untuk worker baru = `resume: undefined`.
- Bukti perilaku SDK (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, region build-args
  ~offset 895625):
  - `if(w)H.push("--continue")` — `w = options.continueConversation`. Grove **tak pernah** set →
    `--continue` tak dipakai. (Ini penting: `--continue` = resume sesi TERBARU di cwd; kalau ini
    aktif dengan cwd yang di-share, ITULAH yang akan menyebabkan bleed sibling. Sekarang aman.)
  - `if(A)H.push('--resume='+A)` — `A = options.resume`. Untuk worker baru `undefined` → falsy →
    `--resume` tak dipakai.
  - `if(options.sessionId)H.push('--session-id='+...)` — Grove tak pernah set → CLI generate UUID
    acak sendiri.
  - Jalur `sessionStore`/`resumeConfigDir` (auto-inject `resume:n`) hanya aktif bila
    `options.sessionStore` di-pass; Grove tak pernah pass → **mati**.

**Kesimpulan Q1:** worker yang benar-benar baru MENDAPAT session_id acak baru dari CLI (di-capture
balik lewat event init → `Session.ts:708-712` `this.meta.sdkSessionId = sid`). Tidak ada
default/kolisi/reuse yang membuatnya ter-resume ke transkrip sibling. **Hipotesis "sessionId salah/
kolisi" TIDAK terbukti.**

## Q2 — assign_worker (reuse worker idle): apakah append ke transkrip lama? design atau bug?

**YA — dan inilah mekanismenya.**

- `mcpTools.ts:71-82` tool `assign_worker` → `host.assignToWorker(sessionId, worker_id, task)`.
- `SessionManager.assignToWorker` (`SessionManager.ts:108-117`) → satu-satunya aksi:
  `worker.sendUserMessage(task)` (`SessionManager.ts:116`). Tak ada reset konteks.
- `Session.sendUserMessage` (`Session.ts:427-449`) mem-`push` teks ke `this.inbox`
  (`Session.ts:445/447`). `inbox` = `AsyncMessageQueue` berumur-panjang (`Session.ts:283`) yang
  menyuapi SATU `query()` streaming yang tetap hidup antar-turn (`Session.ts:523-526` loop
  `for await` tak berhenti selama inbox belum close). Jadi tugas B masuk ke **percakapan SDK yang
  sama** dengan sub-tugas A → seluruh konteks A tetap ada.
- Ini memang **DESAIN**, dinyatakan eksplisit:
  - `mcpTools.ts:73` "the worker resumes with its full prior context".
  - `Session.ts:61` (GROVE_ROOT) "REUSE workers before creating new ones ... it keeps its full
    prior context and is cheaper".
  - `Session.ts:74` (GROVE_SUB) "You may be handed a NEW task later on this same session — your
    prior context is kept, so build on it."

**Kesimpulan Q2:** desainnya benar untuk tugas yang MELANJUTKAN, tapi menjadi bug untuk tugas
BARU yang TIDAK berhubungan — tak ada jalur untuk memberi tugas baru dengan konteks bersih, dan
root justru diarahkan memilih reuse. Worker membawa topik sub-tugas sebelumnya (yang adalah
sibling-level task) → gejala "kebawa topik sibling". **INI ROOT CAUSE.**

Sharp-edge tambahan: `assignToWorker` tak cek status worker; kalau worker masih `running`, tugas B
tetap di-push → dua tugas ter-antri/interleave di satu percakapan.

## Q3 — pemanggilan SDK per giliran; penyimpanan/muat history; query bocor antar-session?

- **Satu `query()` streaming berumur-panjang per Session**, disuapi `inbox`; tidak mengirim ulang
  history tiap turn. `resume` HANYA dipakai untuk menyambung kembali setelah query mati (error/
  compact/ganti-akun/restart) dan SELALU ke `sdkSessionId` MILIK SENDIRI (`Session.ts:352`,
  di-set hanya dari init event milik sendiri `Session.ts:711`, atau di-`undefined`-kan saat
  compact `Session.ts:380` / blokir-API `Session.ts:679`). Tak pernah di-set ke id sibling.
- Penyimpanan history 2 lapis:
  1. Board/chat Grove di SQLite (`db.ts`) — SEMUA query ketat `WHERE ...=?` per `session_id`
     (PRIMARY KEY); tak ada JOIN longgar / query lintas-session (lihat `getChatMessages`
     `db.ts:277`, `getBoardEntry` `db.ts:305`, `upsertSession` `ON CONFLICT(id)` `db.ts:158`).
  2. Percakapan LLM nyata di transkrip CLI `~/.claude/projects/<cwd>/<session_id>.jsonl`, satu
     file per session_id.
- **Tak ada query yang mengembalikan baris session lain.** Tak ada bleed di DB.
- CAVEAT lingkungan: semua worker satu pohon share `cwd` yang sama (`SessionManager.ts:94`
  `cwd: parent.meta.cwd`) → transkrip mereka satu folder proyek. Tak menyebabkan bleed sendiri
  (session_id beda = file beda), TAPI rapuh: jika suatu saat `continueConversation`/`--continue`
  diaktifkan, itu akan resume sesi TERBARU di cwd = bleed sibling literal. Jaga tetap OFF.

## Q4 — state modul-level / variabel di-share antar Session?

**Tidak ada.** Tiap Session punya milik-sendiri: `inbox` (`Session.ts:283`), `history`
(`Session.ts:284`), `q` (`Session.ts:285`), `toolRows` (`Session.ts:289`), `meta`. Server MCP
dibuat per-session: `buildGroveServer(this.meta.id, this.host)` (`Session.ts:330`) dengan
`sessionId` di-capture di closure (`mcpTools.ts:56`) dan diteruskan ke tiap handler → tak ada
singleton "current session id". `SessionManager.sessions` Map di-key `meta.id` unik
(`SessionManager.ts:124`). Aliran data lintas-session HANYA yang disengaja dan selalu menuju
PARENT/ROOT (bukan sibling), masing-masing menulis ke inbox milik TARGET:
- `autoReportFinal` → `parent.injectAutoTask` (`SessionManager.ts:691`)
- `reportToParent` → `sendMessage` + `scheduleRootStatus` → `root.injectAutoTask`
  (`SessionManager.ts:617-620`, `740`)
Tidak ada jalur yang menyuntik konteks worker A ke worker B (sibling). 

---

## Usulan fix (ringkas)

**Primer — isolasi konteks saat reuse (menghapus gejala):**
1. Saat `assign_worker` memberi tugas BARU tak-berhubungan, RESET percakapan SDK worker sebelum
   push tugas. Tambah metode `Session.resetForNewTask(seed?)` yang meniru `compactWith` tanpa
   seed berat: `this.meta.sdkSessionId = undefined; this.resetCtx(); this.started=false;
   interrupt q lama` lalu `sendUserMessage(task)` → sesi FRESH berisi hanya tugas B (opsional
   seed 1 baris "tugas sebelumnya '<judul>' selesai" agar sadar, tanpa polusi).
   - Ubah `assignToWorker` (`SessionManager.ts:108-117`) menerima flag `fresh` (default true),
     atau selalu reset untuk tugas baru.
2. Ubah prompt root (`Session.ts:61`, GROVE_ROOT) agar reuse hanya dianjurkan bila tugas baru
   adalah LANJUTAN tugas worker itu; untuk tugas tak-berhubungan → `spawn_worker` atau assign
   dengan konteks fresh. Sekarang instruksinya tanpa syarat → mendorong kontaminasi.

**Sekunder — hardening:**
3. `assignToWorker` tolak/interrupt-dulu bila worker masih `running` (cegah interleave 2 tugas).
4. Beri guard/komentar agar `continueConversation` TAK PERNAH diaktifkan selama worker share cwd
   (defensif terhadap bleed sibling literal).

**Catatan:** karena spawn benar-benar fresh TIDAK bocor (terbukti di Q1), bila user melihat worker
yang BENAR-BENAR baru mengerjakan topik salah, itu karena root menulis teks tugas yang tercampur
(perilaku model/prompt), bukan salah-wiring session. Defect wiring yang konkret = jalur reuse di
atas.
