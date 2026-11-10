# oas-runner — OAS 使用端（Runner）独立仓库

> 本仓是 **OAS 使用端（Runner）** 的独立代码/发布仓，与开发端仓库
> [`passioki/oas-core`](https://github.com/passioki/oas-core) 分离。
> 使用端只负责：安装任务包（`.oaspkg`）、填写任务运行参数、排队/调度、
> 执行、查看运行记录；**不含 Studio 编辑端**（任务构建/素材/帧库/发布工具仍在 oas-core）。

## 结构

```
oas-runner/
  apps/runner/           Runner 薄应用（HTTP 8789 + 内嵌调度 + 包安装；引擎来自 oas-core 库）
  ui/                    runner.html / runner.js / runner.css / style.css
  packaging/             README-RUNNER.txt / live.example.json / start-runner.bat / stop-runner.bat
  scripts/               package-runner.ps1（独立打包 Runner-only 发布包）
                         start-runner.ps1 / start-runner.bat（源码树一键启动已打包的 dist\stage-runner）
  docs/                  BUILD.md（构建/打包/运行）· UPDATES.md（更新检测 feeds）
  target/ dist/          构建/打包产物（不入 git）
```

> 引擎 crate 不在本仓复制：`apps/runner/Cargo.toml` 以 **git 依赖 + commit rev**（当前
> `7ce1827…`，oas-core 0.2.0）锁定 oas-core 的 `oasd` 库，`Cargo.lock` 入库。架构理由见
> oas-core `docs/RUNNER-STUDIO-SPLIT-PLAN.md` / `ENGINE-DESIGN.md §22.44~§22.56`。

## 当前状态（Phase 1b ✅）

- **2026-11-05（Phase 1b）**：本仓现在可以**独立产出 Runner-only 发布包**：
  - `apps/runner` 改用 `oasd::cli::run_as_with_args("runner", ["--ui","ui"])`，发布包根目录的
    `ui\` 直接生效（用户显式 `--ui <dir>` 仍可覆盖）；`oasd` rev 升到 `7ce1827…`（0.2.0）、`Cargo.lock` 更新。
  - 新增 `scripts/package-runner.ps1`：`cargo build --release` → 组装 stage（`oasd-runner.exe`、
    Runner UI、models/adb、`bundled-data` 数据快照、config/启停脚本/README/VERSION/BUILD-INFO）→
    审计（JSON 无 BOM、无 Studio UI、bundled-data sha256 校验、Cargo.lock 钉 rev）→ `/` 分隔 zip +
    `.sha256`。参数：`-DataFrom`/`-NoData`/`-ToolkitFrom`/`-SkipToolkit`/`-OutFile`/`-SkipBuild`/`-Offline`/`-DryRun`。
  - `packaging/**` 完整发布布局迁入（README-RUNNER.txt 含安装/升级/数据/更新检测；live.example.json
    含 exchange/updates 段落默认 disabled）；`start-runner.bat`/`stop-runner.bat` 面向 `oasd-runner.exe`。
  - 实测：release 构建 exit 0；解压包 `8795` smoke 通过（`/runner/health` 200、`GET /` Runner UI 200、
    `/app.js` 404、`/task/lint` 404、`bundled-data` 首启导入 tasks/assets）；详见 `docs/BUILD.md §7`。
- **2026-11-05（oas-core seq 114）**：Runner 使用端参数 UI（group/使用开关/留空=不注入）、
  **更新检测 feeds（本地路径/HTTP(S) URL，系统 curl 下载）**；使用方式见 [docs/UPDATES.md](docs/UPDATES.md)。
- **仍在 oas-core**：`oasd` 引擎库、Studio 编辑端与 Studio 发行包、打包/数据/更新检测的引擎实现。
- 构建/打包/运行细节：[docs/BUILD.md](docs/BUILD.md)。

## 快速开始

### 源码树一键启动（已有 `dist\stage-runner` 打包产物）

```powershell
# 双击 scripts\start-runner.bat，或：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-runner.ps1

# 可选：-Port 8799 -NoOpen / -DryRun / -Stop
```

脚本会检查 `dist\stage-runner`、复制 `config\live.json`（若缺失）、启动
`oasd-runner.exe`、等待 `/runner/health` 通过，再打开 `http://127.0.0.1:8789/`。
若 `dist\stage-runner` 不存在，先按下方打包步骤生成。

### 构建与打包

```powershell
# 构建
cd apps\runner
cargo build --release --target-dir ..\..\target

# 打包（数据来自 oas-core 检出；toolkit 自动探测）
cd ..\..
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-runner.ps1 `
    -DataFrom D:\OAS-dev\oas-core -ToolkitFrom D:\OAS-dev\backend\toolkit
# 产物：dist\\oasd-runner-v0.2.0-win64.zip (+ .sha256)
```

终端用户拿到 zip 后：解压 → 改 `config\live.json` 的设备 serial → 双击 `start-runner.bat`
→ `http://127.0.0.1:8789/`（首启自动导入 `bundled-data\`）。

## 更新检测

Runner 像软件更新一样检测任务包发布：本地安装 · 本地 exchange 目录 · 远程网页/GitHub（`updates.feeds`，
HTTPS 下载使用系统 `curl`，零新依赖）。详见 [docs/UPDATES.md](docs/UPDATES.md)。

## License

MIT（与 oas-core 一致；许可证文本待随 Phase 1 代码同步）。
