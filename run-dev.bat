@echo off
REM Jalankan Grove dari source. Butuh Node.js terpasang.
REM
REM   run-dev.bat          MODE STABIL (default): app dijalankan dari hasil build di out\.
REM                        Mengedit file sumber TIDAK mengganggu jendela yang sedang terbuka —
REM                        tak ada dev-server, tak ada hot-reload, tak ada restart otomatis.
REM                        Perubahan baru terpakai setelah app ditutup & dijalankan lagi.
REM
REM   run-dev.bat dev      MODE HOT-RELOAD (buat ngoprek UI): renderer auto-reload tiap file
REM                        disimpan. Praktis untuk styling, TAPI jendela ikut ter-reload.
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

set "GROVE_MODE=%~1"
if /i "%GROVE_MODE%"=="dev" (
  set "GROVE_SCRIPT=dev"
  echo [Grove] Mode HOT-RELOAD — jendela akan ikut reload tiap file disimpan.
) else (
  set "GROVE_SCRIPT=app"
  echo [Grove] Mode STABIL — edit file sumber tidak akan mengganggu jendela yang terbuka.
)

loop:
echo [Grove] Menjalankan...
call npm run %GROVE_SCRIPT%
echo.
echo [Grove] App tertutup. Restart dalam 3 detik... (tekan Ctrl+C untuk berhenti)
timeout /t 1 /nobreak >nul
goto loop
