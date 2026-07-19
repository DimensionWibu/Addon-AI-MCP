// Handler IPC: renderer → main.
import { app, dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionManager } from './orchestrator/SessionManager'
import type { ImageAttachment } from '../shared/types'

export function registerIpc(manager: SessionManager): void {
  ipcMain.handle('grove:dropFolder', (_e, { path, title }: { path: string; title?: string }) => {
    if (!path || !existsSync(path)) throw new Error(`Folder tidak ditemukan: ${path}`)
    const dir = statSync(path).isDirectory() ? path : dirname(path)
    return manager.createRoot(dir, title)
  })

  // Chat tanpa folder ("tanya-tanya") → jalan di folder scratch khusus (bukan proyek).
  ipcMain.handle('grove:newChat', (_e, { title }: { title?: string }) => {
    const scratch = join(app.getPath('userData'), 'scratch')
    if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true })
    return manager.createRoot(scratch, title || 'Chat baru')
  })

  // Pilih folder proyek lewat dialog (alternatif drag-drop).
  ipcMain.handle('grove:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return manager.createRoot(r.filePaths[0])
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
  ipcMain.handle('grove:addAccount', (_e, { label, token }: { label: string; token: string }) =>
    manager.addAccount(label, token)
  )
  ipcMain.handle('grove:deleteAccount', (_e, { id }: { id: string }) => manager.deleteAccount(id))
  ipcMain.handle('grove:setSessionAccount', (_e, { id, accountId }: { id: string; accountId: string | null }) =>
    manager.setSessionAccount(id, accountId)
  )
  ipcMain.handle('grove:setAutoSwitch', (_e, { on }: { on: boolean }) => manager.setAutoSwitch(on))
  ipcMain.handle('grove:setAutoResume', (_e, { on }: { on: boolean }) => manager.setAutoResume(on))

  ipcMain.handle('grove:interruptSession', (_e, { id }: { id: string }) => manager.interruptSession(id))

  ipcMain.handle('grove:deleteSession', (_e, { id }: { id: string }) => manager.deleteSession(id))

  ipcMain.handle('grove:getSnapshot', () => manager.getSnapshot())

  ipcMain.handle('grove:getChat', (_e, { id }: { id: string }) => manager.getChat(id))
}
