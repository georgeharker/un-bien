//! Filesystem resolution for the relay's on-disk footprint (design 01M1CB6Q:
//! the config/state split). The relay's DEFAULT mesh DB and its own log file
//! live under the same state root the extension uses, so a deployment
//! relocates both with one knob — and a bare-metal `cargo run` no longer
//! litters the CWD with a `data/mesh.db` (three stray ones exist on disk
//! because of that old default).
//!
//! `UNBIEN_MESH_DB_PATH` remains the direct override and wins over everything
//! (the Docker image presets it to `/data/mesh.db`).

use std::path::{Path, PathBuf};

/// Pure state-root resolution, parameterized so tests can pin the inputs
/// (edition 2024 makes `std::env::set_var` unsafe, so the env-reading
/// wrappers stay thin and untested-by-design).
///
/// Order: `UNBIEN_STATE_DIR` (absolute override) >
/// `${XDG_STATE_HOME:-$HOME/.local/state}/un-bien` (the XDG-style default —
/// `XDG_STATE_HOME` unset, conventionally so on macOS, falls back to
/// `$HOME/.local/state`).
pub fn state_root_from(
    state_dir: Option<&str>,
    xdg_state_home: Option<&str>,
    home: &Path,
) -> PathBuf {
    if let Some(dir) = state_dir.filter(|s| !s.is_empty()) {
        return PathBuf::from(dir);
    }
    let base = match xdg_state_home.filter(|s| !s.is_empty()) {
        Some(xdg) => PathBuf::from(xdg),
        None => home.join(".local").join("state"),
    };
    base.join("un-bien")
}

/// The relay's state root, from the process env.
pub fn state_root() -> PathBuf {
    state_root_from(
        std::env::var("UNBIEN_STATE_DIR").ok().as_deref(),
        std::env::var("XDG_STATE_HOME").ok().as_deref(),
        &home_root(),
    )
}

/// Pure mesh DB resolution: `UNBIEN_MESH_DB_PATH` (absolute override, wins)
/// falls through to `<state root>/mesh.db`.
pub fn mesh_db_path_from(override_path: Option<&str>, state_root: &Path) -> PathBuf {
    match override_path.filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => state_root.join("mesh.db"),
    }
}

/// The relay's default mesh DB path, from the process env. The parent
/// directory is created by `MeshStore::open` on first boot.
pub fn resolve_mesh_db_path() -> PathBuf {
    mesh_db_path_from(
        std::env::var("UNBIEN_MESH_DB_PATH").ok().as_deref(),
        &state_root(),
    )
}

/// The relay's own log file, appended to alongside stdout. Pure core; the
/// env wrapper is below.
pub fn relay_log_path_from(state_root: &Path) -> PathBuf {
    state_root.join("relay.log")
}

/// The relay's own log file path, from the process env.
pub fn resolve_relay_log_path() -> PathBuf {
    relay_log_path_from(&state_root())
}

/// `$HOME` / `%USERPROFILE%`. Read directly rather than via
/// `std::env::home_dir()`: that function is only un-deprecated since Rust
/// 1.87 while this crate's MSRV is 1.85. A process with no home at all gets
/// `/` — the DB open then fails loudly instead of silently littering the CWD
/// (the failure mode this module exists to kill).
fn home_root() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/home/agent";

    fn root(state_dir: Option<&str>, xdg: Option<&str>) -> PathBuf {
        state_root_from(state_dir, xdg, Path::new(HOME))
    }

    #[test]
    fn xdg_default_is_local_state_un_bien() {
        assert_eq!(
            root(None, None),
            PathBuf::from("/home/agent/.local/state/un-bien")
        );
    }

    #[test]
    fn xdg_state_home_replaces_the_local_state_base() {
        assert_eq!(
            root(None, Some("/var/lib/unbien")),
            PathBuf::from("/var/lib/unbien/un-bien")
        );
    }

    #[test]
    fn state_dir_wins_over_xdg() {
        assert_eq!(
            root(Some("/srv/unbien-state"), Some("/var/lib/unbien")),
            PathBuf::from("/srv/unbien-state")
        );
    }

    #[test]
    fn empty_strings_are_treated_as_unset() {
        assert_eq!(
            root(Some(""), Some("")),
            PathBuf::from("/home/agent/.local/state/un-bien")
        );
    }

    #[test]
    fn mesh_db_override_wins_over_everything() {
        assert_eq!(
            mesh_db_path_from(Some("/data/mesh.db"), &root(None, None)),
            PathBuf::from("/data/mesh.db")
        );
        // Empty override falls through to the state root.
        assert_eq!(
            mesh_db_path_from(Some(""), &root(Some("/state"), None)),
            PathBuf::from("/state/mesh.db")
        );
    }

    #[test]
    fn mesh_db_default_is_state_root_join_mesh_db() {
        assert_eq!(
            mesh_db_path_from(None, &root(None, None)),
            PathBuf::from("/home/agent/.local/state/un-bien/mesh.db")
        );
        assert_eq!(
            mesh_db_path_from(None, &root(Some("/srv/state"), Some("/ignored"))),
            PathBuf::from("/srv/state/mesh.db")
        );
    }

    #[test]
    fn relay_log_sits_beside_the_db() {
        assert_eq!(
            relay_log_path_from(&root(None, None)),
            PathBuf::from("/home/agent/.local/state/un-bien/relay.log")
        );
    }
}
