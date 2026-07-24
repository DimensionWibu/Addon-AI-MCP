// Handler IPC: renderer → main.
import { app, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionManager } from './orchestrator/SessionManager'
import type { AutoRule, FetchModelsResult, ImageAttachment, ImportResult } from '../shared/types'
import { isEffort } from '../shared/types'
import { fetchOpenRouterModels } from './openrouter'
import { fetchDeepseekBalance } from './deepseek'

/**
 * Tulis objek ke file JSON yang DIPILIH USER lewat dialog. null = dialog dibatalkan.
 * Sengaja lewat dialog (bukan path dari renderer): renderer tak pernah boleh menentukan file mana
 * yang ditulis main-process.
 */
async function saveJsonDialog(defaultName: string, data: unknown): Promise<string | null> {
  const r = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (r.canceled || !r.filePath) return null
  await writeFile(r.filePath, JSON.stringify(data, null, 2), 'utf8')
  return r.filePath
}

/** Baca file JSON pilihan user. null = dibatalkan. JSON rusak → error naik ke renderer apa adanya. */
async function openJsonDialog(): Promise<{ path: string; data: unknown } | null> {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  const path = r.filePaths[0]
  if (r.canceled || !path) return null
  const data = JSON.parse(await readFile(path, 'utf8'))
  if (!data || typeof data !== 'object') throw new Error('Isi file itu bukan objek JSON.')
  return { path, data }
}

/** Tolak file yang jelas-jelas bukan miliknya (file config dipilih di tombol import akun, dst). */
function assertKind(data: unknown, expected: string): void {
  const kind = (data as { kind?: unknown }).kind
  if (typeof kind === 'string' && kind !== expected) {
    throw new Error(`File ini bertanda "${kind}", bukan "${expected}".`)
  }
}

/** Batas tunggu GET <base>/models. Tanpa ini fetch bisa MENGGANTUNG selamanya (host yang men-drop
 *  paket tak pernah menolak koneksi), dan tombol "Ambil daftar model" tertinggal di keadaan memuat. */
const MODELS_TIMEOUT_MS = 12_000

/** Sisa jatah waktu TOTAL (bukan per-percobaan) — mencoba dua kandidat URL tak boleh membuat user
 *  menunggu dua kali lipat. Selalu disisakan 1 detik supaya percobaan terakhir tetap sempat jalan. */
function remainingMs(deadline: number): number {
  return Math.max(1_000, deadline - Date.now())
}

/**
 * Kandidat URL daftar model dari base URL yang DIKETIK USER — bentuknya sering tak rapi: ada/tak ada
 * garis miring penutup, garis miring dobel, lupa skema (`api.contoh.com`), atau malah menempel
 * `/chat/completions`. Semua dirapikan dulu supaya tak lahir URL rusak.
 * Base yang belum berakhiran `/v1` dicoba DUA KALI (`<base>/models` lalu `<base>/v1/models`) karena
 * banyak gateway hanya menyajikan yang versi /v1 — user sering menempel host-nya saja.
 */
function modelsUrlCandidates(baseUrl: string): string[] {
  let base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return []
  // Lupa skema → tebak: host lokal hampir pasti http polos, sisanya https.
  if (!/^https?:\/\//i.test(base)) {
    base = `${/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base) ? 'http' : 'https'}://${base}`
  }
  base = base
    .replace(/([^:])\/{2,}/g, '$1/') // garis miring dobel di dalam path (skema `://` tak tersentuh)
    .replace(/\/chat\/completions$/i, '') // user kadang menempel endpoint penuh
    .replace(/\/+$/, '')
  const out = [`${base}/models`]
  if (!/\/v\d+$/i.test(base)) out.push(`${base}/v1/models`)
  return out
}

/**
 * Ambil id model dari balasan yang bentuknya bisa macam-macam: `{data:[…]}` (OpenAI), `{models:[…]}`,
 * atau array polos. Bentuk tak terduga → daftar kosong, BUKAN lemparan.
 */
function pickModelIds(j: unknown): string[] {
  const box = j as { data?: unknown; models?: unknown } | null
  const arr = Array.isArray(j) ? j : Array.isArray(box?.data) ? box.data : Array.isArray(box?.models) ? box.models : []
  const ids = (arr as unknown[]).map((m) => {
    if (typeof m === 'string') return m.trim()
    const o = m as { id?: unknown; name?: unknown } | null
    return String(o?.id ?? o?.name ?? '').trim()
  })
  return [...new Set(ids.filter(Boolean))]
}

/**
 * Ringkas badan error HTTP jadi satu baris pendek yang layak ditampilkan ke user, dan REDAKSI token
 * bila gateway memantulkannya kembali — pesan ini berakhir di alert renderer, token tak boleh ikut.
 */
function briefError(body: string, token: string): string {
  let msg = body.trim()
  try {
    const j = JSON.parse(msg) as { error?: { message?: string } | string; message?: string }
    const e = typeof j.error === 'string' ? j.error : j.error?.message
    msg = String(e ?? j.message ?? msg)
  } catch {
    /* bukan JSON → pakai teks apa adanya */
  }
  if (token && msg.includes(token)) msg = msg.split(token).join('…')
  return msg.replace(/\s+/g, ' ').slice(0, 200)
}

export function registerIpc(manager: SessionManager): void {
  ipcMain.handle('grove:dropFolder', (_e, { path, title }: { path: string; title?: string }) => {
    if (!path || !existsSync(path)) throw new Error(`Folder tidak ditemukan: ${path}`)
    const dir = statSync(path).isDirectory() ? path : dirname(path)
    return manager.createRoot(dir, title)
  })

  // Chat tanpa folder ("tanya-tanya") → jalan di folder scratch khusus (bukan proyek).
  // Tiap chat baru dapat sub-folder scratch UNIK. Claude Code menurunkan identitas project — dan
  // karenanya direktori memori ~/.claude/projects/<slug-dari-cwd>/memory — dari cwd. Dulu SEMUA
  // chat memakai satu folder scratch yang sama, jadi satu MEMORY.md dipakai bersama dan memori
  // project lain bocor ke sesi yang tak berkaitan. Satu folder unik per root = satu identitas
  // project = memori terisolasi. Sub-worker mewarisi cwd parent (SessionManager.spawnWorker),
  // jadi satu POHON tetap berbagi satu identitas — itu memang yang diinginkan.
  // Sesi LAMA tidak disentuh: cwd-nya sudah tersimpan di DB dan tetap dipakai apa adanya.
  ipcMain.handle('grove:newChat', (_e, { title }: { title?: string }) => {
    const scratch = join(app.getPath('userData'), 'scratch', randomUUID())
    mkdirSync(scratch, { recursive: true }) // recursive → induk ikut dibuat, dan aman bila sudah ada
    // "+Chat" = tanya-tanya solo → mode LITE (CLI-parity, hemat token). Butuh orkestrasi? toggle di
    // header, atau drag-drop folder (yang default orkestrator penuh).
    return manager.createRoot(scratch, title || 'Chat baru', true)
  })

  // Worker baru buatan USER (klik 3× kartu sesi): sub-sesi idle di bawah kartu itu, TANPA tugas &
  // tanpa giliran model — user yang mengisi tugasnya setelah kartunya muncul.
  ipcMain.handle('grove:newWorker', (_e, { parentId, title }: { parentId: string; title?: string }) =>
    manager.newWorker(parentId, title)
  )

  // Pilih folder proyek lewat dialog (alternatif drag-drop).
  ipcMain.handle('grove:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return manager.createRoot(r.filePaths[0])
  })

  // Kunci sesi yang SUDAH ADA ke sebuah folder project (drag-drop folder ke kartu sesi).
  // Validasi path (ada + benar-benar direktori) ditegakkan di SessionManager.setSessionCwd
  // supaya berlaku untuk SEMUA pemanggil, bukan hanya jalur IPC ini.
  ipcMain.handle('grove:setSessionCwd', (_e, { id, path }: { id: string; path: string }) => {
    return manager.setSessionCwd(id, path)
  })

  ipcMain.handle(
    'grove:sendChat',
    (_e, { id, text, images }: { id: string; text: string; images?: ImageAttachment[] }) => {
      manager.sendChat(id, text, images)
    }
  )

  // /btw — pertanyaan sampingan: query terpisah, tak mengantre di sesi utama (boleh saat sesi sibuk).
  ipcMain.handle('grove:askSide', (_e, { id, question }: { id: string; question: string }) =>
    manager.askSide(id, question)
  )

  // Saldo DeepSeek (dari platform) + perkiraan biaya lokal per jendela waktu. Saldo di-cache 60s di
  // deepseek.ts; kegagalan per-akun dilaporkan sebagai `error` — JANGAN tampilkan angka palsu.
  ipcMain.handle('grove:getDeepseekCosts', async () => {
    const rows = manager.deepseekCosts()
    return Promise.all(
      rows.map(async (r) => {
        const token = manager.getAccountToken(r.accountId)
        if (!token) return { ...r, balance: null, error: 'akun tanpa token' }
        try {
          return { ...r, balance: await fetchDeepseekBalance(token) }
        } catch (e) {
          return { ...r, balance: null, error: String(e) }
        }
      })
    )
  })

  // Antrian pesan user (ditahan Grove selama turn berjalan → masih bisa diedit/dibatalkan).
  ipcMain.handle('grove:listQueued', (_e, { id }: { id: string }) => manager.listQueued(id))
  ipcMain.handle('grove:editQueued', (_e, { id, qid, text }: { id: string; qid: number; text: string }) =>
    manager.editQueued(id, qid, text)
  )
  ipcMain.handle('grove:cancelQueued', (_e, { id, qid }: { id: string; qid: number }) =>
    manager.cancelQueued(id, qid)
  )

  // Referensi antar-sesi (satu arah: helper boleh membantu target; target tak tahu & tak punya balik).
  ipcMain.handle('grove:linkReference', (_e, { helperId, targetId }: { helperId: string; targetId: string }) =>
    manager.linkReference(helperId, targetId)
  )
  ipcMain.handle('grove:unlinkReference', (_e, { helperId, targetId }: { helperId: string; targetId: string }) =>
    manager.unlinkReference(helperId, targetId)
  )
  ipcMain.handle('grove:listReferences', (_e, { helperId }: { helperId: string }) => manager.listReferences(helperId))

  ipcMain.handle('grove:stopSession', (_e, { id }: { id: string }) => manager.stopSession(id))

  ipcMain.handle('grove:stopAll', () => manager.stopAll())
  // Dorong semua sesi menganggur untuk meneruskan pekerjaannya (tombol ▶ Lanjutkan semua).
  ipcMain.handle('grove:resumeAll', () => manager.resumeAll())

  ipcMain.handle('grove:reorder', (_e, { ids }: { ids: string[] }) => manager.reorderSessions(ids))

  ipcMain.handle('grove:compact', (_e, { id }: { id: string }) => manager.compactSession(id))

  ipcMain.handle('grove:setLoop', (_e, { id, enabled }: { id: string; enabled: boolean }) =>
    manager.setLoop(id, enabled)
  )

  ipcMain.handle('grove:listAccounts', () => manager.listAccounts())
  ipcMain.handle(
    'grove:addAccount',
    (
      _e,
      {
        label,
        token,
        plan,
        switchPct,
        provider,
        model,
        baseUrl
      }: {
        label: string
        token: string
        plan?: number
        switchPct?: number
        provider?: 'claude' | 'openrouter' | 'custom' | 'cursor' | 'deepseek' | 'dzax'
        model?: string
        baseUrl?: string
      }
    ) => manager.addAccount(label, token, plan, switchPct, provider, model, baseUrl)
  )
  // Ubah akun yang sudah ada (label/token/model/base URL). Token kosong = tidak diganti.
  ipcMain.handle(
    'grove:updateAccount',
    (_e, { id, patch }: { id: string; patch: { label?: string; token?: string; model?: string; baseUrl?: string; plan?: number | null } }) =>
      manager.updateAccount(id, patch)
  )
  ipcMain.handle('grove:deleteAccount', (_e, { id }: { id: string }) => manager.deleteAccount(id))
  ipcMain.handle('grove:setAccountSwitchPct', (_e, { id, pct }: { id: string; pct: number | null }) =>
    manager.setAccountSwitchPct(id, pct)
  )
  ipcMain.handle('grove:setDefaultSwitchPct', (_e, { pct }: { pct: number }) => manager.setDefaultSwitchPct(pct))
  ipcMain.handle('grove:setDefaultAccount', (_e, { accountId }: { accountId: string | null }) =>
    manager.setDefaultAccount(accountId)
  )
  ipcMain.handle('grove:applyAccountToAll', (_e, { accountId }: { accountId: string | null }) =>
    manager.applyAccountToAllSessions(accountId)
  )
  ipcMain.handle('grove:setAccountOrder', (_e, { ids }: { ids: string[] }) => manager.setAccountOrder(ids))
  ipcMain.handle('grove:setVisionAccount', (_e, { accountId }: { accountId: string | null }) =>
    manager.setVisionAccount(accountId)
  )
  ipcMain.handle('grove:setDefaultModel', (_e, { model }: { model: string | null }) =>
    manager.setDefaultModel(model)
  )
  ipcMain.handle('grove:setSessionModel', (_e, { id, model }: { id: string; model: string | null }) =>
    manager.setSessionModel(id, model)
  )
  ipcMain.handle('grove:setLite', (_e, { id, lite }: { id: string; lite: boolean }) => manager.setLite(id, lite))
  // Tingkat mikir (reasoning): per-sesi & global. Nilai tak sah → null (kembali mewarisi/default).
  ipcMain.handle('grove:setSessionEffort', (_e, { id, effort }: { id: string; effort: string | null }) =>
    manager.setSessionEffort(id, isEffort(effort) ? effort : null)
  )
  ipcMain.handle('grove:setDefaultEffort', (_e, { effort }: { effort: string | null }) =>
    manager.setDefaultEffort(isEffort(effort) ? effort : null)
  )
  // Daftar model milik akun GATEWAY: diambil live dari <base>/models, lalu DIGABUNG dengan daftar
  // yang user tulis sendiri di akun. Penggabungan itu penting — gateway bisa melaporkan daftar yang
  // tak lengkap (Shiteru hanya mengembalikan 1 model padahal 4 lainnya sah dipakai key yang sama).
  ipcMain.handle('grove:listGatewayModels', async (_e, { accountId }: { accountId: string }) => {
    const acc = manager.listAccounts().accounts.find((a) => a.id === accountId)
    const token = manager.getAccountToken(accountId)
    if (!acc || !token) return []
    const own = (acc.model ?? '').split(',').map((m) => m.trim()).filter(Boolean)
    let live: string[] = []
    const deadline = Date.now() + MODELS_TIMEOUT_MS
    for (const url of modelsUrlCandidates(acc.baseUrl || '')) {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(remainingMs(deadline))
        })
        if (!res.ok) continue // mis. base kurang /v1 → coba kandidat berikutnya
        live = pickModelIds(await res.json().catch(() => null))
        if (live.length) break
      } catch {
        /* jaringan mati / waktu habis → cukup pakai daftar milik akun */
      }
    }
    return [...new Set([...own, ...live])]
  })

  // Fetch daftar model dari endpoint OpenAI-compatible apa pun, dengan token yang diberikan langsung.
  // Dipakai form tambah akun SEBELUM akun disimpan (belum ada accountId).
  // Balikannya SELALU {models, error?}: kegagalan harus punya alasan yang bisa dibaca user (token
  // ditolak vs endpoint salah vs jaringan mati) — daftar kosong polos membuat user menebak-nebak.
  // Token HANYA dipakai sebagai header Authorization: tak pernah ikut balikan maupun dicatat ke log.
  ipcMain.handle(
    'grove:fetchModelsFromUrl',
    async (_e, { token, baseUrl }: { token: string; baseUrl: string }): Promise<FetchModelsResult> => {
      const key = String(token ?? '').trim()
      const urls = modelsUrlCandidates(baseUrl)
      if (!key) return { models: [], error: 'Token/API key masih kosong.' }
      if (!urls.length) return { models: [], error: 'Base URL masih kosong.' }
      let last = ''
      const deadline = Date.now() + MODELS_TIMEOUT_MS
      for (const url of urls) {
        try {
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(remainingMs(deadline))
          })
          if (!res.ok) {
            const detail = briefError(await res.text().catch(() => ''), key)
            last = `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`
            if (res.status === 404 || res.status === 405) continue // alamat salah → coba kandidat /v1
            break // 401/403/5xx: mengulang di URL lain takkan menolong
          }
          const ids = pickModelIds(await res.json().catch(() => null))
          if (!ids.length) {
            last = 'Endpoint membalas, tapi tanpa daftar model yang bisa dibaca.'
            continue
          }
          return { models: ids }
        } catch (e) {
          const err = e as { name?: string; message?: string }
          last =
            err?.name === 'TimeoutError' || err?.name === 'AbortError'
              ? `Tak ada balasan dalam ${MODELS_TIMEOUT_MS / 1000} detik.`
              : briefError(String(err?.message ?? e), key)
        }
      }
      return { models: [], error: last || 'Gagal mengambil daftar model.' }
    }
  )

  // Daftar model OpenRouter (live). Gagal jaringan → balikan [] supaya renderer fallback ke saran statis.
  ipcMain.handle('grove:listOpenRouterModels', async (_e, { freeOnly }: { freeOnly?: boolean }) => {
    try {
      return await fetchOpenRouterModels(freeOnly ?? true)
    } catch {
      return []
    }
  })
  ipcMain.handle('grove:setSessionAccount', (_e, { id, accountId }: { id: string; accountId: string | null }) =>
    manager.setSessionAccount(id, accountId)
  )
  ipcMain.handle('grove:setAutoSwitch', (_e, { on }: { on: boolean }) => manager.setAutoSwitch(on))

  // ---- panel Setting: aturan otomatis + export/import -----------------------
  ipcMain.handle('grove:getAutoRules', () => manager.getAutoRules())
  ipcMain.handle('grove:setAutoRules', (_e, { rules }: { rules: AutoRule[] }) => manager.setAutoRules(rules))
  ipcMain.handle('grove:exportConfig', () => saveJsonDialog('grove-config.json', manager.exportConfigData()))
  ipcMain.handle('grove:importConfig', async (): Promise<ImportResult | null> => {
    const f = await openJsonDialog()
    if (!f) return null
    assertKind(f.data, 'grove-config')
    return { file: f.path, ...manager.importConfigData(f.data) }
  })
  // Token IKUT hanya bila user memintanya — dan renderer tak pernah melihat isinya: file ditulis di
  // sini, di main-process. Peringatan "file ini rahasia" ada di panel Akun.
  ipcMain.handle('grove:exportAccounts', (_e, { withTokens }: { withTokens: boolean }) =>
    saveJsonDialog('grove-accounts.json', manager.exportAccountsData(!!withTokens))
  )
  ipcMain.handle('grove:importAccounts', async (): Promise<ImportResult | null> => {
    const f = await openJsonDialog()
    if (!f) return null
    assertKind(f.data, 'grove-accounts')
    return { file: f.path, accounts: manager.importAccountsData(f.data) }
  })
  ipcMain.handle('grove:setAutoResume', (_e, { on }: { on: boolean }) => manager.setAutoResume(on))

  ipcMain.handle('grove:interruptSession', (_e, { id }: { id: string }) => manager.interruptSession(id))

  ipcMain.handle('grove:deleteSession', (_e, { id }: { id: string }) => manager.deleteSession(id))

  ipcMain.handle('grove:getUsageStats', () => manager.getUsageStats())

  ipcMain.handle('grove:getSnapshot', () => manager.getSnapshot())

  ipcMain.handle('grove:getChat', (_e, { id }: { id: string }) => manager.getChat(id))
}
