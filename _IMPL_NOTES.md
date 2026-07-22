# Grove — Implementasi FIX 1 (Memory) + FIX 2 (Handoff)

Tanggal: 2026-07-19. Verifikasi: `tsc --noEmit -p tsconfig.json` → EXITCODE=0 (tanpa error, tanpa emit, app tidak disentuh).
Aktivasi: perubahan main-process baru aktif setelah USER me-restart Grove (npm run dist → jalankan exe, atau dev). BUKAN tugas agent.

## File yang diubah
1. `src/main/orchestrator/Session.ts`
2. `src/main/orchestrator/SessionManager.ts`
3. (data, non-kode) menyalin folder memori ke `%APPDATA%\grove\memory\`

---

## FIX 1a — matikan auto-inject MEMORY.md  (Session.ts, `start()`)
- systemPrompt preset diberi `excludeDynamicSections: true`.
- Efek: blok dynamic (auto-memory MEMORY.md + working-directory + git-status) TIDAK di-inject ke system prompt.
- CLAUDE.md global (settingSources) TIDAK diubah → tetap kepakai.
- Tipe SDK terverifikasi: `sdk.d.ts:1994 excludeDynamicSections?: boolean` (valid pada preset systemPrompt).

## FIX 1b — memory portable (non-destruktif)
- SALIN (bukan pindah) isi `...grove-scratch\memory\` → `%APPDATA%\grove\memory\`.
- Terverifikasi: 13/13 file tersalin, termasuk MEMORY.md. Sumber TIDAK dihapus.

## FIX 2a — akumulasi teks satu turn penuh  (Session.ts)
- Field baru `private turnText = ''` (sebelah `lastAssistantText`).
- Di titik assign blok teks assistant: `turnText` diakumulasi (`turnText ? turnText + '\n' + block.text : block.text`); `lastAssistantText` dibiarkan tetap ada (fallback).
- Reset di 3 titik: `beginTurn()`, akhir case 'result' (setelah dipakai), dan `consume()` finally.

## FIX 2b — perbaiki BUG skip di case 'result'  (Session.ts)
- Dulu: `cleanEnd && !this.finalReportSent ? {finalText: lastAssistantText} : undefined` → worker yang sempat report_to_parent(100) TIDAK menyerahkan hasil.
- Sekarang: `cleanEnd ? { finalText: this.turnText || this.lastAssistantText } : undefined` (kirim TIAP cleanEnd). `finalReportSent`/`markFinalReported` tetap ada untuk dedup board.

## FIX 2c — auto-attach hasil ke KONTEKS parent  (SessionManager.ts `autoReportFinal`)
- Import ditambah: `app` (electron), `join` (node:path), `mkdirSync`/`writeFileSync` (node:fs).
- Skip berbasis finalReportSent DIHAPUS (logika skip ada di Session.ts 2b; autoReportFinal kini selalu jalan saat cleanEnd).
- Simpan hasil LENGKAP ke file: `join(userData, 'results')` (mkdir recursive), nama `${sanitize(title)}-${id}.md`, isi = header (judul, id, ISO timestamp) + hasil penuh.
- `sanitizeFileName`: karakter non `[A-Za-z0-9_-]` → `-`, dipangkas 80 char, trim `-`, fallback `worker` (aman di Windows).
- Tetap tulis ke tabel messages (jejak UI) — sama seperti sebelumnya.
- KUNCI baru: `parent.injectAutoTask(note)` — note ringkas (cuplikan ±700 char + path file) di-INJECT ke konteks parent. injectAutoTask meng-queue bila parent BUSY (pola sama autoCheck/rootStatus).

## Self-review (poin verifikasi)
- (a) Tidak ada infinite loop: `notifyTurnEnd` early-return utk role !== 'sub'; pohon parentId acyclic → inject hanya naik & berhenti di root (root tak trigger autoReportFinal).
- (b) Tidak crash saat parentId null: `autoReportFinal` return awal bila `!parentId`; `notifyTurnEnd` hanya panggil utk role==='sub' (sub selalu punya parentId). Tulis file dibungkus try/catch.
- (c) turnText di-reset benar di beginTurn + result + finally.
- (d) Path file aman di Windows (sanitize + join userData).
