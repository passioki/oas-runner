@echo off
chcp 65001 >nul
REM 停止由 start-runner.bat 启动的 OAS Runner。
REM
REM 优先 HTTP 优雅停止，让内嵌调度器完成当前尝试并释放调度锁/设备租约；
REM 若 API 不可达或约 8 秒后进程仍存活，则回退强制结束。
setlocal
powershell -NoProfile -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$api='http://127.0.0.1:8789/runner/scheduler/stop';" ^
  "$p=Get-NetTCPConnection -LocalPort 8789 -State Listen;" ^
  "if (-not $p) { Write-Host 'Runner 未在运行'; exit 0 }" ^
  "try { Invoke-WebRequest -Method Post -Uri $api -TimeoutSec 6 -UseBasicParsing | Out-Null; Write-Host '已请求停止（等待调度器收尾）' } catch { Write-Host '停止 API 不可达；将强制停止' }" ^
  "for ($i=0; $i -lt 16; $i++) { Start-Sleep -Milliseconds 500; $p=Get-NetTCPConnection -LocalPort 8789 -State Listen; if (-not $p) { Write-Host 'Runner 已停止'; exit 0 } }" ^
  "$p=Get-NetTCPConnection -LocalPort 8789 -State Listen; if ($p) { Stop-Process -Id $p.OwningProcess -Force; Write-Host 'Runner 已强制停止（调度尝试未在时限内完成）' } else { taskkill /IM oasd-runner.exe /F >nul 2>&1; Write-Host 'Runner 已停止' }"
endlocal
