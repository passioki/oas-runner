# 构建、打包与运行（oasd-runner）

> Phase 1b **已完成**：Runner 的二进制入口、Runner UI、打包脚本、`bundled-data` 数据快照、
> 启停脚本与说明文档都在本仓；引擎能力（HTTP 服务、内嵌调度、包安装、Runner 配置等）
> 来自 oas-core 的 `oasd` **库**，通过 Cargo **git 依赖 + commit rev** 锁定。
> 本仓现在可以**独立产出 Runner-only 发布包**（不再依赖 oas-core 的打包脚本）。

## 1. 依赖版本（显式升级）

`apps/runner/Cargo.toml`：

```toml
oasd = { git = "https://github.com/passioki/oas-core", rev = "<oas-core commit>", features = ["ocr"] }
```

- 当前 rev：**`fe3d4ae54610e27b7fae6f7646226c0b08838100`**（oas-core 0.2.0 发布提交；新增
  `oasd::cli::run_as_with_args`，本仓用它注入默认 `--ui ui`）。
- 升级流程（刻意显式，避免两仓漂移）：
  1. oas-core 有 Runner 相关改动 → 合并/推送到 oas-core `dev`；
  2. 改本仓 `apps/runner/Cargo.toml` 的 `rev`；
  3. `cargo build --release --target-dir ..\..\target` 成功；
  4. 提交更新后的 `Cargo.lock`（打包脚本会校验 lock 里确实钉住了该 rev）。
- 未打 tag（用户未要求 release）；直接锁 commit hash。

## 2. 构建

```powershell
cd D:\OAS-dev\oas-runner\apps\runner
cargo build --release --target-dir ..\..\target
# 产物：..\..\target\release\oasd-runner.exe
```

- `--target-dir` 放在仓库根 `target/`（`.gitignore` 已忽略；`apps/runner/target/` 也已忽略）。
- 首次构建需要网络（拉取 oas-core git 依赖 + crates）；`ocr` feature 首次可能需
  ort/onnxruntime 二进制下载（本机已缓存时可加 `--offline`）。
- 本机 debug：`cargo build --target-dir ..\..\target`。

## 3. 默认 UI 目录（Phase 1b）

oasd 二进制的默认 UI 目录是 `apps/oasd/ui`（oas-core 开发仓路径，发布包里不存在）。
本仓的 `apps/runner/src/main.rs` 通过新 API 注入**默认参数**：

```rust
let has_ui = std::env::args().any(|a| a == "--ui" || a.starts_with("--ui="));
if !has_ui { extra.push("--ui".into()); extra.push("ui".into()); }
oasd::cli::run_as_with_args("runner", extra)
```

- 发布包根目录下 `ui\` 即可直接启动，**不需要任何 `--ui` 参数**（`start-runner.bat` 也不再传）。
- 用户显式传 `--ui <dir>` / `--ui=<dir>` 时默认注入被跳过，用户值生效（`serve_cmd` 后出现的
  `--ui` 覆盖前面的值）。
- `--ui` 属于 surface 参数，`run_as_with_args` 注入的默认参数在进程参数**之前**，所以用户
  参数永远优先。

## 4. 打包（本仓独立产出 Runner-only 发布包）

```powershell
# 完整包（默认：先 cargo build，再生成 zip；数据来自 ..\oas-core，toolkit 自动探测）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-runner.ps1 `
    -DataFrom D:\OAS-dev\oas-core -ToolkitFrom D:\OAS-dev\backend\toolkit

# 只打包（exe 已存在）、离线构建
... -SkipBuild -Offline

# 只打印计划，不写盘
... -DryRun

# 精简包：不带数据 / 不带 models+adb（调试用）
... -NoData
... -SkipToolkit
```

### 4.1 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Version` | `0.2.0` | 包版本（VERSION / BUILD-INFO / 默认 zip 名） |
| `-DataFrom` | 自动探测 `..\oas-core` | oas-core 检出：其 `tasks\` + `assets\` 生成 `bundled-data\`；不存在且未 `-NoData` → 报错 |
| `-NoData` | 关 | 不生成 `bundled-data\`（程序-only 包） |
| `-ToolkitFrom` | 自动探测 `..\oas-core\backend\toolkit` / `D:\OAS-dev\backend\toolkit` | 含 OCR 模型 + Windows adb；支持扁平 `<root>\models`+`<root>\adb` 与 Python 布局 `<root>\Lib\site-packages\rapidocr\models`+`adbutils\binaries` |
| `-SkipToolkit` | 关 | 包内不含 `models\`/`adb\`（仅调试；toolkit 找不到时必须显式给） |
| `-OutFile` | `dist\oasd-runner-v<版本>-win64.zip` | 输出 zip（相对路径按仓库根解析） |
| `-SkipBuild` | 关 | 跳过 `cargo build`（用已存在的 `target\release\oasd-runner.exe`） |
| `-Offline` | 关 | 传 `--offline` 给 cargo（依赖已缓存） |
| `-DryRun` | 关 | 只打印计划/缺失项，不构建、不写盘 |

### 4.2 包内容

`oasd-runner.exe`、`ui\runner.{html,js,css}` + `ui\style.css`、`models\`（2 个 ONNX）、
`adb\`、`bundled-data\{manifest.json,tasks\**,assets\**}`（`-NoData` 时无）、
`config\live.example.json` + `live.json`、`start-runner.bat` / `stop-runner.bat`、
`README-RUNNER.txt`、`scheduler.json`（空 schema v4）、空数据目录占位
（`tasks\ assets\ runs\ logs\ packages\`；不含 frames/relations/templates）、`VERSION`、`BUILD-INFO.txt`。

**不含**：Studio 编辑 UI（`index.html`/`app.js`/`builder.js`/`flow_model.js`/`asset_ui.js`/
`dashboard.*`）、Studio 二进制、`frames\`/`library\` 等创作数据。

### 4.3 数据快照 `bundled-data\`（与 oas-core 同 schema）

- 来源：`-DataFrom` 的 `tasks\`（剔 `state/`、`.backup/`、`*.bak`、`*.tmp`、`*.clicks.jsonl`）
  + `assets\`（`assets.json` + `images/`）。
- `manifest.json`（schema **1**，BOM-free）：`source{repo,commit,version}`（数据来源 = oas-core
  的 git 短 hash / remote / 版本）、`tasks[]`、`assets{assets_json_sha256,image_count}`、
  `files[{path,sha256,bytes}]`、`total_bytes`。
- 打包 stage 审计逐文件校验 sha256、manifest 文件数 == 实际文件数、无 `state/`/`.backup/`。
- Runner 首启（`oasd` 的 `bundled_data` 逻辑，见 oas-core `apps/oasd/src/bundled_data.rs`）：
  **仅当数据目录为空**时校验并导入到 `tasks\`+`assets\`，写 `packages\bundled-import.json`；
  幂等（同一 `source.commit` 不重复导入）、永不覆盖用户数据、失败整批回滚。

### 4.4 输出与审计

- `dist\oasd-runner-v<版本>-win64.zip`（entry 名统一 `/` 分隔，**不用** PS5.1 `Compress-Archive`）
  + `.sha256` + `dist\BUILD-INFO.txt`。
- `BUILD-INFO.txt` 关键字段：`surface: runner`、`runner_app: oasd-runner`、
  `oasd_rev: <40-hex>`、`data:`（bundled 摘要）、`toolkit:`、`git:`（本仓）、`built_at:`。
- stage 审计：必需文件齐全；关键文件非 0 字节；`ui\` 只含 4 个 Runner UI 文件；
  所有 JSON 首字节 `{`/`[` 且无 UTF-8 BOM；无 Studio-only 文件名；Cargo.lock 钉住 Cargo.toml 的 rev。
- 脚本为 **ASCII-only**（PS 5.1 读取无 BOM UTF-8 脚本会按 ANSI 解码）；生成的文本/JSON 一律
  BOM-free UTF-8（引擎 `serde_json` 拒绝 BOM）。

## 5. 运行（Windows 本机）

源码树一键启动已打包好的 `dist\stage-runner`（推荐开发/联调用）：

```powershell
# 双击 scripts\start-runner.bat，或：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-runner.ps1

# 参数：-Port 8799 -NoOpen / -DryRun / -Stop
# 指定其它 stage：-StageDir D:\some\runner-package
```

脚本会校验 stage、复制 `config\live.json`（缺失时）、启动 `oasd-runner.exe`、
等待 `/runner/health` 通过后打开 `http://127.0.0.1:<port>/`；失败时打印
`logs\runner.out.log` / `logs\runner.err.log` 尾部并返回非 0。
`dist\stage-runner` 不存在时先执行 §4 的打包脚本。

在带 `ui\`、`config\live.json` 的发布目录里也可直接运行：

```powershell
# 在带 ui\、config\live.json 的发布目录里（默认 UI 目录 = .\ui，无需 --ui）
oasd-runner.exe --port 8789 --tasks-dir tasks --runs-dir runs --assets-dir assets --config config\live.json --no-open
# 或直接双击发布包内的 start-runner.bat
```

- `run_as_with_args("runner", ...)` 已锁定 Runner surface：Studio 路由一律 404（不会误开 8788 编辑端）。
- 启动后浏览 `http://127.0.0.1:8789/`。
- 更新检测（updates feed）见 [UPDATES.md](UPDATES.md)；装包/调度/配置能力来自引擎。

## 6. 当前分工

| 在本仓 | 仍在 oas-core |
|---|---|
| `apps/runner`（薄二进制 + 默认 `--ui` 注入）、`ui/`、`scripts/package-runner.ps1`、`bundled-data` 生成、`packaging/**`（README-RUNNER/live.example/start-stop bat）、构建/打包/更新文档 | `oasd` 引擎库（HTTP/serve/包安装/调度/bundled 导入/更新检测引擎实现）、Studio 编辑端与双面包 |

## 7. 验证与未覆盖

- Phase 1b 实测：release 构建 exit 0；打包 zip 产出；解压后 `8795` smoke：
  `/runner/health` 200、`GET /` 200（Runner UI）、`/app.js` 404、`/task/lint` 404、
  `bundled-data` 首启导入 3 任务 + 素材、`--ui <dir>` 显式覆盖生效。
- 未覆盖/后续：打 tag / GitHub Release 与两仓版本号联动策略（Lead 决定）；
  `--version` 打印为 `oasd 0.2.0`（继承 oas-core 0.2.0）；
  ort/onnxruntime 首次下载的网络前提（同 oas-core）；macOS/Linux 打包未做（v1 只 Windows）。
