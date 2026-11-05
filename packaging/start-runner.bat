@echo off
REM OAS Runner launcher (use-side only; HTTP UI on port 8789).
REM
REM This package is built by the oas-runner repository from its own thin app
REM (oasd-runner.exe). The Runner embeds the scheduler (there is no separate
REM scheduler process) and only serves ui\runner.* - the Studio authoring UI is
REM not part of this package.
REM
REM The app injects `--ui ui` as a DEFAULT (oasd::cli::run_as_with_args), so no
REM --ui flag is needed here. To use a different UI directory, append
REM `--ui <dir>` to the command line below; an explicit flag always wins.
setlocal
cd /d "%~dp0"
set "ADB_PATH=%~dp0adb\adb.exe"
if not exist "%ADB_PATH%" set "ADB_PATH=adb.exe"
if not exist "logs" mkdir logs
if not exist "runs" mkdir runs
if not exist "packages" mkdir packages
if not exist "tasks" mkdir tasks
if not exist "assets" mkdir assets
if not exist "config\live.json" if exist "config\live.example.json" copy /Y "config\live.example.json" "config\live.json" >nul

start "" /B "%~dp0oasd-runner.exe" ^
  --port 8789 ^
  --tasks-dir tasks ^
  --runs-dir runs ^
  --assets-dir assets ^
  --model models\PP-OCRv6_rec_small.onnx ^
  --det-model models\PP-OCRv6_det_small.onnx ^
  --config config\live.json >> logs\runner.log 2>&1

echo.
echo Runner starting: http://127.0.0.1:8789/
echo Config: config\live.json  (edit device.serial / device.adb_path first)
echo Logs:   logs\runner.log
echo Stop:   stop-runner.bat  (or close this window)
endlocal
