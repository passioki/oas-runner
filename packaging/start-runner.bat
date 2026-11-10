@echo off
chcp 65001 >nul
REM OAS Runner 启动器（仅使用端；HTTP UI 端口 8789）。
REM
REM 本包由 oas-runner 仓库基于其轻薄应用（oasd-runner.exe）构建。Runner 内嵌
REM 调度器（没有独立调度进程），只提供 ui\runner.* —— Studio 创作 UI 不在本包内。
REM
REM 应用将 `--ui ui` 作为默认值注入（oasd::cli::run_as_with_args），因此这里
REM 无需 --ui 参数。若要使用其他 UI 目录，在下方命令行追加 `--ui <dir>`；
REM 显式参数始终优先。
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
echo Runner 正在启动：http://127.0.0.1:8789/
echo 配置：config\live.json（先编辑 device.serial / device.adb_path）
echo 日志：logs\runner.log
echo 停止：stop-runner.bat（或关闭本窗口）
endlocal
