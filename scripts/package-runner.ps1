# oas-runner 发布打包（Windows）
#
# 本仓从自己的轻量应用构建 Runner（`apps/runner`，
# oas-core 由 `apps/runner/Cargo.toml` 中的提交 rev 固定）。此处生成的 zip
# 是**终端用户包**：Runner 界面（8789 上的 HTTP UI、任务包安装、
# 队列/调度/执行）、Runner UI、OCR 模型、捆绑的 Windows adb，
# 以及 oas-core 任务/素材的只读 `bundled-data/` 快照
# （Runner 首次启动时导入）。包内不含 Studio 创作 UI，
# 也不含 Studio 二进制。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-runner.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-runner.ps1 `
#       -DataFrom D:\OAS-dev\oas-core -ToolkitFrom D:\OAS-dev\backend\toolkit
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-runner.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-runner.ps1 -SkipBuild -Offline
#
# 输出（默认）：
#   dist\oasd-runner-v<version>-win64.zip
#   dist\oasd-runner-v<version>-win64.zip.sha256
#   dist\BUILD-INFO.txt                       （打包出的 BUILD-INFO.txt 副本）
#
# 设计说明：
#   * 本脚本以 **UTF-8 BOM** 保存：Windows PowerShell 5.1 才能正确读取中文。
#     脚本生成的所有文本文件仍写为**无 BOM UTF-8**，因为引擎 serde_json
#     会拒绝 UTF-8 BOM（"expected value at line 1 column 1"）。
#   * zip 用 System.IO.Compression.ZipArchive 手写，条目名统一用 `/`
#     分隔（PS 5.1 的 Compress-Archive 会写 `\`）。
#   * 默认执行构建（本仓拥有自己的二进制）：在 apps/runner 下运行
#     cargo build --release --target-dir <repo>\target；
#     exe 已存在时可传 -SkipBuild。
#
#
param(
  [string]$Version = "0.1.0",
    # oas-core 检出目录，其 tasks/ + assets/ 将成为 bundled-data/（默认：
    # 自动探测本仓旁的 ..\oas-core）。
  [string]$DataFrom = "",
    # -NoData：生成仅程序包（无 bundled-data/）。不传时
    # 缺少数据源会报错，而不是静默产出空的“bundled”包。
  [switch]$NoData,
    # 包含 OCR 模型与 Windows adb 二进制的 toolkit 根目录
    # （默认自动探测 ..\oas-core\backend\toolkit 或 D:\OAS-dev\backend\toolkit；
    # 支持扁平布局 <root>\models + <root>\adb，也支持 Python toolkit
    # 布局 <root>\Lib\site-packages\rapidocr\models + adbutils\binaries）。
  [string]$ToolkitFrom = "",
    # -SkipToolkit：允许生成不含 models/adb 的包（仅调试/瘦身构建）。
  [switch]$SkipToolkit,
    # -OutFile：zip 路径（非绝对路径时相对仓库根）。
  [string]$OutFile = "",
  [switch]$SkipBuild,
    # -Offline：给 cargo 传 --offline（依赖均已拉取/缓存）。
  [switch]$Offline,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$RepoParent = Split-Path -Parent $Root

# --------------------------------------------------------------- 辅助函数
# 为本脚本生成的所有文本/JSON 文件写无 BOM UTF-8。
function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true, ValueFromPipeline = $true)][AllowEmptyString()][string]$Text,
    [Parameter(Mandatory = $true)][string]$Path
  )
  begin { $sb = New-Object System.Text.StringBuilder }
  process { [void]$sb.AppendLine([string]$Text) }
  end {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $sb.ToString(), $utf8)
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash $Path -Algorithm SHA256).Hash
}

function Test-HasUtf8Bom {
  param([Parameter(Mandatory = $true)][string]$Path)
  $b = [System.IO.File]::ReadAllBytes($Path)
  return ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
}

function Get-GitShort {
  param([Parameter(Mandatory = $true)][string]$Dir)
  try {
    $line = & git -C $Dir rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $line) { return ($line | Select-Object -First 1).ToString().Trim() }
  } catch { }
  return "unknown"
}

function Get-GitSubject {
  param([Parameter(Mandatory = $true)][string]$Dir)
  try {
    $line = & git -C $Dir log -1 --format="%h %s" 2>$null
    if ($LASTEXITCODE -eq 0 -and $line) { return ($line | Select-Object -First 1).ToString().Trim() }
  } catch { }
  return "unknown"
}

function Get-GitRemote {
  param([Parameter(Mandatory = $true)][string]$Dir)
  try {
    $url = & git -C $Dir remote get-url origin 2>$null
    if ($LASTEXITCODE -eq 0 -and $url) { return ($url | Select-Object -First 1).ToString().Trim() }
  } catch { }
  return ""
}

# 将 toolkit 根解析为（models 目录, adb 目录）对，失败返回 $null。
# 同时支持扁平发布布局（<root>\models + <root>\adb）与
# 开发机使用的 Python toolkit 布局。
function Resolve-Toolkit {
  param([string]$Hint)
  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($Hint)) { $candidates += $Hint }
  $candidates += (Join-Path $RepoParent "oas-core\backend\toolkit")
  $candidates += "D:\OAS-dev\backend\toolkit"
  foreach ($c in $candidates) {
    if (-not (Test-Path $c)) { continue }
    $models = Join-Path $c "models"
    if (-not (Test-Path $models)) {
      $models = Join-Path $c "Lib\site-packages\rapidocr\models"
    }
    $adb = Join-Path $c "adb"
    if (-not (Test-Path $adb)) {
      $adb = Join-Path $c "Lib\site-packages\adbutils\binaries"
    }
    if ((Test-Path $models) -and (Test-Path $adb)) {
      return [pscustomobject]@{ Root = $c; Models = $models; Adb = $adb }
    }
  }
  return $null
}

# ----------------------------------------------------------------- 参数
if ([string]::IsNullOrWhiteSpace($Version) -or $Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]*$') {
    throw "非法 -Version 值 '$Version'（示例：1.2.3）"
}

$AppDir = Join-Path $Root "apps\runner"
$TargetDir = Join-Path $Root "target"
$Exe = Join-Path $TargetDir "release\oasd-runner.exe"
$UiDir = Join-Path $Root "ui"
$PackagingDir = Join-Path $Root "packaging"

$OutDir = Join-Path $Root "dist"
if ([string]::IsNullOrWhiteSpace($OutFile)) {
  $OutFile = Join-Path $OutDir ("oasd-runner-v{0}-win64.zip" -f $Version)
} elseif (-not [System.IO.Path]::IsPathRooted($OutFile)) {
  $OutFile = Join-Path $Root $OutFile
}
$Zip = $OutFile
$ZipName = Split-Path -Leaf $Zip
$ShaFile = $Zip + ".sha256"
$BuildInfoOut = Join-Path $OutDir "BUILD-INFO.txt"
$Stage = Join-Path $OutDir "stage-runner"

$ModelFiles = @("PP-OCRv6_rec_small.onnx", "PP-OCRv6_det_small.onnx")
$AdbFiles = @("adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll")
$RunnerUiFiles = @("runner.html", "runner.js", "runner.css", "style.css")
# Studio 专属创作 UI 绝不能进入 Runner 包。
$ForbiddenUiNames = @(
  "index.html", "app.js", "builder.js", "flow_model.js", "asset_ui.js",
  "flow_model_test.html", "dashboard.html", "dashboard.js", "ui_pure_test.js"
)

Write-Host "== OAS Runner 打包 v$Version（oas-runner 独立包）=="

# ------------------------------------------------------------------- 构建
if ($DryRun) {
    Write-Host "-- [DRY-RUN] 已跳过构建（去掉 -DryRun 才会实际打包）"
} elseif (-not $SkipBuild) {
    Write-Host "-- cargo build --release --target-dir $TargetDir（在 apps\runner）"
  Push-Location $AppDir
  try {
    $cargoArgs = @("build", "--release", "--target-dir", $TargetDir)
    if ($Offline) { $cargoArgs += "--offline" }
    & cargo @cargoArgs
        if ($LASTEXITCODE -ne 0) { throw "cargo build 失败（退出码 $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
}
$ExeMissing = -not (Test-Path $Exe)
if ($ExeMissing) {
  $hint = "missing $Exe`nBuild it first: cargo build --release --target-dir target (in apps\runner)`n(or re-run without -SkipBuild)"
  if ($DryRun) {
        Write-Host "[MISSING] $Exe（dry-run；请先构建）"
  } else {
    throw $hint
  }
}

# -------------------------------------------------- 固定 rev / Cargo.lock
# 发布必须基于固定的 oas-core 提交构建。校验 Cargo.lock
# 确实固定了 Cargo.toml 中的 rev（过期 lock 会静默带入
# 较旧的引擎）。
$CargoTomlPath = Join-Path $AppDir "Cargo.toml"
$CargoToml = Get-Content -Raw -Encoding UTF8 $CargoTomlPath
$revMatch = [regex]::Match($CargoToml, 'rev\s*=\s*"([0-9a-fA-F]{40})"')
if (-not $revMatch.Success) {
    throw "apps\runner\Cargo.toml 未固定 40 位十六进制 oas-core rev"
}
$OasdRev = $revMatch.Groups[1].Value.ToLower()
$LockPath = Join-Path $AppDir "Cargo.lock"
if (-not (Test-Path $LockPath)) {
    throw "缺少 apps\runner\Cargo.lock（先构建一次并提交 lock）"
}
$LockText = Get-Content -Raw -Encoding UTF8 $LockPath
if (-not $LockText.ToLower().Contains($OasdRev)) {
    throw "apps\runner\Cargo.lock 未固定 oas-core rev $OasdRev；请重新构建并提交 Cargo.lock"
}

# ------------------------------------------------------------------ 数据
$DataRoot = $null
if (-not [string]::IsNullOrWhiteSpace($DataFrom)) {
  $DataRoot = $DataFrom
  if (-not [System.IO.Path]::IsPathRooted($DataRoot)) { $DataRoot = Join-Path $Root $DataRoot }
} else {
  $autoData = Join-Path $RepoParent "oas-core"
  if (Test-Path $autoData) { $DataRoot = $autoData }
}
$DataOk = $false
if ($null -ne $DataRoot) {
  $DataOk = (Test-Path (Join-Path $DataRoot "tasks")) -and (Test-Path (Join-Path $DataRoot "assets\assets.json"))
}
if (-not $NoData -and -not $DataOk) {
  $tried = if ($null -eq $DataRoot) { "(none: use -DataFrom <oas-core dir>)" } else { $DataRoot }
    throw ("找不到 oas-core 数据快照（`tasks\` + `assets\assets.json`）。`n" +
        "尝试过：$tried`n" +
        "请传 -DataFrom <oas-core 目录>，或用 -NoData 生成不含 bundled-data\ 的包。")
}

# --------------------------------------------------------------- toolkit
$Toolkit = Resolve-Toolkit -Hint $ToolkitFrom
if ($null -eq $Toolkit -and -not $SkipToolkit) {
  $tried = @()
  if (-not [string]::IsNullOrWhiteSpace($ToolkitFrom)) { $tried += $ToolkitFrom }
  $tried += (Join-Path $RepoParent "oas-core\backend\toolkit")
  $tried += "D:\OAS-dev\backend\toolkit"
    throw ("找不到 OCR 模型 + Windows adb toolkit。`n" +
        "尝试过：" + ($tried -join "; ") + "`n" +
        "请传 -ToolkitFrom <目录>（须含 models\ + adb\，或 Python toolkit 布局），" +
        "或用 -SkipToolkit 生成不含 models/adb 的精简包。")
}
if ($null -eq $Toolkit -and $SkipToolkit) {
    Write-Host "-- toolkit：已跳过（-SkipToolkit；包内不含 models\ 或 adb\）" -ForegroundColor Yellow
}
if ($null -ne $Toolkit) { Write-Host "-- toolkit：$($Toolkit.Root)" }

# --------------------------------------------------------------- 计划
$CopyPlan = @()
function Add-CopyItem {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Dest,
    [Parameter(Mandatory = $true)][string]$Kind,
    [switch]$Required
  )
  $script:CopyPlan += [pscustomobject]@{
    Source = $Source; Dest = $Dest; Kind = $Kind; Required = [bool]$Required
  }
}

Add-CopyItem -Source $Exe -Dest "oasd-runner.exe" -Kind "binary" -Required
foreach ($f in $RunnerUiFiles) {
  Add-CopyItem -Source (Join-Path $UiDir $f) -Dest (Join-Path "ui" $f) -Kind "runner-ui" -Required
}
if ($null -ne $Toolkit) {
  foreach ($m in $ModelFiles) {
    Add-CopyItem -Source (Join-Path $Toolkit.Models $m) -Dest (Join-Path "models" $m) -Kind "ocr-model" -Required
  }
  Add-CopyItem -Source (Join-Path $Toolkit.Adb "adb.exe") -Dest "adb\adb.exe" -Kind "adb" -Required
  foreach ($f in @("AdbWinApi.dll", "AdbWinUsbApi.dll")) {
    $src = Join-Path $Toolkit.Adb $f
    if (Test-Path $src) { Add-CopyItem -Source $src -Dest (Join-Path "adb" $f) -Kind "adb" -Required:$false }
  }
}
Add-CopyItem -Source (Join-Path $PackagingDir "live.example.json") -Dest "config\live.example.json" -Kind "config" -Required
Add-CopyItem -Source (Join-Path $PackagingDir "start-runner.bat") -Dest "start-runner.bat" -Kind "launcher" -Required
Add-CopyItem -Source (Join-Path $PackagingDir "stop-runner.bat") -Dest "stop-runner.bat" -Kind "launcher" -Required
Add-CopyItem -Source (Join-Path $PackagingDir "README-RUNNER.txt") -Dest "README-RUNNER.txt" -Kind "readme" -Required

$MissingRequired = @()
foreach ($item in $CopyPlan) {
  if ($item.Required -and -not (Test-Path $item.Source)) { $MissingRequired += $item.Source }
}
if ($MissingRequired.Count -gt 0) {
    Write-Host "!! 缺少必需的包源：" -ForegroundColor Yellow
  foreach ($m in ($MissingRequired | Select-Object -Unique)) { Write-Host "   - $m" }
  if (-not $DryRun) {
        throw "Runner 包不完整：缺少 $($MissingRequired.Count) 个必需源。"
  }
}

# UI/扁平文件空文件检查（runner.html/js/css/style.css 必须非空）
foreach ($f in $RunnerUiFiles) {
  $p = Join-Path $UiDir $f
    if ((Test-Path $p) -and ((Get-Item $p).Length -le 0)) { throw "ui\$f 为空" }
}

# ------------------------------------------------------------- 配置检查
$ConfigJson = Join-Path $PackagingDir "live.example.json"
if (Test-Path $ConfigJson) {
  try {
    $cfg = Get-Content -Raw -Encoding UTF8 $ConfigJson | ConvertFrom-Json
  } catch {
        throw "packaging\live.example.json JSON 无效：$($_.Exception.Message)"
  }
    if ($null -eq $cfg.runner) { throw "packaging\live.example.json 缺少 `runner` 段" }
    if ([int]$cfg.runner.port -ne 8789) { throw "packaging\live.example.json 的 runner.port 必须为 8789" }
} elseif (-not $DryRun) {
    throw "缺少 packaging\live.example.json"
}

# 计划/BUILD-INFO 用的数据摘要
$DataSummary = "bundled=no"
if (-not $NoData) {
  $DataSummary = "bundled=yes source=$DataRoot"
}

# --------------------------------------------------------------- dry-run
if ($DryRun) {
  Write-Host ""
    Write-Host "Runner 打包计划（stage：dist\stage-runner）："
  foreach ($item in $CopyPlan) {
    $state = "OK"
    if (-not (Test-Path $item.Source)) { $state = "MISSING" }
    Write-Host ("  [{0,-7}] {1,-34} <- {2}" -f $state, $item.Dest, $item.Source)
  }
    Write-Host "  [GENERATE] config\live.json          <- live.example.json 的副本"
    Write-Host "  [GENERATE] scheduler.json            <- 空 schema v4 计划（无 BOM）"
    Write-Host "  [GENERATE] tasks\README.txt + packages/runs/logs/assets .keep（无 frames/relations/templates：Runner 不得携带帧）"
  Write-Host "  [GENERATE] VERSION, BUILD-INFO.txt"
  if ($NoData) {
        Write-Host "  [DATA]     bundled-data\              <- 已跳过（-NoData）"
  } else {
    Write-Host "  [DATA]     bundled-data\{manifest.json,tasks\**,assets\**} <- $DataRoot"
        Write-Host "  [GENERATE] 首次启动导入到全新数据根（绝不覆盖用户数据）"
  }
  if ($null -eq $Toolkit) {
        Write-Host "  [TOOLKIT]  models\ + adb\             <- 已跳过（-SkipToolkit）"
  } else {
    Write-Host "  [TOOLKIT]  models\ + adb\             <- $($Toolkit.Root)"
  }
  Write-Host ""
  Write-Host "oasd_rev: $OasdRev"
    Write-Host "输出：$Zip"
    Write-Host "SHA256：$ShaFile"
    Write-Host "BUILD-INFO：$BuildInfoOut"
  if ($MissingRequired.Count -gt 0) {
        Write-Host "[DRY-RUN] 不完整：缺少 $($MissingRequired.Count) 个必需源。"
    exit 1
  }
    Write-Host "[DRY-RUN] OK：计划完整；未写入任何内容。"
  exit 0
}

# ------------------------------------------------------------------- stage
Write-Host "-- 正在生成 stage：$Stage"
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
foreach ($d in @("ui", "config", "packages", "tasks", "assets", "runs", "logs")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Stage $d) | Out-Null
}
if ($null -ne $Toolkit) {
  foreach ($d in @("models", "adb")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Stage $d) | Out-Null
  }
}

foreach ($item in $CopyPlan) {
  if (-not (Test-Path $item.Source)) {
        if ($item.Required) { throw "缺少 $($item.Source)" }
        Write-Host "-- 跳过缺失的可选项 $($item.Source)"
    continue
  }
  $dest = Join-Path $Stage $item.Dest
  $parent = Split-Path -Parent $dest
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item $item.Source $dest -Force
}

# 配置：随包提供示例与可直接编辑的 live.json
Copy-Item (Join-Path $Stage "config\live.example.json") (Join-Path $Stage "config\live.json") -Force

# 空调度计划（schema v4，当前写格式）。无 BOM。
@'
{
  "schema_version": 4,
  "config": {
    "mode": "stop",
    "calendar": { "day_reset": "05:00", "week_reset": { "weekday": 0, "time": "05:00" } },
    "guards": { "active_hours": [], "blackouts": [] }
  },
  "queues": [],
  "entries": []
}
'@ | Write-Utf8NoBom -Path (Join-Path $Stage "scheduler.json")

# 数据占位文件（zip 仅在目录含文件时保留空目录）
"# OAS Runner tasks`r`n`r`nInstall task packages (.oaspkg) from the Runner UI; each package`r`ncreates one task directory here. On first start the bundled-data\ snapshot is`r`nimported when this directory has no task yet." |
  Write-Utf8NoBom -Path (Join-Path $Stage "tasks\README.txt")
foreach ($k in @("packages\.keep", "runs\.keep", "logs\.keep", "assets\.keep")) {
  "" | Set-Content -Encoding ASCII (Join-Path $Stage $k)
}

# ---------------------------------------------------- bundled-data（P0-2/P0-3）
# oas-core tasks/ + assets/ 的只读快照；Runner 首次启动时
# 导入到全新数据根（见 oas-core apps/oasd/src/bundled_data.rs
# 与设计 RUNNER-SPLIT-DESIGN.md 6.3/6.5）。运行态状态永不随包。
if (-not $NoData) {
  $RootTasks = Join-Path $DataRoot "tasks"
  $RootAssets = Join-Path $DataRoot "assets"
  $BundleStage = Join-Path $Stage "bundled-data"
  New-Item -ItemType Directory -Force -Path (Join-Path $BundleStage "tasks") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $BundleStage "assets\images") | Out-Null

  Get-ChildItem $RootTasks -Directory -Force | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $BundleStage "tasks") -Recurse -Force
  }
    # 哈希前剥离运行态产物：state/、.backup/、*.bak、*.tmp、点击日志。
  Get-ChildItem $BundleStage -Recurse -Force -Directory -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq "state" -or $_.Name -eq ".backup"
  } | Remove-Item -Recurse -Force
  Get-ChildItem $BundleStage -Recurse -File -Force | Where-Object {
    $_.Name -like "*.bak" -or $_.Name -like "*.tmp" -or $_.Name -like "*.clicks.jsonl"
  } | Remove-Item -Force

  Copy-Item (Join-Path $RootAssets "assets.json") (Join-Path $BundleStage "assets\assets.json") -Force
  if (Test-Path (Join-Path $RootAssets "images")) {
    Copy-Item (Join-Path $RootAssets "images\*") (Join-Path $BundleStage "assets\images") -Recurse -Force -ErrorAction SilentlyContinue
  }

  $BundleFiles = @(Get-ChildItem $BundleStage -Recurse -File -Force | Where-Object { $_.Name -ne "manifest.json" })
  $BundleEntries = @()
  $BundleBytes = [int64]0
  foreach ($f in $BundleFiles) {
    $rel = $f.FullName.Substring($BundleStage.Length + 1).Replace('\', '/')
    $BundleEntries += [pscustomobject]@{
      path = $rel
      sha256 = (Get-Sha256Hex $f.FullName)
      bytes = [int64]$f.Length
    }
    $BundleBytes += $f.Length
  }
  $BundleTasks = @(Get-ChildItem (Join-Path $BundleStage "tasks") -Directory -Force |
    Select-Object -ExpandProperty Name)
  $BundleImageCount = @(Get-ChildItem (Join-Path $BundleStage "assets\images") -File -Force -ErrorAction SilentlyContinue).Count
  $AssetsSha = (Get-Sha256Hex (Join-Path $BundleStage "assets\assets.json"))
  $DataCommit = Get-GitShort -Dir $DataRoot
  $DataRepo = Get-GitRemote -Dir $DataRoot
  $DataVersion = $Version
  $DataCargo = Join-Path $DataRoot "Cargo.toml"
  if (Test-Path $DataCargo) {
    $m = [regex]::Match((Get-Content -Raw -Encoding UTF8 $DataCargo), 'version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"')
    if ($m.Success) { $DataVersion = $m.Groups[1].Value }
  }

  $Manifest = [ordered]@{
    schema_version = 1
    generated_at_ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    source = [ordered]@{
      repo = $DataRepo
      commit = $DataCommit
      version = $DataVersion
    }
    tasks = $BundleTasks
    assets = [ordered]@{
      assets_json_sha256 = $AssetsSha
      image_count = $BundleImageCount
    }
    files = $BundleEntries
    total_bytes = [int64]$BundleBytes
  }
  ($Manifest | ConvertTo-Json -Depth 6) | Write-Utf8NoBom -Path (Join-Path $BundleStage "manifest.json")
  $DataSummary = "bundled=yes tasks=$($BundleTasks.Count) assets=$BundleImageCount files=$($BundleEntries.Count) bytes=$BundleBytes source=$DataCommit"
    Write-Host "-- bundled-data：$DataSummary"
} else {
  $DataSummary = "bundled=no (-NoData)"
}

$ToolkitSummary = "skipped (-SkipToolkit)"
if ($null -ne $Toolkit) {
  $ToolkitSummary = "root=$($Toolkit.Root)"
}

# 版本 / 构建信息
"$Version" | Write-Utf8NoBom -Path (Join-Path $Stage "VERSION")
$RepoSubject = Get-GitSubject -Dir $Root
$buildLines = @(
  "OAS Runner v$Version",
  "git: $RepoSubject",
  "built_at: $(Get-Date -Format o)",
  "build: cargo build --release --target-dir target (in apps/runner)",
  "surface: runner",
  "runner_app: oasd-runner",
  "oasd_rev: $OasdRev",
  "oasd_repo: https://github.com/passioki/oas-core",
  "ui: runner.html runner.js runner.css style.css (default --ui ui injected by oasd-runner)",
  "data: $DataSummary",
  "toolkit: $ToolkitSummary",
  "models: PP-OCRv6_rec_small.onnx, PP-OCRv6_det_small.onnx",
  "adb: bundled Windows adb (adb/adb.exe)"
)
$buildLines | Write-Utf8NoBom -Path (Join-Path $Stage "BUILD-INFO.txt")

# ------------------------------------------------------------- stage 审计
# 1）不得包含 Studio 专属创作 UI。
$forbidden = @(Get-ChildItem $Stage -Recurse -File -Force | Where-Object {
    $ForbiddenUiNames -contains $_.Name
  })
if ($forbidden.Count -gt 0) {
    throw ("Runner stage 包含 Studio 专属 UI 文件：" +
    (($forbidden | ForEach-Object { $_.FullName }) -join "; "))
}

# 2）ui\ 只能包含四个 Runner UI 文件。
$uiFiles = @(Get-ChildItem (Join-Path $Stage "ui") -File -Force |
  Select-Object -ExpandProperty Name)
$uiUnexpected = @($uiFiles | Where-Object { $RunnerUiFiles -notcontains $_ })
if ($uiUnexpected.Count -gt 0) {
    throw "Runner stage ui\ 包含意外文件：$($uiUnexpected -join ', ')"
}
foreach ($f in $RunnerUiFiles) {
    if ($uiFiles -notcontains $f) { throw "Runner stage ui\$f 缺失" }
}

# 3）必需文件存在。
$requiredStage = @(
  "oasd-runner.exe",
  "ui\runner.html", "ui\runner.js", "ui\runner.css", "ui\style.css",
  "config\live.example.json", "config\live.json",
  "start-runner.bat", "stop-runner.bat", "README-RUNNER.txt",
  "scheduler.json", "tasks\README.txt", "packages\.keep", "runs\.keep",
  "logs\.keep", "assets\.keep",
  "VERSION", "BUILD-INFO.txt"
)
if ($null -ne $Toolkit) {
  $requiredStage += @("models\PP-OCRv6_rec_small.onnx", "models\PP-OCRv6_det_small.onnx", "adb\adb.exe")
}
if (-not $NoData) {
  $requiredStage += @("bundled-data\manifest.json", "bundled-data\tasks", "bundled-data\assets\assets.json")
}
foreach ($rel in $requiredStage) {
    if (-not (Test-Path (Join-Path $Stage $rel))) { throw "stage 缺少 $rel" }
}

# 4）关键文件不得为 0 字节（空占位仅允许 .keep 文件/README）。
$nonEmpty = @(
  "oasd-runner.exe", "README-RUNNER.txt", "VERSION", "BUILD-INFO.txt",
  "start-runner.bat", "stop-runner.bat", "scheduler.json",
  "ui\runner.html", "ui\runner.js", "ui\runner.css", "ui\style.css",
  "config\live.example.json", "config\live.json"
)
if ($null -ne $Toolkit) {
  $nonEmpty += @("models\PP-OCRv6_rec_small.onnx", "models\PP-OCRv6_det_small.onnx", "adb\adb.exe")
}
if (-not $NoData) { $nonEmpty += "bundled-data\manifest.json" }
foreach ($rel in $nonEmpty) {
  $p = Join-Path $Stage $rel
    if ((Get-Item $p).Length -le 0) { throw "stage 文件为空：$rel" }
}

# 5）所有 JSON 文件必须无 BOM（serde_json 拒绝 BOM）。
$jsonFiles = @("config\live.example.json", "config\live.json", "scheduler.json")
if (-not $NoData) { $jsonFiles += "bundled-data\manifest.json" }
foreach ($rel in $jsonFiles) {
  $p = Join-Path $Stage $rel
    if (Test-HasUtf8Bom -Path $p) { throw "stage JSON 文件含 UTF-8 BOM：$rel" }
  $first = [System.IO.File]::ReadAllBytes($p)
  if ($first.Length -lt 1 -or ($first[0] -ne 0x7B -and $first[0] -ne 0x5B)) {
        throw "stage JSON 文件不以 '{' 或 '[' 开头：$rel"
  }
}

# 6）bundled-data 必须与其 manifest 完全一致。
if (-not $NoData) {
  $BundleStage = Join-Path $Stage "bundled-data"
  $ManifestPath = Join-Path $BundleStage "manifest.json"
  $manifest = Get-Content -Raw -Encoding UTF8 $ManifestPath | ConvertFrom-Json
    if ([int]$manifest.schema_version -ne 1) { throw "bundled-data manifest 的 schema_version 必须为 1" }
  $listed = @($manifest.files)
    if ($listed.Count -lt 1) { throw "bundled-data manifest 没有文件" }
  foreach ($entry in $listed) {
    $rel = ([string]$entry.path).Replace('/', '\')
    $p = Join-Path $BundleStage $rel
        if (-not (Test-Path $p)) { throw "bundled-data manifest 列出的文件缺失：$($entry.path)" }
    if ((Get-Sha256Hex $p) -ne [string]$entry.sha256) {
            throw "bundled-data sha256 不匹配：$($entry.path)"
    }
  }
  $actual = @(Get-ChildItem $BundleStage -Recurse -File -Force | Where-Object { $_.Name -ne "manifest.json" })
  if ($actual.Count -ne $listed.Count) {
        throw "bundled-data 有 $($actual.Count) 个文件，但 manifest 列出 $($listed.Count) 个"
  }
  $stateDirs = @(Get-ChildItem $BundleStage -Recurse -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "state" -or $_.Name -eq ".backup" })
    if ($stateDirs.Count -gt 0) { throw "bundled-data 不得包含运行态 state/ 或 .backup/ 目录" }
    if (@($manifest.tasks).Count -lt 1) { throw "bundled-data manifest 没有 tasks" }
}

Write-Host "-- stage 审计通过（仅 Runner UI；JSON 无 BOM；bundled-data 已校验；oasd_rev $OasdRev）"

# --------------------------------------------------------------------- zip
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$zipParent = Split-Path -Parent $Zip
if (-not (Test-Path $zipParent)) { New-Item -ItemType Directory -Force -Path $zipParent | Out-Null }
if (Test-Path $Zip) { Remove-Item $Zip -Force }
if (Test-Path $ShaFile) { Remove-Item $ShaFile -Force }
Write-Host "-- 压缩 $ZipName"
# 手写 zip 而不用 Compress-Archive：Windows PowerShell 5.1 下
# Compress-Archive 会用 `\` 写条目名，非 Windows 解压工具可能
# 将其解为字面反斜杠文件名。保持 `/` 条目分隔符。
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipStream = [System.IO.File]::Open($Zip, [System.IO.FileMode]::Create)
try {
  $archive = [System.IO.Compression.ZipArchive]::new(
    $zipStream,
    [System.IO.Compression.ZipArchiveMode]::Create
  )
  try {
    foreach ($f in (Get-ChildItem $Stage -Recurse -File -Force)) {
      $rel = $f.FullName.Substring($Stage.Length + 1).Replace('\', '/')
      $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = [System.DateTimeOffset]$f.LastWriteTime
      $in = [System.IO.File]::OpenRead($f.FullName)
      try {
        $out = $entry.Open()
        try { $in.CopyTo($out) } finally { $out.Dispose() }
      } finally {
        $in.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  $zipStream.Dispose()
}

$hash = (Get-FileHash $Zip -Algorithm SHA256).Hash
"$hash  $ZipName" | Set-Content -Encoding ASCII $ShaFile
Copy-Item (Join-Path $Stage "BUILD-INFO.txt") $BuildInfoOut -Force

$entryCount = @(Get-ChildItem $Stage -Recurse -File -Force).Count
$sizeBytes = (Get-Item $Zip).Length
$sizeMb = [math]::Round($sizeBytes / 1MB, 1)
Write-Host ""
Write-Host "OK：$Zip（$sizeMb MB，$entryCount 个条目）"
Write-Host "SHA256：$hash"
Write-Host "BUILD-INFO：$BuildInfoOut"
Write-Host "内容："
Get-ChildItem $Stage -Recurse -File -Force |
  ForEach-Object { "  " + $_.FullName.Substring($Stage.Length + 1) }
