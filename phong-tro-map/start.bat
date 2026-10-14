@echo off
rem Bam dup file nay (Windows) de chay RentMAPs va mo trinh duyet.
cd /d "%~dp0"
if "%PORT%"=="" set PORT=3100
where node >nul 2>nul
if errorlevel 1 (
  echo May chua cai Node.js. Tai ban LTS tai https://nodejs.org, cai xong roi bam dup lai file nay.
  start "" https://nodejs.org/
  pause
  exit /b 1
)
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%"
node server.js
pause
