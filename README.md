# oas-runner — OAS 使用端（Runner）独立仓库

> 本仓是 **OAS 使用端（Runner）** 的独立代码/发布仓，与开发端仓库
> [`passioki/oas-core`](https://github.com/passioki/oas-core) 分离。
> 使用端只负责：安装任务包（`.oaspkg`）、填写任务运行参数、排队/调度、
> 执行、查看运行记录；**不含 Studio 编辑端**（任务构建/素材/帧库/发布工具仍在 oas-core）。

## 目标结构（Phase 0 进行中）

```
oas-runner/
  apps/runner/           Runner 二进制（HTTP 8789 + Runner UI + 内嵌调度 + 包安装）
  ui/                    runner.html / runner.js / runner.css / style.css
  crates/                共享引擎 crates（Phase 1 通过 git 依赖锁定 oas-core tag；
                         或 submodule；具体方案见 oas-core docs/RUNNER-SPLIT-DESIGN.md §3）
  bundled-data/          oas-core 数据快照（tasks + assets + manifest.json，生成，禁止手改）
  packaging/             start-runner.bat / stop-runner.bat / README-RUNNER.txt / live.example.json
  scripts/               sync-bundled-data.ps1 / check-bundled-data.ps1 / package.ps1
  docs/                  Runner 侧文档（安装/配置/发布通知/更新检测）
  dist/                  构建产物（不入 git）
```

## 当前状态

- 2026-11-05：仓库创建（空仓骨架）。Runner 代码仍在 oas-core（`apps/oasd` 的 Runner surface），
  Phase 1 搬迁前本仓只承载：计划/文档、数据镜像脚本、打包与发布说明。
- 权威设计：oas-core `docs/RUNNER-STUDIO-SPLIT-PLAN.md`、`docs/ENGINE-DESIGN.md §22.44~§22.54`、
  `_verify/dual-app-design-20261105/RUNNER-SPLIT-DESIGN.md`（设计稿在 oas-core 仓外证据目录）。
- 发布：Runner-only zip 由 oas-core 的 `scripts/package-runner.ps1` 产出（含 `bundled-data/`），
  本仓 Phase 1 起独立构建/发布。

## 更新检测（设计目标）

Runner 需要像软件更新一样检测任务包发布：本地安装（已有）· 本地 exchange 目录（已有）·
远程网页/GitHub 拉取（计划：`updates.feeds`，HTTPS 下载采用系统 `curl`，零新依赖）。
详见 oas-core `docs/PENDING-LEDGER.md §E-83` / 后续本仓 `docs/UPDATES.md`。

## License

MIT（与 oas-core 一致；许可证文本待随 Phase 1 代码同步）。
