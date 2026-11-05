//! The Runner application (Phase 1b of the Runner/Studio split).
//!
//! This binary is intentionally *thin*: every Runner capability (HTTP API at
//! :8789, Runner UI, embedded scheduler, package install, runner config, …)
//! lives in the `oasd` engine library. The engine is pinned by commit `rev` in
//! `Cargo.toml`, so this repository builds the *exact same* Runner as oas-core
//! without copying any engine code.
//!
//! Phase 1b detail: the released Runner package ships its UI next to the
//! executable (`ui\`), but the oasd binary's default UI directory is
//! `apps/oasd/ui` (an authoring-repo path that does not exist here). We
//! therefore inject `--ui ui` as a **default** through
//! `oasd::cli::run_as_with_args("runner", ...)`.
//!
//! The flag is only injected when the user did not already pass `--ui` /
//! `--ui=<dir>` anywhere on the command line, so an explicit user value always
//! wins and is never appended twice.

fn main() -> std::process::ExitCode {
    let mut extra = Vec::new();
    let has_ui = std::env::args().any(|a| a == "--ui" || a.starts_with("--ui="));
    if !has_ui {
        extra.push("--ui".to_string());
        extra.push("ui".to_string());
    }
    oasd::cli::run_as_with_args("runner", extra)
}
