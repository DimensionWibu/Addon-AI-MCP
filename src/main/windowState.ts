// Simpan & pulihkan ukuran + posisi jendela (mirip electron-window-state, tanpa dependency).
// Disimpan ke <userData>/window-state.json; divalidasi agar tak memulihkan ke layar yang sudah lepas.
import { app, screen, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface WinState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

const DEFAULT: WinState = { width: 1360, height: 860 }
const file = (): string => join(app.getPath('userData'), 'window-state.json')

/** Titik tengah jendela masih berada di salah satu display yang terhubung? */
function onScreen(s: WinState): boolean {
  if (s.x == null || s.y == null) return true
  const cx = s.x + s.width / 2
  const cy = s.y + s.height / 2
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height
  })
}

export function loadWindowState(): WinState {
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8')) as WinState
    if (s && typeof s.width === 'number' && typeof s.height === 'number' && onScreen(s)) return s
  } catch {
    /* tak ada / rusak → pakai default */
  }
  return { ...DEFAULT }
}

/** Pantau resize/move/close → simpan (debounce). Simpan bounds NORMAL saat maximized. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const save = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return
    const maximized = win.isMaximized()
    const b = maximized ? win.getNormalBounds() : win.getBounds()
    const state: WinState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized }
    try {
      writeFileSync(file(), JSON.stringify(state))
    } catch {
      /* abaikan kegagalan tulis */
    }
  }
  const debounced = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  win.on('resize', debounced)
  win.on('move', debounced)
  win.on('close', save)
}
