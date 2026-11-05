@echo off
REM Stop the OAS Runner started by start-runner.bat.
REM
REM Prefer the graceful HTTP stop so the embedded scheduler finishes the current
REM attempt and releases the scheduler lock / device lease; fall back to a hard
REM kill if the API is unreachable or the process is still alive after ~8s.
setlocal
powershell -NoProfile -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$api='http://127.0.0.1:8789/runner/scheduler/stop';" ^
  "$p=Get-NetTCPConnection -LocalPort 8789 -State Listen;" ^
  "if (-not $p) { Write-Host 'runner not running'; exit 0 }" ^
  "try { Invoke-WebRequest -Method Post -Uri $api -TimeoutSec 6 -UseBasicParsing | Out-Null; Write-Host 'stop requested (waiting for scheduler to settle)' } catch { Write-Host 'stop API unreachable; will force stop' }" ^
  "for ($i=0; $i -lt 16; $i++) { Start-Sleep -Milliseconds 500; $p=Get-NetTCPConnection -LocalPort 8789 -State Listen; if (-not $p) { Write-Host 'runner stopped'; exit 0 } }" ^
  "$p=Get-NetTCPConnection -LocalPort 8789 -State Listen; if ($p) { Stop-Process -Id $p.OwningProcess -Force; Write-Host 'runner force-stopped (scheduler attempt did not finish in time)' } else { taskkill /IM oasd-runner.exe /F >nul 2>&1; Write-Host 'runner stopped' }"
endlocal
