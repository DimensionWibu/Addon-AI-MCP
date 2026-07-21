// Handler IPC: renderer → main.
import { app, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionManager } from './orchestrator/SessionManager'
import type { ImageAttachment } from '../shared/types'
import { fetchOpenRouterModels } from './openrouter'

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

  ipcMain.handle('grove:stopSession', (_e, { id }: { id: string }) => manager.stopSession(id))

  ipcMain.handle('grove:stopAll', () => manager.stopAll())

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
        provider?: 'claude' | 'openrouter' | 'custom'
        model?: string
        baseUrl?: string
      }
    ) => manager.addAccount(label, token, plan, switchPct, provider, model, baseUrl)
  )
  ipcMain.handle('grove:deleteAccount', (_e, { id }: { id: string }) => manager.deleteAccount(id))
  ipcMain.handle('grove:setAccountSwitchPct', (_e, { id, pct }: { id: string; pct: number | null }) =>
    manager.setAccountSwitchPct(id, pct)
  )
  ipcMain.handle('grove:setDefaultSwitchPct', (_e, { pct }: { pct: number }) => manager.setDefaultSwitchPct(pct))
  ipcMain.handle('grove:setDefaultAccount', (_e, { accountId }: { accountId: string | null }) =>
    manager.setDefaultAccount(accountId)
  )
  ipcMain.handle('grove:setDefaultModel', (_e, { model }: { model: string | null }) =>
    manager.setDefaultModel(model)
  )
  ipcMain.handle('grove:setSessionModel', (_e, { id, model }: { id: string; model: string | null }) =>
    manager.setSessionModel(id, model)
  )
  ipcMain.handle('grove:setLite', (_e, { id, lite }: { id: string; lite: boolean }) => manager.setLite(id, lite))
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
  ipcMain.handle('grove:setAutoResume', (_e, { on }: { on: boolean }) => manager.setAutoResume(on))

  ipcMain.handle('grove:interruptSession', (_e, { id }: { id: string }) => manager.interruptSession(id))

  ipcMain.handle('grove:deleteSession', (_e, { id }: { id: string }) => manager.deleteSession(id))

  ipcMain.handle('grove:getUsageStats', () => manager.getUsageStats())

  ipcMain.handle('grove:getSnapshot', () => manager.getSnapshot())

  ipcMain.handle('grove:getChat', (_e, { id }: { id: string }) => manager.getChat(id))
}
