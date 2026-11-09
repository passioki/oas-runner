# oas-runner one-click launcher
#
# Starts the packaged Runner (dist/stage-runner) in the background, verifies
# /runner/health, and opens the Runner UI. This script is source-tree tooling;
# end users should normally use the start-runner.bat inside a release package.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-runner.ps1
#   powershell ... -File scripts\start-runner.ps1 -Port 8799 -NoOpen
#   powershell ... -File scripts\start-runner.ps1 -DryRun
#   powershell ... -File scripts\start-runner.ps1 -StageDir D:\some\runner-package
#
# Exit codes: 0 started/already running, 1 usage/preflight/startup failure.

[CmdletBinding()]
param(
    [string]$StageDir = '',
    [int]$Port = 8789,
    [switch]$NoOpen,
    [switch]$DryRun,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message, [int]$Code = 1) {
    Write-Host "[OAS] $Message" -ForegroundColor Red
    exit $Code
}

function Write-Step([string]$Message) {
    Write-Host "[OAS] $Message"
}

function Get-ListenerPid([int]$ListenPort) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop |
            Select-Object -First 1
        if ($conn) { return [int]$conn.OwningProcess }
    } catch {
        # Fall back to netstat on Windows versions without Get-NetTCPConnection.
        $line = & netstat -ano 2>$null | Select-String -Pattern "TCP\s+\S+:$ListenPort\s+\S+\s+LISTENING\s+(\d+)" |
            Select-Object -First 1
        if ($line -and $line.Matches.Count -gt 0) { return [int]$line.Matches[0].Groups[1].Value }
    }
    return $null
}

function Test-RunnerHealth([int]$ListenPort) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$ListenPort/runner/health" `
            -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $StageDir) {
    $StageDir = Join-Path $repoRoot 'dist\stage-runner'
} elseif (-not [System.IO.Path]::IsPathRooted($StageDir)) {
    $StageDir = Join-Path $repoRoot $StageDir
}
$StageDir = [System.IO.Path]::GetFullPath($StageDir)

if ($Stop) {
    $pidFile = Join-Path $StageDir 'logs\runner.pid'
    $listener = Get-ListenerPid $Port
    if (-not $listener) {
        Write-Step "Runner is not listening on port $Port."
        exit 0
    }
    $proc = Get-Process -Id $listener -ErrorAction SilentlyContinue
    if (-not $proc) {
        Fail "Port $Port is owned by PID $listener, but the process is not accessible."
    }
    try {
        Stop-Process -Id $listener -Force
        Start-Sleep -Milliseconds 500
        if ($pidFile -and (Test-Path -LiteralPath $pidFile)) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
        Write-Step "Stopped Runner PID $listener on port $Port."
        exit 0
    } catch {
        Fail "Could not stop Runner PID $listener`: $($_.Exception.Message)"
    }
}

$exe = Join-Path $StageDir 'oasd-runner.exe'
$uiDir = Join-Path $StageDir 'ui'
$config = Join-Path $StageDir 'config\live.json'
$configExample = Join-Path $StageDir 'config\live.example.json'
$logsDir = Join-Path $StageDir 'logs'
$stdoutLog = Join-Path $logsDir 'runner.out.log'
$stderrLog = Join-Path $logsDir 'runner.err.log'
$pidFile = Join-Path $logsDir 'runner.pid'

Write-Step "Repository : $repoRoot"
Write-Step "Stage      : $StageDir"
Write-Step "Port       : $Port"

if ($DryRun) {
    Write-Step "DRY RUN: no files are created and no process is started."
    Write-Step "Executable : $exe"
    Write-Step "UI dir     : $uiDir"
    Write-Step "Config     : $config"
    Write-Step "Logs       : $stdoutLog / $stderrLog"
    if (-not (Test-Path -LiteralPath $exe)) { Fail "oasd-runner.exe is missing; run scripts\package-runner.ps1 first." }
    exit 0
}

if (-not (Test-Path -LiteralPath $exe)) {
    Fail "oasd-runner.exe not found: $exe`nBuild/package it first: scripts\package-runner.ps1 -DataFrom <oas-core> -ToolkitFrom <toolkit>"
}
if (-not (Test-Path -LiteralPath $uiDir)) {
    Fail "Runner ui directory not found: $uiDir"
}
foreach ($d in @('logs', 'runs', 'packages', 'tasks', 'assets', 'config')) {
    $path = Join-Path $StageDir $d
    if (-not (Test-Path -LiteralPath $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}
if (-not (Test-Path -LiteralPath $config)) {
    if (Test-Path -LiteralPath $configExample) {
        Copy-Item -LiteralPath $configExample -Destination $config -Force
        Write-Step "Created config\live.json from live.example.json; edit device.serial / adb_path before first use."
    } else {
        Fail "Neither config\live.json nor config\live.example.json exists in $StageDir"
    }
}

$listener = Get-ListenerPid $Port
if ($listener) {
    if (Test-RunnerHealth $Port) {
        Write-Step "Runner is already running on http://127.0.0.1:$Port/ (PID $listener)."
        if (-not $NoOpen) { Start-Process "http://127.0.0.1:$Port/" | Out-Null }
        exit 0
    }
    Fail "Port $Port is already in use by PID $listener, but /runner/health is not responding. `nRun this script with -Stop first, or stop the other process."
}

$runnerArgs = @(
    '--port', "$Port",
    '--ui', 'ui',
    '--tasks-dir', 'tasks',
    '--runs-dir', 'runs',
    '--assets-dir', 'assets',
    '--model', 'models\PP-OCRv6_rec_small.onnx',
    '--det-model', 'models\PP-OCRv6_det_small.onnx',
    '--config', 'config\live.json'
)

Write-Step "Starting oasd-runner.exe ..."
$proc = Start-Process -FilePath $exe -ArgumentList $runnerArgs -WorkingDirectory $StageDir `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru -WindowStyle Hidden
try {
    [System.IO.File]::WriteAllText($pidFile, "$($proc.Id)`r`n")
} catch { /* pid file is diagnostic only */ }

$deadline = (Get-Date).AddSeconds(30)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    if ($proc.HasExited) { break }
    if (Test-RunnerHealth $Port) { $healthy = $true; break }
}

if (-not $healthy) {
    if (-not $proc.HasExited) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    Write-Host ''
    Write-Host '[OAS] Runner did not become healthy on /runner/health.' -ForegroundColor Red
    Write-Host "[OAS] stdout: $stdoutLog"
    Write-Host "[OAS] stderr: $stderrLog"
    Write-Host '[OAS] Last stderr lines:'
    if (Test-Path -LiteralPath $stderrLog) {
        Get-Content -LiteralPath $stderrLog -Tail 20 -ErrorAction SilentlyContinue |
            ForEach-Object { Write-Host "  $_" }
    }
    exit 1
}

Write-Step "Runner started: http://127.0.0.1:$Port/ (PID $($proc.Id))"
Write-Step "Config : $config"
Write-Step "Logs   : $stdoutLog"
Write-Step "Stop   : scripts\start-runner.ps1 -Stop"
if (-not $NoOpen) {
    Start-Process "http://127.0.0.1:$Port/" | Out-Null
}
exit 0
