@echo off
REM Jalankan Grove dari source (mode dev). Butuh Node.js terpasang.
cd /d "%~dp0"
if not exist node_modules (
  echo [Grove] node_modules belum ada, menginstall dependency...
  call npm install
  if errorlevel 1 (
    echo [Grove] npm install gagal. Cek koneksi/Node.js.
    pause
    exit /b 1
  )
)
echo [Grove] Menjalankan...
call npm run dev

