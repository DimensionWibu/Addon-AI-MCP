// Preload: jembatan aman renderer ↔ main (contextIsolation ON).
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { GroveApi, GroveEvent, ImageAttachment } from '../shared/types'

const api: GroveApi = {
  // Electron 32+: File.path dihapus; pakai webUtils.getPathForFile.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  dropFolder: (path: string, title?: string) => ipcRenderer.invoke('grove:dropFolder', { path, title }),
  newChat: (title?: string) => ipcRenderer.invoke('grove:newChat', { title }),
  newWorker: (parentId: string, title?: string) => ipcRenderer.invoke('grove:newWorker', { parentId, title }),
  pickFolder: () => ipcRenderer.invoke('grove:pickFolder'),
  setSessionCwd: (id: string, path: string) => ipcRenderer.invoke('grove:setSessionCwd', { id, path }),
  sendChat: (id: string, text: string, images?: ImageAttachment[]) =>
    ipcRenderer.invoke('grove:sendChat', { id, text, images }),
  askSide: (id: string, question: string) => ipcRenderer.invoke('grove:askSide', { id, question }),
  getDeepseekCosts: () => ipcRenderer.invoke('grove:getDeepseekCosts'),
  listQueued: (id: string) => ipcRenderer.invoke('grove:listQueued', { id }),
  editQueued: (id: string, qid: number, text: string) => ipcRenderer.invoke('grove:editQueued', { id, qid, text }),
  cancelQueued: (id: string, qid: number) => ipcRenderer.invoke('grove:cancelQueued', { id, qid }),
  linkReference: (helperId: string, targetId: string) =>
    ipcRenderer.invoke('grove:linkReference', { helperId, targetId }),
  unlinkReference: (helperId: string, targetId: string) =>
    ipcRenderer.invoke('grove:unlinkReference', { helperId, targetId }),
  listReferences: (helperId: string) => ipcRenderer.invoke('grove:listReferences', { helperId }),
  stopSession: (id: string) => ipcRenderer.invoke('grove:stopSession', { id }),
  stopAll: () => ipcRenderer.invoke('grove:stopAll'),
  resumeAll: () => ipcRenderer.invoke('grove:resumeAll'),
  reorderSessions: (orderedIds: string[]) => ipcRenderer.invoke('grove:reorder', { ids: orderedIds }),
  compactSession: (id: string) => ipcRenderer.invoke('grove:compact', { id }),
  setLoop: (id: string, enabled: boolean) => ipcRenderer.invoke('grove:setLoop', { id, enabled }),
  listAccounts: () => ipcRenderer.invoke('grove:listAccounts'),
  addAccount: (
    label: string,
    token: string,
    plan?: number,
    switchPct?: number,
    provider?: 'claude' | 'openrouter' | 'custom' | 'cursor' | 'deepseek' | 'dzax',
    model?: string,
    baseUrl?: string
  ) => ipcRenderer.invoke('grove:addAccount', { label, token, plan, switchPct, provider, model, baseUrl }),
  updateAccount: (id: string, patch: { label?: string; token?: string; model?: string; baseUrl?: string; plan?: number | null }) =>
    ipcRenderer.invoke('grove:updateAccount', { id, patch }),
  deleteAccount: (id: string) => ipcRenderer.invoke('grove:deleteAccount', { id }),
  setAccountSwitchPct: (id: string, pct: number | null) =>
    ipcRenderer.invoke('grove:setAccountSwitchPct', { id, pct }),
  setDefaultSwitchPct: (pct: number) => ipcRenderer.invoke('grove:setDefaultSwitchPct', { pct }),
  setDefaultAccount: (accountId: string | null) => ipcRenderer.invoke('grove:setDefaultAccount', { accountId }),
  applyAccountToAll: (accountId: string | null) => ipcRenderer.invoke('grove:applyAccountToAll', { accountId }),
  setAccountOrder: (ids: string[]) => ipcRenderer.invoke('grove:setAccountOrder', { ids }),
  setVisionAccount: (accountId: string | null) => ipcRenderer.invoke('grove:setVisionAccount', { accountId }),
  setDefaultModel: (model: string | null) => ipcRenderer.invoke('grove:setDefaultModel', { model }),
  setSessionModel: (id: string, model: string | null) => ipcRenderer.invoke('grove:setSessionModel', { id, model }),
  setLite: (id: string, lite: boolean) => ipcRenderer.invoke('grove:setLite', { id, lite }),
  setSessionEffort: (id: string, effort: string | null) => ipcRenderer.invoke('grove:setSessionEffort', { id, effort }),
  setDefaultEffort: (effort: string | null) => ipcRenderer.invoke('grove:setDefaultEffort', { effort }),
  listGatewayModels: (accountId: string) => ipcRenderer.invoke('grove:listGatewayModels', { accountId }),
  fetchModelsFromUrl: (token: string, baseUrl: string) => ipcRenderer.invoke('grove:fetchModelsFromUrl', { token, baseUrl }),
  listOpenRouterModels: (freeOnly?: boolean) => ipcRenderer.invoke('grove:listOpenRouterModels', { freeOnly }),
  getUsageStats: () => ipcRenderer.invoke('grove:getUsageStats'),
  setSessionAccount: (id: string, accountId: string | null) =>
    ipcRenderer.invoke('grove:setSessionAccount', { id, accountId }),
  setAutoSwitch: (on: boolean) => ipcRenderer.invoke('grove:setAutoSwitch', { on }),
  setAutoResume: (on: boolean) => ipcRenderer.invoke('grove:setAutoResume', { on }),
  interruptSession: (id: string) => ipcRenderer.invoke('grove:interruptSession', { id }),
  deleteSession: (id: string) => ipcRenderer.invoke('grove:deleteSession', { id }),
  getSnapshot: () => ipcRenderer.invoke('grove:getSnapshot'),
  getChat: (id: string) => ipcRenderer.invoke('grove:getChat', { id }),
  refreshUsage: () => ipcRenderer.invoke('grove:refreshUsage'),
  setUsageSession: (sessionId: string | null) => ipcRenderer.invoke('grove:setUsageSession', { sessionId }),
  onEvent: (cb: (ev: GroveEvent) => void) => {
    const handler = (_e: unknown, ev: GroveEvent): void => cb(ev)
    ipcRenderer.on('grove:event', handler)
    return () => ipcRenderer.removeListener('grove:event', handler)
  }
}

contextBridge.exposeInMainWorld('grove', api)
