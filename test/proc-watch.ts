// PEMANTAU PROSES CLI — diuji terhadap instance GROVE YANG SEDANG JALAN (bukan proses tiruan),
// karena yang ingin dibuktikan adalah: pid subprocess CLI benar-benar bisa ditemukan & dibaca RAM-nya.
// Jalankan saat Grove terbuka: npx tsx test/proc-watch.ts
import { execSync } from 'node:child_process'
import { listCliProcs } from '../src/main/procWatch'

async function main(): Promise<void> {
  const out = execSync(
    'powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'electron.exe\' -and $_.CommandLine -like \'*Addon AI MCP*\' -and $_.ParentProcessId -notin (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'electron.exe\' }).ProcessId } | Select-Object -First 1).ProcessId"',
    { encoding: 'utf8' }
  ).trim()
  const grovePid = Number(out)
  if (!grovePid) {
    console.log('LEWAT: Grove tidak sedang berjalan — jalankan app-nya dulu untuk uji ini.')
    process.exit(0)
  }
  const procs = await listCliProcs(grovePid)
  console.log(`Grove pid ${grovePid} → ${procs.length} proses CLI turunan`)
  for (const p of procs) {
    console.log(`  pid ${p.pid} · ${p.ramMb} MB · lahir ${new Date(p.startedAt).toLocaleTimeString()}`)
  }
  const ok = procs.every((p) => p.pid > 0 && p.ramMb >= 0 && p.startedAt > 1_600_000_000_000)
  console.log(ok ? '\nsemua baris masuk akal (pid/RAM/waktu lahir terbaca)' : '\nADA BARIS TAK MASUK AKAL')
  process.exit(ok ? 0 : 1)
}
void main()
