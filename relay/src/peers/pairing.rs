use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// Per-machine pairing ALLOW-LIST: each machine (extension) pushes the set of
/// owner pubkeys permitted to LIST ITS ROOMS. Design 01M1ZE43.
///
/// This is the relay's OWN derived state — it NEVER reads the extension's
/// `peers.json` (owner-private source of truth). Soft state: dropped on relay
/// restart, re-pushed by each machine on (re)connect. Keyed by the machine's
/// authenticated `peer_id` (its epk); the values are the owner pubkeys allowed
/// to see that machine.
///
/// FAIL-OPEN while a machine is UNCONFIGURED (has never pushed a list — an
/// older extension, or before its first push): [`allows`] returns `true` so the
/// rollout never strands a machine that doesn't yet speak this protocol. Once a
/// machine pushes ANY list (even empty) it is CONFIGURED and the gate is
/// enforced. Only the ROOMS plane consults this; presence + content stay open.
#[derive(Debug, Default)]
pub struct PairingRegistry {
    allow: Mutex<HashMap<String, HashSet<String>>>,
}

impl PairingRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace `machine`'s allow-list wholesale. The extension pushes the full
    /// set on connect and on every pairing change (add/revoke), so a plain
    /// replace is always correct — no add/remove deltas to reconcile.
    pub fn set(&self, machine: String, owners: Vec<String>) {
        let set: HashSet<String> = owners.into_iter().collect();
        self.allow.lock().unwrap().insert(machine, set);
    }

    /// May `requester` list `machine`'s rooms? Fail-open when `machine` is
    /// unconfigured (no push yet); enforced once configured.
    pub fn allows(&self, machine: &str, requester: &str) -> bool {
        match self.allow.lock().unwrap().get(machine) {
            None => true, // unconfigured → fail-open (safe rollout)
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
    fn unconfigured_machine_fails_open() {
        let p = PairingRegistry::new();
        assert!(p.allows("machine", "anyone"), "no push yet → fail-open");
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
