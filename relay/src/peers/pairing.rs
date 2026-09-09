use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use ed25519_dalek::{Signature, VerifyingKey};
use rusqlite::{Connection, params};
use serde::Deserialize;

use crate::identity::decode_ed25519_public_key;

/// Decoded machine-signed allow-list blob (design 01M23MKVG, authority parity).
/// The MACHINE signs this; the relay verifies the EXACT bytes and forges
/// nothing — at parity with owner-signed mesh_versions. `machine_pk` is
/// STANDARD-padded base64 of the machine key, identical to the relay's
/// challenge-verified peer_id encoding, so the handler binds signer↔connection
/// by string equality.
#[derive(Debug, Deserialize)]
pub struct PairingBlob {
    pub machine_pk: String,
    pub owners: Vec<String>,
    pub version: u64,
    #[allow(dead_code)]
    pub issued_at: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum PairingVerifyError {
    #[error("blob is not valid JSON: {0}")]
    BadJson(String),
    #[error("machine_pk is not a valid 32-byte Ed25519 key")]
    BadMachinePk,
    #[error("sig is not 64 bytes")]
    BadSigLength,
    #[error("Ed25519 signature verification failed")]
    SigFailed,
    #[error("an owner epk is not a valid Ed25519 key")]
    BadOwnerPk,
}

/// Verify a machine-signed allow-list envelope: parse the blob, verify_strict
/// the signature against the EXACT bytes using the machine_pk carried in the
/// blob, and validate every owner epk. Mirrors mesh/verify.rs verify_envelope
/// with the MACHINE as signer. Does NOT bind to the connection — the caller
/// asserts `machine_pk == peer_id` (the authority binding, principle 01M2393FR).
pub fn verify_pairing_blob(blob: &[u8], sig: &[u8]) -> Result<PairingBlob, PairingVerifyError> {
    let parsed: PairingBlob =
        serde_json::from_slice(blob).map_err(|e| PairingVerifyError::BadJson(e.to_string()))?;
    let machine_pk = decode_ed25519_public_key(&parsed.machine_pk)
        .map_err(|_| PairingVerifyError::BadMachinePk)?;
    let vk = VerifyingKey::from_bytes(&machine_pk).map_err(|_| PairingVerifyError::BadMachinePk)?;
    let sig_bytes: [u8; 64] = sig
        .try_into()
        .map_err(|_| PairingVerifyError::BadSigLength)?;
    vk.verify_strict(blob, &Signature::from_bytes(&sig_bytes))
        .map_err(|_| PairingVerifyError::SigFailed)?;
    if parsed
        .owners
        .iter()
        .any(|o| decode_ed25519_public_key(o).is_err())
    {
        return Err(PairingVerifyError::BadOwnerPk);
    }
    Ok(parsed)
}

/// Returned by [`PairingRegistry::set_signed`] when a push carries a version
/// that is not strictly greater than the stored one (replay / rollback).
#[derive(Debug)]
pub struct StaleVersion {
    pub new: u64,
    pub current: u64,
}

/// Per-machine pairing ALLOW-LIST: each machine (extension) pushes the set of
/// owner pubkeys permitted to LIST ITS ROOMS. Design 01M1ZE43.
///
/// This is the relay's OWN derived state — it NEVER reads the extension's
/// `peers.json` (owner-private source of truth). Soft state: dropped on relay
/// restart, re-pushed by each machine on (re)connect. Keyed by the machine's
/// authenticated `peer_id` (its epk); the values are the owner pubkeys allowed
/// to see that machine.
///
/// FAIL-CLOSED (design 01M1ZE43, george 'fail open is unacceptable'): an
/// UNCONFIGURED machine (no push yet) permits NO ONE — [`allows`] returns
/// `false`. Pairing still bootstraps: it needs neither rooms nor content
/// listing (presence stays open; pair frames are exempted in the handler by
/// peeking ct). SQLITE-BACKED via its OWN store (deliberately NOT mesh.db and
/// NOT the extension's peers.json): the allow-list survives relay restart, so
/// fail-closed does not re-open a global leak window on every restart (the two
/// only compose correctly TOGETHER). The in-memory `allow` map is the hot-path
/// cache; `store`, when present, is durable write-through backing.
#[derive(Default)]
pub struct PairingRegistry {
    allow: Mutex<HashMap<String, HashSet<String>>>,
    versions: Mutex<HashMap<String, u64>>,
    store: Mutex<Option<Connection>>,
}

impl PairingRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open (or create) the SQLite-backed registry at `path` — its OWN store,
    /// distinct from mesh.db and from the extension's peers.json. Loads the
    /// persisted allow-list into the in-memory cache so a restart preserves
    /// every machine's CONFIGURED status (design 01M1ZE43).
    pub fn with_store(path: impl AsRef<std::path::Path>) -> Result<Self, rusqlite::Error> {
        let path = path.as_ref();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pairing_allow (
                 machine TEXT NOT NULL,
                 owner   TEXT NOT NULL,
                 PRIMARY KEY (machine, owner)
             );
             CREATE TABLE IF NOT EXISTS pairing_signed (
                 machine TEXT PRIMARY KEY,
                 version INTEGER NOT NULL,
                 blob    BLOB NOT NULL,
                 sig     BLOB NOT NULL
             );",
        )?;
        let mut allow: HashMap<String, HashSet<String>> = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT machine, owner FROM pairing_allow")?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (machine, owner) = row?;
                allow.entry(machine).or_default().insert(owner);
            }
        }
        // Monotonic version floor per machine, so a restart rejects any replay
        // of a signed blob older than one we already accepted (design 01M23MKVG).
        let mut versions: HashMap<String, u64> = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT machine, version FROM pairing_signed")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
            })?;
            for row in rows {
                let (machine, version) = row?;
                versions.insert(machine, version);
            }
        }
        Ok(Self {
            allow: Mutex::new(allow),
            versions: Mutex::new(versions),
            store: Mutex::new(Some(conn)),
        })
    }

    /// Replace `machine`'s allow-list wholesale. The extension pushes the full
    /// set on connect and on every pairing change (add/revoke), so a plain
    /// replace is always correct — no add/remove deltas to reconcile. Writes
    /// through to SQLite (when backed) in a transaction so a restart sees
    /// exactly this set; the in-memory cache is updated regardless.
    pub fn set(&self, machine: String, owners: Vec<String>) {
        let set: HashSet<String> = owners.into_iter().collect();
        {
            let mut guard = self.store.lock().unwrap();
            if let Some(conn) = guard.as_mut() {
                let persisted = (|| -> rusqlite::Result<()> {
                    let tx = conn.transaction()?;
                    tx.execute(
                        "DELETE FROM pairing_allow WHERE machine = ?1",
                        params![&machine],
                    )?;
                    for owner in &set {
                        tx.execute(
                            "INSERT OR IGNORE INTO pairing_allow (machine, owner) VALUES (?1, ?2)",
                            params![&machine, owner],
                        )?;
                    }
                    tx.commit()
                })();
                if let Err(e) = persisted {
                    tracing::warn!(err = %e, "pairing_allow write-through failed; cache updated, durability lost until next push");
                }
            }
        }
        self.allow.lock().unwrap().insert(machine, set);
    }

    /// The monotonic version floor currently stored for `machine` (signed path).
    pub fn current_version(&self, machine: &str) -> Option<u64> {
        self.versions.lock().unwrap().get(machine).copied()
    }

    /// Store a MACHINE-SIGNED allow-list (design 01M23MKVG). Monotonic: rejects
    /// `version <= current` (replay / rollback). Persists the owners (hot-path
    /// `pairing_allow`) AND the raw signed blob + version (`pairing_signed`), so
    /// a restart keeps both the allow-list and the monotonic floor. The caller
    /// has already verified the signature and bound `machine` to the connection.
    pub fn set_signed(
        &self,
        machine: String,
        owners: Vec<String>,
        version: u64,
        blob: &[u8],
        sig: &[u8],
    ) -> Result<(), StaleVersion> {
        if let Some(current) = self.current_version(&machine)
            && version <= current
        {
            return Err(StaleVersion {
                new: version,
                current,
            });
        }
        let set: HashSet<String> = owners.into_iter().collect();
        {
            let mut guard = self.store.lock().unwrap();
            if let Some(conn) = guard.as_mut() {
                let persisted = (|| -> rusqlite::Result<()> {
                    let tx = conn.transaction()?;
                    tx.execute(
                        "DELETE FROM pairing_allow WHERE machine = ?1",
                        params![&machine],
                    )?;
                    for owner in &set {
                        tx.execute(
                            "INSERT OR IGNORE INTO pairing_allow (machine, owner) VALUES (?1, ?2)",
                            params![&machine, owner],
                        )?;
                    }
                    tx.execute(
                        "INSERT INTO pairing_signed (machine, version, blob, sig)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(machine) DO UPDATE SET
                             version = excluded.version,
                             blob    = excluded.blob,
                             sig     = excluded.sig",
                        params![&machine, version as i64, blob, sig],
                    )?;
                    tx.commit()
                })();
                if let Err(e) = persisted {
                    tracing::warn!(err = %e, "pairing_signed write-through failed; cache updated, durability lost until next push");
                }
            }
        }
        self.allow.lock().unwrap().insert(machine.clone(), set);
        self.versions.lock().unwrap().insert(machine, version);
        Ok(())
    }

    /// May `requester` list/reach `machine`? FAIL-CLOSED: an unconfigured
    /// machine (no push yet) permits no one.
    pub fn allows(&self, machine: &str, requester: &str) -> bool {
        match self.allow.lock().unwrap().get(machine) {
            None => false, // unconfigured → fail-CLOSED (design 01M1ZE43)
            Some(set) => set.contains(requester),
        }
    }

    /// The current allow-set for `machine` when configured — used to re-filter
    /// existing subscribers the moment a push lands (revocation completeness +
    /// reconnect-race cleanup). `None` = unconfigured.
    pub fn owners_of(&self, machine: &str) -> Option<HashSet<String>> {
        self.allow.lock().unwrap().get(machine).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_machine_fails_closed() {
        let p = PairingRegistry::new();
        assert!(
            !p.allows("machine", "anyone"),
            "no push yet → fail-CLOSED (design 01M1ZE43)"
        );
    }

    #[test]
    fn sqlite_store_persists_across_reopen() {
        let path =
            std::env::temp_dir().join(format!("unbien-pairing-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let p = PairingRegistry::with_store(&path).unwrap();
            p.set("m".into(), vec!["owner_a".into()]);
            assert!(p.allows("m", "owner_a"));
        }
        // Reopen: survives (would be lost if in-memory only) — the restart fix.
        let p2 = PairingRegistry::with_store(&path).unwrap();
        assert!(p2.allows("m", "owner_a"), "persisted across reopen");
        assert!(!p2.allows("m", "owner_b"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn configured_machine_enforces_allow_list() {
        let p = PairingRegistry::new();
        p.set("machine".into(), vec!["owner_a".into()]);
        assert!(p.allows("machine", "owner_a"));
        assert!(!p.allows("machine", "owner_b"), "not in list → refused");
    }

    #[test]
    fn empty_push_is_configured_and_refuses_all() {
        let p = PairingRegistry::new();
        p.set("machine".into(), vec![]);
        assert!(
            !p.allows("machine", "anyone"),
            "empty list is CONFIGURED, not open"
        );
    }

    #[test]
    fn set_replaces_and_revokes() {
        let p = PairingRegistry::new();
        p.set("m".into(), vec!["a".into(), "b".into()]);
        assert!(p.allows("m", "b"));
        p.set("m".into(), vec!["a".into()]); // b revoked
        assert!(p.allows("m", "a"));
        assert!(!p.allows("m", "b"), "replace drops the revoked owner");
    }

    // ── signed allow-list (design 01M23MKVG) ──
    use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
    use ed25519_dalek::{Signer, SigningKey};

    fn owner_epk(n: u8) -> String {
        B64.encode([n; 32])
    }

    fn sign_blob(sk: &SigningKey, owners: &[String], version: u64) -> (Vec<u8>, Vec<u8>, String) {
        let machine_pk = B64.encode(sk.verifying_key().to_bytes());
        let blob = serde_json::to_vec(&serde_json::json!({
            "machine_pk": machine_pk,
            "owners": owners,
            "version": version,
            "issued_at": 1_000u64,
        }))
        .unwrap();
        let sig = sk.sign(&blob).to_bytes().to_vec();
        (blob, sig, machine_pk)
    }

    #[test]
    fn signed_blob_verifies_and_exposes_machine_pk() {
        let sk = SigningKey::from_bytes(&[3u8; 32]);
        let owners = vec![owner_epk(1), owner_epk(2)];
        let (blob, sig, machine_pk) = sign_blob(&sk, &owners, 5);
        let parsed = verify_pairing_blob(&blob, &sig).expect("valid signature");
        assert_eq!(parsed.machine_pk, machine_pk);
        assert_eq!(parsed.version, 5);
        assert_eq!(parsed.owners, owners);
    }

    #[test]
    fn signed_blob_rejects_wrong_signature() {
        let sk = SigningKey::from_bytes(&[3u8; 32]);
        let (blob, mut sig, _) = sign_blob(&sk, &[owner_epk(1)], 5);
        sig[0] ^= 0xff;
        assert!(matches!(
            verify_pairing_blob(&blob, &sig),
            Err(PairingVerifyError::SigFailed)
        ));
    }

    #[test]
    fn signed_blob_rejects_tampered_blob() {
        let sk = SigningKey::from_bytes(&[3u8; 32]);
        let (mut blob, sig, _) = sign_blob(&sk, &[owner_epk(1)], 5);
        let i = blob.len() / 2;
        blob[i] ^= 0xff;
        assert!(
            verify_pairing_blob(&blob, &sig).is_err(),
            "signature must not match tampered bytes"
        );
    }

    #[test]
    fn set_signed_is_monotonic() {
        let p = PairingRegistry::new();
        assert!(
            p.set_signed("m".into(), vec![owner_epk(1)], 5, b"blob", b"sig")
                .is_ok()
        );
        assert!(p.allows("m", &owner_epk(1)));
        assert!(
            p.set_signed("m".into(), vec![owner_epk(1)], 5, b"blob", b"sig")
                .is_err(),
            "equal version → stale"
        );
        assert!(
            p.set_signed("m".into(), vec![owner_epk(1)], 4, b"blob", b"sig")
                .is_err(),
            "lower version → stale"
        );
        assert!(
            p.set_signed("m".into(), vec![owner_epk(2)], 6, b"blob", b"sig")
                .is_ok()
        );
        assert!(p.allows("m", &owner_epk(2)));
        assert!(!p.allows("m", &owner_epk(1)), "v6 replaced the set");
    }

    #[test]
    fn set_signed_version_floor_persists_across_reopen() {
        let path =
            std::env::temp_dir().join(format!("unbien-pairing-signed-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let p = PairingRegistry::with_store(&path).unwrap();
            assert!(
                p.set_signed("m".into(), vec![owner_epk(1)], 10, b"b", b"s")
                    .is_ok()
            );
        }
        let p2 = PairingRegistry::with_store(&path).unwrap();
        assert_eq!(p2.current_version("m"), Some(10), "floor persisted");
        assert!(p2.allows("m", &owner_epk(1)), "allow-list persisted");
        assert!(
            p2.set_signed("m".into(), vec![owner_epk(1)], 10, b"b", b"s")
                .is_err(),
            "replay at the persisted floor is rejected after restart"
        );
        let _ = std::fs::remove_file(&path);
    }
}
