@echo off
REM Stop the OAS Runner started by start-runner.bat.
setlocal
taskkill /IM oasd-runner.exe /F >nul 2>&1
if errorlevel 1 (
  echo [oas-runner] no oasd-runner.exe process found
) else (
  echo [oas-runner] stopped
)
