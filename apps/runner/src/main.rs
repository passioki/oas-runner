//! The Runner application (Phase 1a of the Runner/Studio split).
//!
//! This binary is intentionally *thin*: every Runner capability (HTTP API at
//! :8789, Runner UI, embedded scheduler, package install, runner config, …)
//! lives in the `oasd` engine library. `oasd::cli::run_as("runner")` runs the
//! exact CLI of the oasd binary with the `runner` surface locked, so the two
//! applications never drift apart.
//!
//! Phase 1b will replace the current path dependency with a pinned git rev/tag
//! of oas-core and move the UI/packaging/data mirroring into this repository.

fn main() -> std::process::ExitCode {
    oasd::cli::run_as("runner")
}
