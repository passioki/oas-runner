@echo off
REM oas-runner one-click launcher wrapper.
REM Double-click this file (or run it from cmd) to start the packaged Runner.
setlocal
set "SCRIPT=%~dp0start-runner.ps1"
if not exist "%SCRIPT%" (
  echo [OAS] start-runner.ps1 not found next to this wrapper.
  pause
  exit /b 1
)

where pwsh.exe >nul 2>nul
if not errorlevel 1 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [OAS] Runner did not start. Exit code: %RC%
  pause
)
exit /b %RC%
