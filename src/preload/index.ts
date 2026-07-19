// Preload: jembatan aman renderer ↔ main (contextIsolation ON).
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { GroveApi, GroveEvent, ImageAttachment } from '../shared/types'

const api: GroveApi = {
  // Electron 32+: File.path dihapus; pakai webUtils.getPathForFile.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  dropFolder: (path: string, title?: string) => ipcRenderer.invoke('grove:dropFolder', { path, title }),
  newChat: (title?: string) => ipcRenderer.invoke('grove:newChat', { title }),
  pickFolder: () => ipcRenderer.invoke('grove:pickFolder'),
  sendChat: (id: string, text: string, images?: ImageAttachment[]) =>
    ipcRenderer.invoke('grove:sendChat', { id, text, images }),
  stopSession: (id: string) => ipcRenderer.invoke('grove:stopSession', { id }),
  stopAll: () => ipcRenderer.invoke('grove:stopAll'),
  reorderSessions: (orderedIds: string[]) => ipcRenderer.invoke('grove:reorder', { ids: orderedIds }),
  compactSession: (id: string) => ipcRenderer.invoke('grove:compact', { id }),
  setLoop: (id: string, enabled: boolean) => ipcRenderer.invoke('grove:setLoop', { id, enabled }),
  interruptSession: (id: string) => ipcRenderer.invoke('grove:interruptSession', { id }),
  deleteSession: (id: string) => ipcRenderer.invoke('grove:deleteSession', { id }),
  getSnapshot: () => ipcRenderer.invoke('grove:getSnapshot'),
  getChat: (id: string) => ipcRenderer.invoke('grove:getChat', { id }),
  getUsage: () => ipcRenderer.invoke('grove:getUsage'),
  onEvent: (cb: (ev: GroveEvent) => void) => {
    const handler = (_e: unknown, ev: GroveEvent): void => cb(ev)
    ipcRenderer.on('grove:event', handler)
    return () => ipcRenderer.removeListener('grove:event', handler)
  }
}

contextBridge.exposeInMainWorld('grove', api)
