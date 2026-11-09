# oas-runner release packaging (Windows)
#
# This repository builds the Runner from its OWN thin app (`apps/runner`,
# oas-core pinned by commit rev in `apps/runner/Cargo.toml`). The zip produced
# here is the END-USER package: the Runner surface (HTTP UI on 8789, task
# package install, queue/schedule/execute), the Runner UI, OCR models, the
# bundled Windows adb and a read-only `bundled-data/` snapshot of the oas-core
# tasks/assets that the Runner imports on first start. It contains no Studio
# authoring UI and no Studio binary.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-runner.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-runner.ps1 `
#       -DataFrom D:\OAS-dev\oas-core -ToolkitFrom D:\OAS-dev\backend\toolkit
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-runner.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-runner.ps1 -SkipBuild -Offline
#
# Output (defaults):
#   dist\oasd-runner-v<version>-win64.zip
#   dist\oasd-runner-v<version>-win64.zip.sha256
#   dist\BUILD-INFO.txt                       (copy of the packaged BUILD-INFO.txt)
#
# Design notes:
#   * This script is ASCII-only on purpose: Windows PowerShell 5.1 reads a
#     UTF-8 script *without* BOM as ANSI, so non-ASCII literals here would be
#     mojibake. Every generated text file is written BOM-free UTF-8, because the
#     engine's serde_json rejects a leading UTF-8 BOM ("expected value at line 1
#     column 1").
#   * The zip is written with System.IO.Compression.ZipArchive so entry names
#     always use `/` separators (PS 5.1 Compress-Archive writes `\`).
#   * The build is ON by default here (this repo owns its binary): cargo build
#     --release --target-dir <repo>\target in apps/runner. Pass -SkipBuild when
#     the exe already exists.
param(
  [string]$Version = "0.1.0",
  # oas-core checkout whose tasks/ + assets/ become bundled-data/ (default:
  # auto-detect ..\oas-core next to this repository).
  [string]$DataFrom = "",
  # -NoData: build a program-only package (no bundled-data/). Without it a
  # missing data source is an error instead of a silently empty "bundled" pack.
  [switch]$NoData,
  # Toolkit root that contains the OCR models and the Windows adb binaries
  # (default: auto-detect ..\oas-core\backend\toolkit or D:\OAS-dev\backend\toolkit;
  # both the flat <root>\models + <root>\adb layout and the Python toolkit
  # layout <root>\Lib\site-packages\rapidocr\models + adbutils\binaries work).
  [string]$ToolkitFrom = "",
  # -SkipToolkit: allow a package without models/adb (debug/slim builds only).
  [switch]$SkipToolkit,
  # -OutFile: zip path (relative to the repo root when not absolute).
  [string]$OutFile = "",
  [switch]$SkipBuild,
  # -Offline: pass --offline to cargo (all deps already fetched/cached).
  [switch]$Offline,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$RepoParent = Split-Path -Parent $Root

# --------------------------------------------------------------- helpers
# BOM-free UTF-8 writer for every text/JSON file this script generates.
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

# Resolve a toolkit root to its (models dir, adb dir) pair, or $null.
# Supports both the flat release layout (<root>\models + <root>\adb) and the
# Python toolkit layout used on the dev machine.
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

# ----------------------------------------------------------------- params
if ([string]::IsNullOrWhiteSpace($Version) -or $Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]*$') {
  throw "bad -Version value '$Version' (use e.g. 1.2.3)"
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
# Studio-only authoring UI must never leak into the Runner package.
$ForbiddenUiNames = @(
  "index.html", "app.js", "builder.js", "flow_model.js", "asset_ui.js",
  "flow_model_test.html", "dashboard.html", "dashboard.js", "ui_pure_test.js"
)

Write-Host "== OAS Runner package v$Version (oas-runner standalone) =="

# ------------------------------------------------------------------- build
if ($DryRun) {
  Write-Host "-- [DRY-RUN] build skipped (run without -DryRun to actually package)"
} elseif (-not $SkipBuild) {
  Write-Host "-- cargo build --release --target-dir $TargetDir (in apps\runner)"
  Push-Location $AppDir
  try {
    $cargoArgs = @("build", "--release", "--target-dir", $TargetDir)
    if ($Offline) { $cargoArgs += "--offline" }
    & cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}
$ExeMissing = -not (Test-Path $Exe)
if ($ExeMissing) {
  $hint = "missing $Exe`nBuild it first: cargo build --release --target-dir target (in apps\runner)`n(or re-run without -SkipBuild)"
  if ($DryRun) {
    Write-Host "[MISSING] $Exe (dry-run; build first)"
  } else {
    throw $hint
  }
}

# -------------------------------------------------- pinned rev / Cargo.lock
# The release must be built from the pinned oas-core commit. Verify Cargo.lock
# actually pins the rev from Cargo.toml (a stale lock would silently ship an
# older engine).
$CargoTomlPath = Join-Path $AppDir "Cargo.toml"
$CargoToml = Get-Content -Raw -Encoding UTF8 $CargoTomlPath
$revMatch = [regex]::Match($CargoToml, 'rev\s*=\s*"([0-9a-fA-F]{40})"')
if (-not $revMatch.Success) {
  throw "apps\runner\Cargo.toml does not pin a 40-hex oas-core rev"
}
$OasdRev = $revMatch.Groups[1].Value.ToLower()
$LockPath = Join-Path $AppDir "Cargo.lock"
if (-not (Test-Path $LockPath)) {
  throw "missing apps\runner\Cargo.lock (build once, then commit the lock)"
}
$LockText = Get-Content -Raw -Encoding UTF8 $LockPath
if (-not $LockText.ToLower().Contains($OasdRev)) {
  throw "apps\runner\Cargo.lock does not pin the oas-core rev $OasdRev; rebuild and commit Cargo.lock"
}

# ------------------------------------------------------------------ data
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
  throw ("cannot find an oas-core data snapshot (`tasks\` + `assets\assets.json`).`n" +
    "Tried: $tried`n" +
    "Pass -DataFrom <oas-core dir>, or -NoData to build a package without bundled-data\.")
}

# --------------------------------------------------------------- toolkit
$Toolkit = Resolve-Toolkit -Hint $ToolkitFrom
if ($null -eq $Toolkit -and -not $SkipToolkit) {
  $tried = @()
  if (-not [string]::IsNullOrWhiteSpace($ToolkitFrom)) { $tried += $ToolkitFrom }
  $tried += (Join-Path $RepoParent "oas-core\backend\toolkit")
  $tried += "D:\OAS-dev\backend\toolkit"
  throw ("cannot find the OCR models + Windows adb toolkit.`n" +
    "Tried: " + ($tried -join "; ") + "`n" +
    "Pass -ToolkitFrom <dir> (must contain models\ + adb\, or the Python toolkit layout), " +
    "or -SkipToolkit to build a slimmer package without models/adb.")
}
if ($null -eq $Toolkit -and $SkipToolkit) {
  Write-Host "-- toolkit: SKIPPED (-SkipToolkit; package will not contain models\ or adb\)" -ForegroundColor Yellow
}
if ($null -ne $Toolkit) { Write-Host "-- toolkit: $($Toolkit.Root)" }

# --------------------------------------------------------------- plan
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
  Write-Host "!! missing required package sources:" -ForegroundColor Yellow
  foreach ($m in ($MissingRequired | Select-Object -Unique)) { Write-Host "   - $m" }
  if (-not $DryRun) {
    throw "Runner package is incomplete: missing $($MissingRequired.Count) required source(s)."
  }
}

# empty UI/flat file checks (runner.html/js/css/style.css must be non-empty)
foreach ($f in $RunnerUiFiles) {
  $p = Join-Path $UiDir $f
  if ((Test-Path $p) -and ((Get-Item $p).Length -le 0)) { throw "ui\$f is empty" }
}

# ------------------------------------------------------------- config check
$ConfigJson = Join-Path $PackagingDir "live.example.json"
if (Test-Path $ConfigJson) {
  try {
    $cfg = Get-Content -Raw -Encoding UTF8 $ConfigJson | ConvertFrom-Json
  } catch {
    throw "invalid JSON in packaging\live.example.json: $($_.Exception.Message)"
  }
  if ($null -eq $cfg.runner) { throw "packaging\live.example.json is missing the `runner` section" }
  if ([int]$cfg.runner.port -ne 8789) { throw "packaging\live.example.json runner.port must be 8789" }
} elseif (-not $DryRun) {
  throw "missing packaging\live.example.json"
}

# data summary for plan/BUILD-INFO
$DataSummary = "bundled=no"
if (-not $NoData) {
  $DataSummary = "bundled=yes source=$DataRoot"
}

# --------------------------------------------------------------- dry run
if ($DryRun) {
  Write-Host ""
  Write-Host "Runner package plan (stage: dist\stage-runner):"
  foreach ($item in $CopyPlan) {
    $state = "OK"
    if (-not (Test-Path $item.Source)) { $state = "MISSING" }
    Write-Host ("  [{0,-7}] {1,-34} <- {2}" -f $state, $item.Dest, $item.Source)
  }
  Write-Host "  [GENERATE] config\live.json          <- copy of live.example.json"
  Write-Host "  [GENERATE] scheduler.json            <- empty schema v4 plan (BOM-free)"
  Write-Host "  [GENERATE] tasks\README.txt + packages/runs/logs/assets .keep (no frames/relations/templates: Runner must not ship frames)"
  Write-Host "  [GENERATE] VERSION, BUILD-INFO.txt"
  if ($NoData) {
    Write-Host "  [DATA]     bundled-data\              <- SKIPPED (-NoData)"
  } else {
    Write-Host "  [DATA]     bundled-data\{manifest.json,tasks\**,assets\**} <- $DataRoot"
    Write-Host "  [GENERATE] first-run import into a fresh data root (never overwrites user data)"
  }
  if ($null -eq $Toolkit) {
    Write-Host "  [TOOLKIT]  models\ + adb\             <- SKIPPED (-SkipToolkit)"
  } else {
    Write-Host "  [TOOLKIT]  models\ + adb\             <- $($Toolkit.Root)"
  }
  Write-Host ""
  Write-Host "oasd_rev: $OasdRev"
  Write-Host "Output: $Zip"
  Write-Host "SHA256: $ShaFile"
  Write-Host "BUILD-INFO: $BuildInfoOut"
  if ($MissingRequired.Count -gt 0) {
    Write-Host "[DRY-RUN] incomplete: $($MissingRequired.Count) required source(s) missing."
    exit 1
  }
  Write-Host "[DRY-RUN] OK: plan is complete; nothing was written."
  exit 0
}

# ------------------------------------------------------------------- stage
Write-Host "-- staging $Stage"
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
    if ($item.Required) { throw "missing $($item.Source)" }
    Write-Host "-- skip optional missing $($item.Source)"
    continue
  }
  $dest = Join-Path $Stage $item.Dest
  $parent = Split-Path -Parent $dest
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item $item.Source $dest -Force
}

# config: ship the example and a ready-to-edit live.json
Copy-Item (Join-Path $Stage "config\live.example.json") (Join-Path $Stage "config\live.json") -Force

# Empty scheduler plan (schema v4, the current write format). BOM-free.
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

# data placeholders (zip keeps empty dirs only if they contain a file)
"# OAS Runner tasks`r`n`r`nInstall task packages (.oaspkg) from the Runner UI; each package`r`ncreates one task directory here. On first start the bundled-data\ snapshot is`r`nimported when this directory has no task yet." |
  Write-Utf8NoBom -Path (Join-Path $Stage "tasks\README.txt")
foreach ($k in @("packages\.keep", "runs\.keep", "logs\.keep", "assets\.keep")) {
  "" | Set-Content -Encoding ASCII (Join-Path $Stage $k)
}

# ---------------------------------------------------- bundled-data (P0-2/P0-3)
# Read-only snapshot of the oas-core tasks/ + assets/ that the Runner imports on
# first start into a fresh data root (see oas-core apps/oasd/src/bundled_data.rs
# and design RUNNER-SPLIT-DESIGN.md 6.3/6.5). Runtime state is never shipped.
if (-not $NoData) {
  $RootTasks = Join-Path $DataRoot "tasks"
  $RootAssets = Join-Path $DataRoot "assets"
  $BundleStage = Join-Path $Stage "bundled-data"
  New-Item -ItemType Directory -Force -Path (Join-Path $BundleStage "tasks") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $BundleStage "assets\images") | Out-Null

  Get-ChildItem $RootTasks -Directory -Force | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $BundleStage "tasks") -Recurse -Force
  }
  # Strip runtime artefacts before hashing: state/, .backup/, *.bak, *.tmp, click logs.
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
  Write-Host "-- bundled-data: $DataSummary"
} else {
  $DataSummary = "bundled=no (-NoData)"
}

$ToolkitSummary = "skipped (-SkipToolkit)"
if ($null -ne $Toolkit) {
  $ToolkitSummary = "root=$($Toolkit.Root)"
}

# version / build info
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

# ------------------------------------------------------------- stage audit
# 1) Studio-only authoring UI must be absent.
$forbidden = @(Get-ChildItem $Stage -Recurse -File -Force | Where-Object {
    $ForbiddenUiNames -contains $_.Name
  })
if ($forbidden.Count -gt 0) {
  throw ("Runner stage contains Studio-only UI file(s): " +
    (($forbidden | ForEach-Object { $_.FullName }) -join "; "))
}

# 2) ui\ holds exactly the four Runner UI files.
$uiFiles = @(Get-ChildItem (Join-Path $Stage "ui") -File -Force |
  Select-Object -ExpandProperty Name)
$uiUnexpected = @($uiFiles | Where-Object { $RunnerUiFiles -notcontains $_ })
if ($uiUnexpected.Count -gt 0) {
  throw "Runner stage ui\ contains unexpected file(s): $($uiUnexpected -join ', ')"
}
foreach ($f in $RunnerUiFiles) {
  if ($uiFiles -notcontains $f) { throw "Runner stage ui\$f is missing" }
}

# 3) required files present.
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
  if (-not (Test-Path (Join-Path $Stage $rel))) { throw "stage is missing $rel" }
}

# 4) no 0-byte key files (empty placeholders are .keep files / README only).
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
  if ((Get-Item $p).Length -le 0) { throw "stage file is empty: $rel" }
}

# 5) every JSON file must be BOM-free (serde_json rejects a BOM).
$jsonFiles = @("config\live.example.json", "config\live.json", "scheduler.json")
if (-not $NoData) { $jsonFiles += "bundled-data\manifest.json" }
foreach ($rel in $jsonFiles) {
  $p = Join-Path $Stage $rel
  if (Test-HasUtf8Bom -Path $p) { throw "stage JSON file has a UTF-8 BOM: $rel" }
  $first = [System.IO.File]::ReadAllBytes($p)
  if ($first.Length -lt 1 -or ($first[0] -ne 0x7B -and $first[0] -ne 0x5B)) {
    throw "stage JSON file does not start with '{' or '[': $rel"
  }
}

# 6) bundled-data must be exactly the snapshot its manifest lists.
if (-not $NoData) {
  $BundleStage = Join-Path $Stage "bundled-data"
  $ManifestPath = Join-Path $BundleStage "manifest.json"
  $manifest = Get-Content -Raw -Encoding UTF8 $ManifestPath | ConvertFrom-Json
  if ([int]$manifest.schema_version -ne 1) { throw "bundled-data manifest schema_version must be 1" }
  $listed = @($manifest.files)
  if ($listed.Count -lt 1) { throw "bundled-data manifest has no files" }
  foreach ($entry in $listed) {
    $rel = ([string]$entry.path).Replace('/', '\')
    $p = Join-Path $BundleStage $rel
    if (-not (Test-Path $p)) { throw "bundled-data manifest lists a missing file: $($entry.path)" }
    if ((Get-Sha256Hex $p) -ne [string]$entry.sha256) {
      throw "bundled-data sha256 mismatch: $($entry.path)"
    }
  }
  $actual = @(Get-ChildItem $BundleStage -Recurse -File -Force | Where-Object { $_.Name -ne "manifest.json" })
  if ($actual.Count -ne $listed.Count) {
    throw "bundled-data has $($actual.Count) file(s) but manifest lists $($listed.Count)"
  }
  $stateDirs = @(Get-ChildItem $BundleStage -Recurse -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "state" -or $_.Name -eq ".backup" })
  if ($stateDirs.Count -gt 0) { throw "bundled-data must not contain runtime state/ or .backup/ dirs" }
  if (@($manifest.tasks).Count -lt 1) { throw "bundled-data manifest has no tasks" }
}

Write-Host "-- stage audit OK (Runner UI only; JSON BOM-free; bundled-data verified; oasd_rev $OasdRev)"

# --------------------------------------------------------------------- zip
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$zipParent = Split-Path -Parent $Zip
if (-not (Test-Path $zipParent)) { New-Item -ItemType Directory -Force -Path $zipParent | Out-Null }
if (Test-Path $Zip) { Remove-Item $Zip -Force }
if (Test-Path $ShaFile) { Remove-Item $ShaFile -Force }
Write-Host "-- compress $ZipName"
# Write the zip by hand instead of Compress-Archive: on Windows PowerShell 5.1
# Compress-Archive stores entry names with `\`, which non-Windows unzip tools may
# extract as literal backslash filenames. Keep `/` entry separators.
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
Write-Host "OK: $Zip ($sizeMb MB, $entryCount entries)"
Write-Host "SHA256: $hash"
Write-Host "BUILD-INFO: $BuildInfoOut"
Write-Host "Contents:"
Get-ChildItem $Stage -Recurse -File -Force |
  ForEach-Object { "  " + $_.FullName.Substring($Stage.Length + 1) }
