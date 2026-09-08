use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use rusqlite::{Connection, params};

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
        Ok(Self {
            allow: Mutex::new(allow),
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
        let path = std::env::temp_dir()
            .join(format!("unbien-pairing-test-{}.db", std::process::id()));
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
}
