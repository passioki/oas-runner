# 构建与运行（oasd-runner）

> Phase 1b：Runner 的**二进制入口/UI** 在本仓；引擎能力（HTTP 服务、内嵌调度、包安装、
> Runner 配置等）来自 oas-core 的 `oasd` **库**，通过 Cargo **git 依赖 + commit rev** 锁定。

## 依赖版本

`apps/runner/Cargo.toml` 中：

```toml
oasd = { git = "https://github.com/passioki/oas-core", rev = "<oas-core commit>", features = ["ocr"] }
```

- 当前 rev：见 `apps/runner/Cargo.toml`（`39d97b8…`，seq 115）。
- oas-core 有 Runner 相关改动时：合并到 oas-core `dev`/`main` → 更新本仓 `rev` →
  `cargo build` 成功 → 提交新版 `Cargo.lock`。流程刻意「显式升级」，避免两仓漂移。
- 未打 tag（用户未要求 release）；直接锁 commit hash。

## 构建

```powershell
cd D:\OAS-dev\oas-runner\apps\runner
cargo build --release --target-dir ..\..\target
# 产物：..\..\target\release\oasd-runner.exe
```

- 使用 `--target-dir` 放在仓库根 `target/`（`.gitignore` 已忽略；`apps/runner/target/` 也已忽略）。
- 首次构建需要网络（拉取 oas-core git 依赖 + crates）；`ocr` feature 首次可能需
  ort/onnxruntime 二进制下载（本机已缓存时可加 `--offline`）。
- 本机测试用：`cargo build --target-dir ..\..\target`（debug）。

## 运行（Windows 本机）

```powershell
# 在带 ui/、tasks/、assets/、config/live.json 的发布目录里
oasd-runner.exe --port 8789 --ui ui --tasks-dir tasks --runs-dir runs --assets-dir assets --config config\live.json --no-open
```

- `run_as("runner")` 已锁定 Runner surface：Studio 路由一律 404（不会误开 8788 编辑端）。
- 启动后浏览 `http://127.0.0.1:8789/`。
- 随包任务/素材：首启仍由 `oasd` 的 `bundled_data` 导入逻辑处理（数据目录为空时）；
  Phase 1b 后续会把 `bundled-data` 生成/打包脚本迁入本仓。
- 更新检测：见 [UPDATES.md](UPDATES.md)。

## 当前分工（Phase 1b 进行中）

| 在本仓 | 仍在 oas-core |
|---|---|
| `apps/runner`（薄二进制）、`ui/`（Runner UI）、构建/运行文档 | `oasd` 库（引擎/HTTP/serve/包安装/调度）、`scripts/package-runner.ps1`、`bundled-data` 生成、`start-runner.bat`/`README-RUNNER`、`live.example.json` |

后续把打包/数据镜像/启动脚本迁入后，本仓即可独立产出 Runner-only 发布包。
