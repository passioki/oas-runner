# Runner 一键启动（oas-runner）
#
# 后台启动已打包的 Runner（dist/stage-runner），校验
# /runner/health，并打开 Runner UI。本脚本是源码树工具；
# 终端用户通常应使用发布包内的 start-runner.bat。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-runner.ps1
#   powershell ... -File scripts\start-runner.ps1 -Port 8799 -NoOpen
#   powershell ... -File scripts\start-runner.ps1 -DryRun
#   powershell ... -File scripts\start-runner.ps1 -StageDir D:\some\runner-package
#
# 退出码：0 已启动/已在运行，1 用法/预检/启动失败。

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
        # Windows 版本没有 Get-NetTCPConnection 时回退到 netstat。
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
        Write-Step "Runner 未在端口 $Port 监听。"
        exit 0
    }
    $proc = Get-Process -Id $listener -ErrorAction SilentlyContinue
    if (-not $proc) {
        Fail "端口 $Port 被 PID $listener 占用，但进程不可访问。"
    }
    try {
        Stop-Process -Id $listener -Force
        Start-Sleep -Milliseconds 500
        if ($pidFile -and (Test-Path -LiteralPath $pidFile)) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
        Write-Step "已停止端口 $Port 上的 Runner（PID $listener）。"
        exit 0
    } catch {
        Fail "无法停止 Runner（PID $listener）：$($_.Exception.Message)"
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

Write-Step "仓库   ：$repoRoot"
Write-Step "Stage  ：$StageDir"
Write-Step "端口   ：$Port"

if ($DryRun) {
    Write-Step "DRY RUN：不创建文件、不启动进程。"
    Write-Step "可执行文件：$exe"
    Write-Step "UI 目录   ：$uiDir"
    Write-Step "配置      ：$config"
    Write-Step "日志      ：$stdoutLog / $stderrLog"
    Fail "缺少 oasd-runner.exe；请先运行 scripts\package-runner.ps1。"
    exit 0
}

if (-not (Test-Path -LiteralPath $exe)) {
    Fail "未找到 oasd-runner.exe：$exe`n请先构建/打包：scripts\package-runner.ps1 -DataFrom <oas-core> -ToolkitFrom <toolkit>"
}
if (-not (Test-Path -LiteralPath $uiDir)) {
    Fail "未找到 Runner UI 目录：$uiDir"
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
        Write-Step "已从 live.example.json 创建 config\live.json；首次使用前请修改 device.serial / adb_path。"
    } else {
        Fail "$StageDir 中既没有 config\live.json，也没有 config\live.example.json"
    }
}

$listener = Get-ListenerPid $Port
if ($listener) {
    if (Test-RunnerHealth $Port) {
        Write-Step "Runner 已在 http://127.0.0.1:$Port/ 运行（PID $listener）。"
        if (-not $NoOpen) { Start-Process "http://127.0.0.1:$Port/" | Out-Null }
        exit 0
    }
    Fail "端口 $Port 已被 PID $listener 占用，但 /runner/health 无响应。`n请先带 -Stop 运行本脚本，或停止占用的进程。"
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

Write-Step "正在启动 oasd-runner.exe ..."
$proc = Start-Process -FilePath $exe -ArgumentList $runnerArgs -WorkingDirectory $StageDir `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru -WindowStyle Hidden
try {
    [System.IO.File]::WriteAllText($pidFile, "$($proc.Id)`r`n")
} catch { /* pid 文件仅用于诊断 */ }

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
    Write-Host '[OAS] Runner 未在 /runner/health 上就绪。' -ForegroundColor Red
    Write-Host "[OAS] stdout：$stdoutLog"
    Write-Host "[OAS] stderr：$stderrLog"
    Write-Host '[OAS] stderr 最后几行：'
    if (Test-Path -LiteralPath $stderrLog) {
        Get-Content -LiteralPath $stderrLog -Tail 20 -ErrorAction SilentlyContinue |
            ForEach-Object { Write-Host "  $_" }
    }
    exit 1
}

Write-Step "Runner 已启动：http://127.0.0.1:$Port/（PID $($proc.Id)）"
Write-Step "配置 ：$config"
Write-Step "日志 ：$stdoutLog"
Write-Step "停止 ：scripts\start-runner.ps1 -Stop"
if (-not $NoOpen) {
    Start-Process "http://127.0.0.1:$Port/" | Out-Null
}
exit 0
