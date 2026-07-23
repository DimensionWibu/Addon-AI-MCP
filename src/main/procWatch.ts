// PEMANTAU PROSES CLI — menjawab "worker mana yang memakan RAM/proses mana".
//
// SDK TIDAK memberi tahu pid subprocess yang ia jalankan (sudah diperiksa: pesan system/init hanya
// memuat cwd, model, tools, dst — tak ada pid). Jadi pid didapat dengan MENYENARAIKAN proses anak
// milik Grove, lalu dipetakan ke sesi berdasarkan WAKTU MULAI: query yang baru dinyalakan pasti
// melahirkan proses baru sesaat setelahnya.
//
// Pemetaan ini JUJUR-BEST-EFFORT: kalau dua sesi start nyaris bersamaan, urutannya bisa tertukar,
// dan proses yang tak bisa dicocokkan ditampilkan apa adanya sebagai "(tak terpetakan)" — tidak
// pernah ditebak-tebak ke sesi mana pun.
import { exec } from 'node:child_process'

export interface CliProc {
  pid: number
  ppid: number
  ramMb: number
  startedAt: number // epoch ms
}

/**
 * Semua proses CLI (claude.exe / node.exe) yang merupakan TURUNAN dari `rootPid` (default: proses
 * ini). rootPid bisa ditimpa agar fungsinya dapat diuji terhadap instance Grove yang sedang jalan.
 */
export function listCliProcs(rootPid: number = process.pid): Promise<CliProc[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CreationDate; ` +
    `$out = @(); $frontier = @(${rootPid}); ` +
    `while ($frontier.Count -gt 0) { $next = @(); foreach ($p in $frontier) { foreach ($c in $all) { if ($c.ParentProcessId -eq $p) { $out += $c; $next += $c.ProcessId } } }; $frontier = $next }; ` +
    `$out | Where-Object { $_.Name -match 'claude|node' } | ForEach-Object { ` +
    `'{0},{1},{2},{3}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }`
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([])
      const rows: CliProc[] = []
      for (const line of stdout.split('\n')) {
        const [pid, ppid, ram, started] = line.trim().split(',')
        if (!pid) continue
        rows.push({ pid: Number(pid), ppid: Number(ppid), ramMb: Math.round(Number(ram) / 1048576), startedAt: Number(started) })
      }
      resolve(rows.filter((r) => Number.isFinite(r.pid)))
    })
  })
}
