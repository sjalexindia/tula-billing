@echo off
rem Started by the scheduled task "Tula" (as SYSTEM, at power-on). Runs the Tula supervisor,
rem which starts the server, restarts it if it stops or hangs, applies restores and writes logs.
rem Usage: run-tula.cmd [path\to\tula.env]     (default C:\TulaData\tula.env)
rem You can also double-click it to run Tula in a window (Ctrl+C stops it).
setlocal
set "ENVFILE=%~1"
if "%ENVFILE%"=="" set "ENVFILE=C:\TulaData\tula.env"
rem The app root is two folders up from this script (C:\Tula\app\scripts\windows).
cd /d "%~dp0..\.."
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" for /f "delims=" %%N in ('where node.exe 2^>nul') do set "NODE=%%N"
if not exist "%NODE%" (
  echo Node.js was not found. Install Node.js LTS from https://nodejs.org and try again.
  exit /b 9009
)
"%NODE%" --import tsx apps\server\src\supervisor.ts --env-file "%ENVFILE%"
exit /b %ERRORLEVEL%
