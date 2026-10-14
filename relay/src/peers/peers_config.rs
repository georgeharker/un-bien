//! `relay-peers.json` — the shared relay-peering config file (federation v2).
//!
//! The CLI owns the file: it writes `peers` (pinned peer relays), `pending`
//! (outstanding pairing secrets minted by `unbien relay pair`), and the legacy
//! `federation.enabled` flag. The relay reads it FRESH on every use (the CLI
//! can flip it live) and — since the one-pair auto-add — also WRITES it:
//! atomically (temp file + rename, mode 0600, same directory so the rename is
//! atomic and the fswatch loop sees one clean event), preserving every
//! top-level field it does not own. Both relay sides (the inbound
//! `/relay-peer` handler and the outbound peering loop) go through this module
//! so the read/write shapes stay in one place.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::warn;

use crate::paths::relay_peers_path;

/// A peer relay entry from `relay-peers.json`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RelayPeerConfig {
    pub url: String,
    pub name: String,
    /// The peer relay's pinned Ed25519 public key (base64). Since the
    /// strict pairing gate (federation v2 §1) this is what decides the
    /// link: an unpinned configured peer is not dialed (outbound) and an
    /// unpinned presenter is declined (inbound).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pubkey: Option<String>,
    /// The pairing secret for this peer (base64 one-time TOKEN, not a key),
    /// written by the CLI from a `relay-pair://` URL. Presented in the
    /// outbound `relay_hello` so the peer can auto-add us; the pin (pubkey)
    /// is the durable trust, this only bootstraps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pair_secret: Option<String>,
}

/// A pending pairing entry `{secret, name, url, at}` held by the ISSUING
/// relay (the CLI's `unbien relay pair` appends one). `name`/`url` are the
/// issuer's own identity as the pairing URL advertised it — the relay does
/// NOT trust them for the auto-add; the auto-added entry uses the PRESENTER's
/// hello fields. `secret` is a one-time token, single-use, matched by
/// SHA-256 hash of the base64 string (never by raw equality).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PendingRelayPair {
    pub secret: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub at: String,
    /// Mint time, epoch millis (expiry is checked against PENDING_TTL_MS).
    /// Absent (0) on legacy entries ⇒ no expiry — entries minted before the
    /// TTL behaves as they always did.
    #[serde(default)]
    pub at_ms: u64,
}

/// A pending pairing invitation is single-use AND short-lived: 24h from
/// mint. An unconsumed entry otherwise stays a live pairing secret in a
/// state file forever (each `relay pair` mints a fresh one; nothing else
/// ever removed them).
pub const PENDING_TTL_MS: u64 = 24 * 60 * 60 * 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Read the raw document at `path`, fresh. `None` when absent or unparsable
/// (a parse error is loud — the file is operator-owned and a silent empty
/// read would look like "no peers configured").
fn read_doc(path: &Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(v) => Some(v),
        Err(e) => {
            warn!(path = %path.display(), err = %e, "relay-peers.json parse error");
            None
        }
    }
}

/// Atomically write the document: temp file in the SAME directory (rename is
/// atomic within a filesystem; the relay's fswatch loop watches the dir and
/// sees one clean create event, not a truncated intermediate), mode 0600,
/// then rename over the target. Preserves whatever fields the caller put in
/// `doc` — callers must spread the previously-read document.
pub fn write_doc_atomic(path: &Path, doc: &serde_json::Value) -> Result<(), String> {
    let tmp = path.with_file_name(format!(
        "{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("relay-peers.json"),
        std::process::id()
    ));
    let body = serde_json::to_string_pretty(doc).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    #[allow(clippy::permissions_set_readonly_false)]
    let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))?;
    Ok(())
}

/// Read the configured peer relays from `<state_root>/relay-peers.json`.
pub fn read_peer_config() -> Vec<RelayPeerConfig> {
    read_peer_config_at(&relay_peers_path())
}

/// Read the pending pairing entries from `<state_root>/relay-peers.json`.
pub fn read_pending() -> Vec<PendingRelayPair> {
    read_pending_at(&relay_peers_path())
}

pub fn read_peer_config_at(path: &Path) -> Vec<RelayPeerConfig> {
    read_doc(path)
        .and_then(|doc| doc.get("peers").and_then(|v| v.as_array()).cloned())
        .map(|peers| {
            peers
                .into_iter()
                .filter_map(|p| serde_json::from_value(p).ok())
                .collect()
        })
        .unwrap_or_default()
}

pub fn read_pending_at(path: &Path) -> Vec<PendingRelayPair> {
    read_doc(path)
        .and_then(|doc| doc.get("pending").and_then(|v| v.as_array()).cloned())
        .map(|pending| {
            pending
                .into_iter()
                .filter_map(|p| serde_json::from_value(p).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// SHA-256 of the base64 token STRING (hex) — the pending-secret compare is
/// hash-based, never raw equality.
fn secret_hash(secret_b64: &str) -> String {
    let d = Sha256::digest(secret_b64.as_bytes());
    hex(&d)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

/// The one-pair auto-add (federation v2 §2): match `pair_secret` against an
/// outstanding pending entry (SHA-256 compare of the b64 token, single-use),
/// then write the presenter into `peers` pinned to the PRESENTED key and
/// remove the consumed pending entry — one atomic write that preserves every
/// other field in the file (peers, the legacy federation flag, anything
/// else). The fswatch loop sees the new peers[] entry and dials it: both
/// directions live, both directions pinned.
///
/// `Ok(true)` = pending entry consumed + peer added. `Ok(false)` = no
/// pending entry matches the secret (the decline the caller should log
/// loudly). `Err` = the file could not be read/written.
pub fn consume_pending_and_add_peer(
    pair_secret: &str,
    presented_url: &str,
    presented_name: &str,
    presented_pubkey: &str,
) -> Result<bool, String> {
    consume_pending_and_add_peer_at(
        &relay_peers_path(),
        pair_secret,
        presented_url,
        presented_name,
        presented_pubkey,
    )
}

pub fn consume_pending_and_add_peer_at(
    path: &Path,
    pair_secret: &str,
    presented_url: &str,
    presented_name: &str,
    presented_pubkey: &str,
) -> Result<bool, String> {
    let Some(mut doc) = read_doc(path) else {
        return Err("relay-peers.json unreadable".to_string());
    };
    let Some(obj) = doc.as_object_mut() else {
        return Err("relay-peers.json is not an object".to_string());
    };

    // Match by SHA-256 hash of the b64 token (never raw equality).
    let presented_hash = secret_hash(pair_secret);
    let Some(pending) = obj.get_mut("pending").and_then(|v| v.as_array_mut()) else {
        return Ok(false); // no pending array at all ⇒ the token matches nothing
    };
    // Sweep EXPIRED invitations while we hold the doc: a pending is
    // single-use AND short-lived (PENDING_TTL_MS) — an unconsumed entry
    // otherwise stays a live pairing secret in this file forever. Legacy
    // entries without at_ms never expire.
    let now = now_ms();
    let before = pending.len();
    pending.retain(|p| match p.get("at_ms").and_then(|v| v.as_u64()) {
        None | Some(0) => true, // legacy / unset ⇒ no expiry
        Some(at_ms) => now.saturating_sub(at_ms) < PENDING_TTL_MS,
    });
    let swept_expired = pending.len() != before;
    let matched = pending.iter().position(|p| {
        p.get("secret")
            .and_then(|s| s.as_str())
            .map(secret_hash)
            .as_deref()
            == Some(presented_hash.as_str())
    });
    let Some(matched) = matched else {
        // Unmatched (wrong, spent, or swept-expired secret): persist the
        // sweep so expired entries don't accumulate in the file.
        if swept_expired {
            write_doc_atomic(path, &doc)?;
        }
        return Ok(false); // decline, nothing else written
    };
    pending.remove(matched);

    // Upsert the presenter into peers[] (by name — same semantics as the
    // CLI's addRelayPeer: a re-pair under the same name replaces the entry).
    let new_peer = serde_json::json!({
        "url": presented_url,
        "name": presented_name,
        "pubkey": presented_pubkey,
    });
    let peers = obj
        .entry("peers".to_string())
        .or_insert_with(|| serde_json::Value::Array(vec![]));
    let Some(peers) = peers.as_array_mut() else {
        return Err("relay-peers.json peers is not an array".to_string());
    };
    match peers
        .iter_mut()
        .find(|p| p.get("name").and_then(|n| n.as_str()) == Some(presented_name))
    {
        Some(existing) => {
            // INHERIT the existing url when the presenter's is empty (its
            // process may have lost UNBIEN_RELAY_URL — observed live after
            // restarts): a re-pair must never clobber a dialable entry
            // with an empty one.
            let url = if presented_url.is_empty() {
                existing
                    .get("url")
                    .and_then(|u| u.as_str())
                    .unwrap_or_default()
                    .to_string()
            } else {
                presented_url.to_string()
            };
            *existing = serde_json::json!({
                "url": url,
                "name": presented_name,
                "pubkey": presented_pubkey,
            });
        }
        None => peers.push(new_peer),
    }

    write_doc_atomic(path, &doc)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("unbien-peers-config-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("relay-peers.json")
    }

    fn write_seed(path: &std::path::Path, doc: serde_json::Value) {
        std::fs::write(path, serde_json::to_string(&doc).unwrap()).unwrap();
    }

    #[test]
    fn reads_peers_and_pending() {
        let path = tmp_path("read");
        write_seed(
            &path,
            serde_json::json!({
                "federation": {"enabled": true},
                "peers": [
                    {"url": "http://b:3000", "name": "relay-b", "pubkey": "pk-b"},
                    {"url": "http://c:3000", "name": "relay-c", "pair_secret": "s"}
                ],
                "pending": [{"secret": "tok", "name": "self", "url": "http://a:3000", "at": "t"}]
            }),
        );
        let peers = read_peer_config_at(&path);
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0].pubkey.as_deref(), Some("pk-b"));
        assert_eq!(peers[1].pair_secret.as_deref(), Some("s"));
        let pending = read_pending_at(&path);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].secret, "tok");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn absent_file_reads_empty() {
        let path = tmp_path("absent").with_file_name("nope.json");
        assert!(read_peer_config_at(&path).is_empty());
        assert!(read_pending_at(&path).is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn consume_secret_adds_peer_and_preserves_other_fields() {
        let path = tmp_path("consume");
        write_seed(
            &path,
            serde_json::json!({
                "federation": {"enabled": true},
                "peers": [{"url": "http://old:3000", "name": "relay-old", "pubkey": "pk-old"}],
                "pending": [
                    {"secret": "tok-wrong", "name": "self", "url": "http://a:3000", "at": "t1"},
                    {"secret": "tok-right", "name": "self", "url": "http://a:3000", "at": "t2"}
                ],
                "someFutureField": {"keep": true}
            }),
        );

        // Unknown secret: no match, nothing written.
        assert!(
            !consume_pending_and_add_peer_at(&path, "tok-unknown", "http://x:1", "x", "pk-x")
                .unwrap()
        );
        assert_eq!(read_pending_at(&path).len(), 2);

        // Right secret: consumed + peer added.
        assert!(
            consume_pending_and_add_peer_at(&path, "tok-right", "http://b:9", "relay-b", "pk-b")
                .unwrap()
        );
        let peers = read_peer_config_at(&path);
        assert_eq!(peers.len(), 2);
        let added = peers.iter().find(|p| p.name == "relay-b").unwrap();
        assert_eq!(added.url, "http://b:9");
        assert_eq!(added.pubkey.as_deref(), Some("pk-b"));
        assert!(
            added.pair_secret.is_none(),
            "auto-added entry must not carry a secret"
        );
        let pending = read_pending_at(&path);
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].secret, "tok-wrong",
            "only the MATCHING entry is consumed"
        );
        // Other fields survive verbatim.
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["federation"]["enabled"], serde_json::json!(true));
        assert_eq!(doc["someFutureField"], serde_json::json!({"keep": true}));

        // Single-use: the same token declines on a second presentation.
        assert!(
            !consume_pending_and_add_peer_at(&path, "tok-right", "http://x:1", "x", "pk-x")
                .unwrap()
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn expired_pending_is_not_consumable() {
        let path = tmp_path("ttl-dead");
        let old_ms = now_ms().saturating_sub(PENDING_TTL_MS + 60_000);
        write_seed(
            &path,
            serde_json::json!({
                "peers": [],
                "pending": [
                    {"secret": "tok-stale", "name": "self", "url": "http://a:3000", "at": "t1", "at_ms": old_ms}
                ]
            }),
        );
        assert!(
            !consume_pending_and_add_peer_at(&path, "tok-stale", "http://b:9", "relay-b", "pk-b")
                .unwrap(),
            "an expired invitation's secret no longer pairs"
        );
        assert!(read_peer_config_at(&path).is_empty(), "no peer was added");
        assert!(
            read_pending_at(&path).is_empty(),
            "the sweep removed the expired entry (persisted even on no-match)"
        );
    }

    #[test]
    fn legacy_pending_without_at_ms_never_expires() {
        let path = tmp_path("ttl-legacy");
        write_seed(
            &path,
            serde_json::json!({
                "peers": [],
                "pending": [
                    {"secret": "tok-old", "name": "self", "url": "http://a:3000", "at": "t1"}
                ]
            }),
        );
        assert!(
            consume_pending_and_add_peer_at(&path, "tok-old", "http://b:9", "relay-b", "pk-b")
                .unwrap(),
            "legacy entries (no at_ms) keep the pre-TTL behavior"
        );
    }

    #[test]
    fn sweep_keeps_fresh_and_drops_only_expired() {
        let path = tmp_path("ttl-sweep");
        let old_ms = now_ms().saturating_sub(PENDING_TTL_MS + 60_000);
        write_seed(
            &path,
            serde_json::json!({
                "peers": [],
                "pending": [
                    {"secret": "tok-dead", "name": "self", "url": "http://a:3000", "at": "t1", "at_ms": old_ms},
                    {"secret": "tok-fresh", "name": "self", "url": "http://a:3000", "at": "t2", "at_ms": now_ms()}
                ]
            }),
        );
        assert!(
            !consume_pending_and_add_peer_at(&path, "tok-nope", "http://x:1", "x", "pk-x").unwrap()
        );
        let pending = read_pending_at(&path);
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].secret, "tok-fresh",
            "the sweep persisted: only the expired entry is removed"
        );
    }

    #[test]
    fn consume_with_empty_url_inherits_existing() {
        let path = tmp_path("inherit-url");
        write_seed(
            &path,
            serde_json::json!({
                "peers": [{"url": "http://good:3000", "name": "relay-a", "pubkey": "pk-old"}],
                "pending": [
                    {"secret": "tok", "name": "self", "url": "http://a:3000", "at": "t1", "at_ms": now_ms()}
                ]
            }),
        );
        // The presenter's process lost UNBIEN_RELAY_URL (empty presented
        // url): the re-pair must federate AND keep the dialable url.
        assert!(consume_pending_and_add_peer_at(&path, "tok", "", "relay-a", "pk-new").unwrap());
        let peers = read_peer_config_at(&path);
        let entry = peers.iter().find(|p| p.name == "relay-a").unwrap();
        assert_eq!(
            entry.url, "http://good:3000",
            "empty presented url inherits the existing entry's"
        );
        assert_eq!(entry.pubkey.as_deref(), Some("pk-new"));
        // A NON-empty presented url still replaces (the upsert contract).
        write_seed(
            &path,
            serde_json::json!({
                "peers": [{"url": "http://good:3000", "name": "relay-a", "pubkey": "pk-old"}],
                "pending": [
                    {"secret": "tok2", "name": "self", "url": "http://a:3000", "at": "t2", "at_ms": now_ms()}
                ]
            }),
        );
        assert!(
            consume_pending_and_add_peer_at(&path, "tok2", "http://fresh:9", "relay-a", "pk-new")
                .unwrap()
        );
        let peers = read_peer_config_at(&path);
        assert_eq!(peers[0].url, "http://fresh:9");
    }

    #[test]
    fn consume_upserts_by_name() {
        let path = tmp_path("upsert");
        write_seed(
            &path,
            serde_json::json!({
                "peers": [{"url": "http://stale:3000", "name": "relay-b", "pubkey": "pk-stale"}],
                "pending": [{"secret": "tok", "name": "self", "url": "http://a:3000", "at": "t"}]
            }),
        );
        assert!(
            consume_pending_and_add_peer_at(
                &path,
                "tok",
                "http://fresh:3000",
                "relay-b",
                "pk-fresh"
            )
            .unwrap()
        );
        let peers = read_peer_config_at(&path);
        assert_eq!(
            peers.len(),
            1,
            "same-name re-pair replaces, never duplicates"
        );
        assert_eq!(peers[0].url, "http://fresh:3000");
        assert_eq!(peers[0].pubkey.as_deref(), Some("pk-fresh"));
        assert!(read_pending_at(&path).is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn consume_with_no_pending_array_is_no_match() {
        let path = tmp_path("nopending");
        write_seed(&path, serde_json::json!({"peers": []}));
        assert!(!consume_pending_and_add_peer_at(&path, "tok", "http://x:1", "x", "pk-x").unwrap());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn atomic_write_leaves_no_temp_behind() {
        let path = tmp_path("atomic");
        write_doc_atomic(&path, &serde_json::json!({"peers": []})).unwrap();
        assert!(path.exists());
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files must be renamed away");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
