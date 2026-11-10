//! Runner 应用（Runner/Studio 分离的 Phase 1b）。
//!
//! 本二进制刻意保持**轻薄**：Runner 的全部能力（:8789 的 HTTP API、Runner UI、
//! 内嵌调度、包安装、Runner 配置等）都在 `oasd` 引擎库中。引擎通过
//! `Cargo.toml` 中的提交 `rev` 固定，因此本仓构建出的 Runner 与 oas-core
//! **完全一致**，且不复制任何引擎代码。
//!
//! Phase 1b 细节：发布版 Runner 包把 UI 放在可执行文件旁（`ui\`），但 oasd
//! 二进制的默认 UI 目录是 `apps/oasd/ui`（作者仓路径，本仓不存在）。因此
//! 通过 `oasd::cli::run_as_with_args("runner", ...)` 把 `--ui ui` 作为
//! **默认值**注入。
//!
//! 仅当用户没有在命令行任何位置传入 `--ui` / `--ui=<dir>` 时才注入该参数，
//! 因此用户显式值始终优先，且不会被重复追加。

fn main() -> std::process::ExitCode {
    let mut extra = Vec::new();
    let has_ui = std::env::args().any(|a| a == "--ui" || a.starts_with("--ui="));
    if !has_ui {
        extra.push("--ui".to_string());
        extra.push("ui".to_string());
    }
    oasd::cli::run_as_with_args("runner", extra)
}
