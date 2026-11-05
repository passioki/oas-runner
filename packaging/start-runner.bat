@echo off
REM Start the OAS Runner (Phase 1b template; publish layout expected next to this file).
setlocal
cd /d "%~dp0.."
if not exist "oasd-runner.exe" (
  echo [oas-runner] oasd-runner.exe not found in %CD%
  echo             build it with: cargo build --release --target-dir ..\..\target
  exit /b 1
)
start "OAS Runner" "oasd-runner.exe" --port 8789 --ui ui --tasks-dir tasks --runs-dir runs --assets-dir assets --config "config\live.json" --no-open
echo [oas-runner] started on http://127.0.0.1:8789/
