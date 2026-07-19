// MCP tools in-process yang diberikan ke SETIAP session.
// Satu instance server per session → handler tahu callerSessionId lewat closure.
// Isolasi ditegakkan di implementasi GroveHost (SessionManager).

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BoardEntry, InboxMessage, TodoItem } from '../../shared/types'

/** Kontrak yang harus disediakan SessionManager ke tools (hindari circular import). */
export interface GroveHost {
  spawnWorker(parentId: string, opts: { title: string; task: string; model?: string }): Promise<string>
  assignToWorker(callerId: string, workerId: string, task: string): void
  setTitle(sessionId: string, title: string): void
  updateSummary(sessionId: string, summary: string): void
  updateTodo(sessionId: string, items: TodoItem[]): void
  reportProgress(sessionId: string, progress: string, percent?: number): void
  reportToParent(fromId: string, opts: { status: string; percent?: number }): void
  saveCompaction(sessionId: string, summary: string): void
  taskDone(sessionId: string): void
  readBoard(sessionId: string, scope: 'tree' | 'all'): (BoardEntry & { title: string; treeId: string; role: string; status: string })[]
  sendMessage(fromId: string, to: string | null, body: string): void
  readMessages(sessionId: string, unreadOnly: boolean): InboxMessage[]
  listWorkers(sessionId: string): { id: string; title: string; role: string; status: string }[]
  /**
   * Dipanggil Session saat satu turn selesai — dipakai membangunkan root untuk lapor ke user.
   * `outcome` HANYA diisi bila turn berakhir WAJAR (result sukses, bukan interupsi/limit/blokir API)
   * DAN worker belum melapor final sendiri → host wajib melapor otomatis ke parent.
   */
  notifyTurnEnd(sessionId: string, outcome?: { finalText: string }): void
  /** Token akun untuk di-inject ke query (null → pakai login default). */
  getAccountToken(accountId?: string): string | null
  /** Dipanggil Session saat turn gagal karena limit — untuk auto-switch akun bila aktif. */
  onLimitHit(sessionId: string): void
  /** Dipanggil Session saat ctx% ≥ ambang → auto-compact (padatkan konteks, cegah freeze). */
  notifyHighContext(sessionId: string): void
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })

// HEMAT KONTEKS: semua teks yang ditulis agent ke papan/pesan akan MASUK ke konteks sesi lain
// (board disuntik ke tiap auto-ping root; pesan dibaca penerima). Tanpa batas, satu laporan
// 10.000 karakter membebani setiap pembaca. Batas ditegakkan di sini, bukan sekadar diimbau.
export const CAP_MESSAGE = 1200 // isi send_message
const CAP_SUMMARY = 600 // update_summary
export const CAP_PROGRESS = 200 // report_progress / report_to_parent
const CAP_TODO_ITEM = 100 // teks per item todo
const MAX_TODO_ITEMS = 12
const CAP_READ_MESSAGES = 4000 // total hasil read_messages

/** Potong teks dengan penanda jelas agar agent tahu isinya dipangkas. */
export function cap(s: string, max: number): string {
  const t = (s ?? '').trim()
  return t.length <= max ? t : `${t.slice(0, max)}… [dipotong ${t.length - max} char — ringkas saja]`
}

export function buildGroveServer(sessionId: string, host: GroveHost) {
  const spawnWorker = tool(
    'spawn_worker',
    'Spawn a NEW sub-worker session in YOUR tree for a self-contained sub-task. Prefer reusing an existing idle worker with assign_worker first (check list_workers) — only spawn when none is suitable or you need more parallelism. You may share full context. Returns the new worker id.',
    {
      title: z.string().describe('Short human-readable title for the sub-worker'),
      task: z.string().describe('A clear, self-contained task description for the sub-worker'),
      model: z.string().optional().describe('Optional model override, e.g. "sonnet" or "opus"')
    },
    async (args) => {
      const id = await host.spawnWorker(sessionId, { title: args.title, task: args.task, model: args.model })
      return ok(`Spawned worker "${args.title}" with id ${id}. It runs in your tree and will report to the board.`)
    }
  )

  const assignWorker = tool(
    'assign_worker',
    'Hand a NEW task to an EXISTING sub-worker in your tree (found via list_workers). REUSE this instead of spawn_worker whenever an idle worker exists — the worker resumes with its full prior context and it is cheaper than a fresh spawn. The task is delivered into the worker\'s inbox and it starts working immediately.',
    {
      worker_id: z.string().describe('Target worker session id, from list_workers'),
      task: z.string().describe('A clear, self-contained task for the worker to do next')
    },
    async (args) => {
      host.assignToWorker(sessionId, args.worker_id, args.task)
      return ok(`Assigned a new task to worker ${args.worker_id}. It resumed with its prior context and is now working.`)
    }
  )

  const setTitle = tool(
    'set_title',
    'Set a concise 3-6 word title for THIS session that reflects the task/topic. Call this early, once you understand the request.',
    { title: z.string().describe('Short title, 3-6 words, no quotes') },
    async (args) => {
      host.setTitle(sessionId, args.title.trim())
      return ok(`Title set to "${args.title.trim()}".`)
    }
  )

  const updateSummary = tool(
    'update_summary',
    'Set/update your 1-3 sentence summary (goal + current result) on the shared board. Keep it under ~600 chars — it is truncated, and the board is injected into the orchestrator context on every status ping.',
    { summary: z.string() },
    async (args) => {
      host.updateSummary(sessionId, cap(args.summary, CAP_SUMMARY))
      return ok('Summary updated.')
    }
  )

  const updateTodo = tool(
    'update_todo',
    'Replace your task checklist on the shared board.',
    { items: z.array(z.object({ text: z.string(), done: z.boolean() })) },
    async (args) => {
      host.updateTodo(sessionId, args.items.slice(0, MAX_TODO_ITEMS).map((t) => ({ ...t, text: cap(t.text, CAP_TODO_ITEM) })))
      return ok(`Todo updated (${args.items.length} items).`)
    }
  )

  const reportProgress = tool(
    'report_progress',
    'ONE short sentence on what you are doing RIGHT NOW (+ optional percent). Under ~200 chars (truncated). Call when you switch activity so the dashboard stays live.',
    {
      progress: z.string(),
      percent: z.number().min(0).max(100).optional().describe('Rough completion percent 0-100 for the progress bar')
    },
    async (args) => {
      host.reportProgress(sessionId, cap(args.progress, CAP_PROGRESS), args.percent)
      return ok('Progress reported.')
    }
  )

  const reportToParent = tool(
    'report_to_parent',
    'Report your progress UP to the root/orchestrator of your tree so it can tell the user how far along things are. Call at meaningful milestones (~every 25%) AND when finished (percent 100). Also updates your board progress. (No-op if you are the root — you have no parent.)',
    {
      status: z.string().describe('One short sentence: what you just finished or are doing now'),
      percent: z.number().min(0).max(100).optional().describe('Rough completion percent 0-100')
    },
    async (args) => {
      host.reportToParent(sessionId, { status: cap(args.status, CAP_PROGRESS), percent: args.percent })
      return ok('Reported to parent orchestrator.')
    }
  )

  const saveCompaction = tool(
    'save_compaction',
    'Save a consolidated "compaction" summary of your ENTIRE tree to Grove memory. Call this only when asked to compact (a [GROVE COMPACT] request). The summary must be self-contained (goal, each worker\'s outcome, key decisions, current state, remaining work) because AFTER saving, your context is condensed down to this summary — raw earlier detail is dropped.',
    { summary: z.string().describe('The self-contained consolidated summary to keep as memory') },
    async (args) => {
      host.saveCompaction(sessionId, args.summary)
      return ok('Compaction saved to memory. Your context will be condensed to this summary.')
    }
  )

  const taskDone = tool(
    'task_done',
    'Call this ONLY when the ENTIRE task for your tree is fully complete (all workers finished, nothing left to do). It stops the periodic auto-check ("udah sampe mana?") loop for this session. It will restart automatically when the user sends a new task.',
    {},
    async () => {
      host.taskDone(sessionId)
      return ok('Marked task complete. Periodic auto-check stopped.')
    }
  )

  const readBoard = tool(
    'read_board',
    'Read the shared board (summary/todo/progress) of sessions. scope "tree" (default) = only your own tree; "all" = every tree (use sparingly — it is large and floods your context). Read-only awareness — do NOT work on another tree\'s task.',
    { scope: z.enum(['tree', 'all']).default('tree') },
    async (args) => {
      const rows = host.readBoard(sessionId, args.scope)
      return ok(JSON.stringify(rows)) // kompak (tanpa indentasi) → hemat token konteks
    }
  )

  const sendMessage = tool(
    'send_message',
    'Send a SHORT coordination note to another session IN YOUR OWN TREE (or omit `to` to broadcast to your tree only). Keep it under ~1200 chars — it is HARD-TRUNCATED, and every recipient pays for it in their context. Send conclusions, not full reports/diffs/code dumps (put detail in files instead). Isolated to your own tree; it is a note, not a task.',
    { to: z.string().optional().describe('Target session id in your tree; omit to broadcast within your tree'), body: z.string() },
    async (args) => {
      host.sendMessage(sessionId, args.to ?? null, cap(args.body, CAP_MESSAGE))
      return ok('Message sent.')
    }
  )

  const readMessages = tool(
    'read_messages',
    'Read messages addressed to you (and broadcasts). Marks them read.',
    { unread_only: z.boolean().default(true) },
    async (args) => {
      const msgs = host.readMessages(sessionId, args.unread_only)
      // Batasi total agar inbox besar tak membanjiri konteks pembaca.
      return ok(cap(JSON.stringify(msgs), CAP_READ_MESSAGES))
    }
  )

  const listWorkers = tool(
    'list_workers',
    'List the sessions in YOUR tree (for coordinating with your sub-workers).',
    {},
    async () => {
      return ok(JSON.stringify(host.listWorkers(sessionId))) // kompak → hemat token
    }
  )

  return createSdkMcpServer({
    name: 'grove',
    version: '0.1.0',
    tools: [spawnWorker, assignWorker, setTitle, updateSummary, updateTodo, reportProgress, reportToParent, saveCompaction, taskDone, readBoard, sendMessage, readMessages, listWorkers]
  })
}
