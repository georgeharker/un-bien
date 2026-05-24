//! Plan 25 Wave A — Pi-to-Pi envelope forwarding via the relay.
//!
//! Pi-A sends a control frame:
//!
//! ```jsonc
//! { "type": "pi_envelope", "to_pc": "<Pi-B-pubkey-b64>", "envelope": { ... } }
//! ```
//!
//! The relay authenticates Pi-A via the existing challenge-response (so we
//! already trust `sender_peer_id` here), looks up the `mesh_versions` blob
//! that lists Pi-A and confirms Pi-B is in the same Owner's member list, then
//! forwards to Pi-B (any live conn) as:
//!
//! ```jsonc
//! { "type": "pi_envelope_in", "from_pc": "<Pi-A-pubkey>", "envelope": <verbatim> }
//! ```
//!
//! Failures don't use a custom error frame — the relay synthesizes an envelope
//! with `body.type = "transport_error"` (per the plan's ACK protocol section),
//! correlated to the sender's original envelope via `re: <original_id>`.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::ws::Message;
use rand::{Rng, thread_rng};
use tracing::warn;

use crate::mesh::MeshStore;
use crate::peers::registry::PeerRegistry;

/// Time-to-live for a positive membership lookup. The plan calls for 60 s.
/// Negative lookups are NOT cached (so adding a Pi to a mesh blob takes
/// effect immediately for subsequent forwards).
const CACHE_TTL: Duration = Duration::from_secs(60);

/// In-memory cache that maps `Pi-pubkey → set of mesh siblings`. Built lazily
/// by scanning the SQLite `mesh_versions` blobs.
#[derive(Debug, Default)]
pub struct MeshAuthCache {
    inner: Mutex<HashMap<String, CachedMembers>>,
}

#[derive(Debug)]
struct CachedMembers {
    members: HashSet<String>,
    cached_at: Instant,
}

impl MeshAuthCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the set of mesh siblings of `pi_pk` (including `pi_pk` itself),
    /// or `None` if no Owner blob lists this Pi. Refreshes on cache miss /
    /// TTL expiry by scanning all `mesh_versions` blobs.
    fn members_of(&self, pi_pk: &str, store: &MeshStore) -> Option<HashSet<String>> {
        {
            let g = self.inner.lock().unwrap();
            if let Some(c) = g.get(pi_pk)
                && c.cached_at.elapsed() < CACHE_TTL
            {
                return Some(c.members.clone());
            }
        }

        let blobs = match store.all_blobs() {
            Ok(b) => b,
            Err(e) => {
                warn!("mesh store read failed during auth: {e}");
                return None;
            }
        };

        for blob in blobs {
            let parsed: serde_json::Value = match serde_json::from_slice(&blob) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let Some(members_arr) = parsed.get("members").and_then(|v| v.as_array()) else {
                continue;
            };
            let set: HashSet<String> = members_arr
                .iter()
                .filter_map(|m| m.get("remote_epk").and_then(|v| v.as_str()).map(String::from))
                .collect();
            if set.contains(pi_pk) {
                let mut g = self.inner.lock().unwrap();
                g.insert(
                    pi_pk.to_string(),
                    CachedMembers { members: set.clone(), cached_at: Instant::now() },
                );
                return Some(set);
            }
        }
        None
    }

    /// `true` iff both Pis belong to the same Owner's mesh.
    pub fn is_authorized(&self, pi_a: &str, pi_b: &str, store: &MeshStore) -> bool {
        match self.members_of(pi_a, store) {
            Some(members) => members.contains(pi_b),
            None => false,
        }
    }
}

/// What the routing loop should do after calling `handle_pi_envelope`.
pub enum PiForwardResult {
    /// Envelope delivered (or accepted by the channel of) Pi-B.
    Forwarded,
    /// Send this message back to the original sender via their own WS sink.
    /// Always a `pi_envelope_in` whose envelope carries
    /// `body.type = "transport_error"`.
    TransportError(Message),
}

/// Handles one `pi_envelope` frame. `sender_peer_id` is the authenticated
/// Pi-A pubkey (already verified by the WS handshake).
pub async fn handle_pi_envelope(
    sender_peer_id: &str,
    frame: &serde_json::Value,
    registry: &PeerRegistry,
    mesh: &MeshStore,
    cache: &MeshAuthCache,
) -> PiForwardResult {
    let to_pc = frame.get("to_pc").and_then(|v| v.as_str());
    let envelope = frame.get("envelope");

    let (to_pc, envelope) = match (to_pc, envelope) {
        (Some(t), Some(e)) if e.is_object() && !t.is_empty() => (t, e),
        _ => {
            return PiForwardResult::TransportError(make_transport_error(
                frame.get("envelope"),
                "bad_envelope",
            ));
        }
    };

    if !cache.is_authorized(sender_peer_id, to_pc, mesh) {
        return PiForwardResult::TransportError(make_transport_error(
            Some(envelope),
            "not_authorized",
        ));
    }

    let outbound = serde_json::json!({
        "type": "pi_envelope_in",
        "from_pc": sender_peer_id,
        "envelope": envelope, // verbatim
    });
    let msg = Message::Text(outbound.to_string());

    if registry.forward_to_peer(to_pc, msg) {
        PiForwardResult::Forwarded
    } else {
        PiForwardResult::TransportError(make_transport_error(Some(envelope), "offline"))
    }
}

/// Builds a `pi_envelope_in` frame whose inner envelope carries
/// `body.type = "transport_error"`, correlated to the original via `re`.
fn make_transport_error(envelope: Option<&serde_json::Value>, reason: &str) -> Message {
    let (re, to_addr) = match envelope {
        Some(e) => (
            e.get("id").and_then(|v| v.as_str()).map(String::from),
            e.get("from").and_then(|v| v.as_str()).unwrap_or("_unknown").to_string(),
        ),
        None => (None, "_unknown".to_string()),
    };

    let new_id = format!("{:032x}", thread_rng().r#gen::<u128>());

    let err_envelope = serde_json::json!({
        "from": "_relay",
        "to": to_addr,
        "id": new_id,
        "re": re,
        "body": { "type": "transport_error", "reason": reason },
    });

    let frame = serde_json::json!({
        "type": "pi_envelope_in",
        "from_pc": "_relay",
        "envelope": err_envelope,
    });
    Message::Text(frame.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PresenceManager;
    use crate::RoomManager;
    use std::sync::Arc;

    fn fresh_cache_and_store() -> (MeshAuthCache, MeshStore) {
        (MeshAuthCache::new(), MeshStore::open_in_memory().unwrap())
    }

    fn write_owner_blob(store: &MeshStore, owner_pk: &[u8], members: &[&str], version: u64) {
        use sha2::{Digest, Sha256};
        let pk_b64 = {
            use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
            B64.encode(owner_pk)
        };
        let members_json: Vec<serde_json::Value> = members
            .iter()
            .map(|m| serde_json::json!({ "remote_epk": m }))
            .collect();
        let blob = serde_json::json!({
            "owner_pk": pk_b64,
            "version": version,
            "members": members_json,
        });
        let blob_bytes = serde_json::to_vec(&blob).unwrap();
        let hash = {
            let d = Sha256::digest(owner_pk);
            let mut s = String::with_capacity(64);
            for b in d {
                s.push_str(&format!("{b:02x}"));
            }
            s
        };
        store.upsert(&hash, owner_pk, version, &blob_bytes, &[0u8; 64], 0).unwrap();
    }

    #[tokio::test]
    async fn authorized_same_owner() {
        let (cache, store) = fresh_cache_and_store();
        write_owner_blob(&store, &[1u8; 32], &["pi_a", "pi_b"], 1);
        assert!(cache.is_authorized("pi_a", "pi_b", &store));
        assert!(cache.is_authorized("pi_b", "pi_a", &store));
    }

    #[tokio::test]
    async fn not_authorized_cross_owner() {
        let (cache, store) = fresh_cache_and_store();
        write_owner_blob(&store, &[1u8; 32], &["pi_a"], 1);
        write_owner_blob(&store, &[2u8; 32], &["pi_b"], 1);
        assert!(!cache.is_authorized("pi_a", "pi_b", &store));
        assert!(!cache.is_authorized("pi_b", "pi_a", &store));
    }

    #[tokio::test]
    async fn cache_hits_after_first_lookup() {
        let (cache, store) = fresh_cache_and_store();
        write_owner_blob(&store, &[3u8; 32], &["pi_x", "pi_y"], 1);
        // First lookup: cold (scans store)
        assert!(cache.is_authorized("pi_x", "pi_y", &store));
        // Subsequent lookups: cache HIT (the test merely ensures correctness;
        // the actual cache short-circuit can be observed via tracing or fault
        // injection if needed)
        assert!(cache.is_authorized("pi_x", "pi_y", &store));
        let g = cache.inner.lock().unwrap();
        assert!(g.contains_key("pi_x"), "first lookup must populate cache");
    }

    #[tokio::test]
    async fn bad_envelope_when_missing_to_pc() {
        let registry = Arc::new(PeerRegistry::new(
            Arc::new(PresenceManager::new()),
            Arc::new(RoomManager::new()),
        ));
        let store = MeshStore::open_in_memory().unwrap();
        let cache = MeshAuthCache::new();
        let frame = serde_json::json!({
            "type": "pi_envelope",
            "envelope": { "from": "x", "to": "y", "id": "abc", "re": null, "body": {} },
        });
        match handle_pi_envelope("pi_a", &frame, &registry, &store, &cache).await {
            PiForwardResult::TransportError(_) => {} // expected
            PiForwardResult::Forwarded => panic!("must be transport_error"),
        }
    }
}
