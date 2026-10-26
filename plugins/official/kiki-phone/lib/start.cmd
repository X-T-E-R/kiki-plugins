@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Kiki Phone requires Node.js 22.12.0+ with npm. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
node "%~dp0prepare-cli.mjs" %*
set "KIKI_PHONE_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %KIKI_PHONE_EXIT%
