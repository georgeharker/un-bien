//! Shared owner-membership logic — used by BOTH the federation shared-owner
//! check (peering.rs) AND the pi_envelope authorization check (pi_forward.rs).
//!
//! Two data sources:
//! - **MeshStore** (mesh_versions table): owner-signed blobs listing the
//!   owner's machines. Populated by the app via POST /mesh. May be empty
//!   if the app hasn't published.
//! - **PairingRegistry** (pairing_set pushes): per-machine allow-lists of
//!   which owners can see the machine's rooms. Populated by the extension
//!   when a pi connects. Works without the app.
//!
//! Both sources are combined so that authorization + federation work even
//! when only one source is populated.

use std::collections::HashSet;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};

use crate::identity::canonical_ed25519_public_key;
use crate::mesh::verify::owner_pk_hash;
use crate::mesh::{MeshStore, types::MeshHeader};
use crate::peers::pairing::PairingRegistry;

/// All owner hashes (SHA-256 hex of owner public key bytes) from both the
/// mesh_versions table + the PairingRegistry. Used by the federation
/// shared-owner check (`has_common_owner`).
pub fn trust_root_hashes(mesh: &MeshStore, pairing: &PairingRegistry) -> HashSet<String> {
    let mut hashes = HashSet::new();
    // From mesh_versions (app-published).
    if let Ok(mesh_hashes) = mesh.all_owner_hashes() {
        hashes.extend(mesh_hashes);
    }
    // From PairingRegistry (extension-pushed pairing_set — no app needed).
    for pk_b64 in pairing.all_owner_pubkeys() {
        if let Ok(bytes) = B64.decode(&pk_b64) {
            hashes.insert(owner_pk_hash(&bytes));
        }
    }
    hashes
}

/// All machines that share an owner with `pi_pk`, from both the mesh store +
/// the PairingRegistry. Used by the pi_envelope authorization check
/// (`is_authorized_canonical`): if the target is in this set → authorized.
pub fn authorized_peers(
    pi_pk: &str,
    mesh: &MeshStore,
    pairing: &PairingRegistry,
) -> HashSet<String> {
    let mut members = HashSet::new();

    // From mesh_versions (owner's signed member list).
    if let Ok(blobs) = mesh.all_blobs() {
        if let Some(mesh_members) = direct_members_from_blobs(pi_pk, &blobs) {
            members.extend(mesh_members);
        }
    }

    // From PairingRegistry (machines that share an owner in their allow-lists).
    if let Some(owners) = pairing.owners_of(pi_pk) {
        for owner in &owners {
            for machine in pairing.machines_by_owner(owner) {
                // Canonicalize the machine epk (same format as the mesh store).
                if let Ok(canon) = canonical_ed25519_public_key(&machine) {
                    members.insert(canon);
                }
            }
        }
    }

    members
}

/// Extract the member set from mesh_versions blobs (moved from pi_forward.rs
/// so both paths share the same logic).
fn direct_members_from_blobs(pi_pk: &str, blobs: &[Vec<u8>]) -> Option<HashSet<String>> {
    let mut union = HashSet::new();
    for blob in blobs {
        let header: MeshHeader = match serde_json::from_slice(blob) {
            Ok(header) => header,
            Err(_) => continue,
        };
        let owner_members: Result<HashSet<String>, _> = header
            .members
            .iter()
            .map(|member| canonical_ed25519_public_key(&member.remote_epk))
            .collect();
        let Ok(owner_members) = owner_members else {
            continue;
        };
        if owner_members.contains(pi_pk) {
            union.extend(owner_members);
        }
    }
    (!union.is_empty()).then_some(union)
}

/// Gate #5, in one place: may `sender` deliver an envelope to `target`?
/// - Local target: full sender+target membership (mesh store + PairingRegistry).
/// - Federated target (on a peer relay): federation v2 §3 — the SENDER's
///   machine-signed owner set (local PairingRegistry, `owners_of`) must
///   intersect the TARGET's advertised machine-signed owner set (learned
///   from the peering exchange — `FederatedSessions::machine_owners`, passed
///   in by the caller so this stays testable without FederatedSessions).
///   Either side unknown/empty ⇒ REFUSE — strict, no optimistic forwarding
///   and no machine exemptions: a machine IS its owner set. The deciding
///   relay is always the SOURCE (the 9779b88 lesson — the dest relay never
///   re-refuses on its own stale view).
pub fn authorize_send(
    sender: &str,
    target: &str,
    mesh: &MeshStore,
    pairing: &PairingRegistry,
    is_federated_target: bool,
    target_owners: Option<&HashSet<String>>,
) -> bool {
    if is_federated_target {
        let (Some(sender_owners), Some(target_owners)) = (pairing.owners_of(sender), target_owners)
        else {
            return false;
        };
        return !sender_owners.is_empty()
            && !target_owners.is_empty()
            && sender_owners.intersection(target_owners).next().is_some();
    }
    authorized_peers(sender, mesh, pairing).contains(target)
}

/// Gate #6, in one place: verify a relay_forward's provenance signature
/// (signed by the forwarding relay over request_id|from_epk|target_epk|visited).
/// Unsigned or invalid forwards are rejected.
pub fn verify_relay_forward(
    request_id: &str,
    from_epk: &str,
    target_epk: &str,
    visited: &[String],
    relay_pubkey: &Option<String>,
    relay_sig: &Option<String>,
) -> bool {
    match (relay_pubkey, relay_sig) {
        (Some(pk), Some(sig)) => {
            let msg = format!("{request_id}|{from_epk}|{target_epk}|{}", visited.join(","));
            super::relay_keypair::RelayKeypair::verify(pk, msg.as_bytes(), sig)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry_with(machine: &str, owners: &[&str]) -> PairingRegistry {
        let pairing = PairingRegistry::new();
        pairing.set(
            machine.to_string(),
            owners.iter().map(|o| o.to_string()).collect(),
        );
        pairing
    }

    /// Federation v2 §3 — the agent-plane federated branch: machine-signed
    /// owner-set intersection, strict on unknown/empty, NO machine exemption.
    #[test]
    fn federated_branch_requires_owner_set_intersection() {
        let mesh = MeshStore::open_in_memory().unwrap();
        let sender = "sender-machine";
        let shared: HashSet<String> = ["owner-x"].into_iter().map(String::from).collect();

        // Shared owner in both signed sets ⇒ authorized.
        let pairing = registry_with(sender, &["owner-x", "owner-s"]);
        assert!(authorize_send(
            sender,
            "target-machine",
            &mesh,
            &pairing,
            true,
            Some(&shared)
        ));

        // Disjoint owner sets ⇒ refused (cross-owner).
        let pairing = registry_with(sender, &["owner-s"]);
        let other: HashSet<String> = ["owner-t"].into_iter().map(String::from).collect();
        assert!(!authorize_send(
            sender,
            "target-machine",
            &mesh,
            &pairing,
            true,
            Some(&other)
        ));

        // Sender owner set unknown (no signed pairing_set push) ⇒ refused —
        // even though the sender is a "valid local member" by mesh/pairing
        // sibling rules (the old, now-retired federated branch).
        let pairing = PairingRegistry::new();
        pairing.set(
            "some-machine".into(),
            vec![sender.into(), "target-machine".into()],
        );
        assert!(!authorize_send(
            sender,
            "target-machine",
            &mesh,
            &pairing,
            true,
            Some(&shared)
        ));

        // Target owner set unknown (not exchanged yet) ⇒ refused.
        let pairing = registry_with(sender, &["owner-x"]);
        assert!(!authorize_send(
            sender,
            "target-machine",
            &mesh,
            &pairing,
            true,
            None
        ));

        // Either side EMPTY (configured but empty push) ⇒ refused.
        let pairing = registry_with(sender, &[]);
        assert!(!authorize_send(
            sender,
            "target-machine",
            &mesh,
            &pairing,
            true,
            Some(&shared)
        ));
        let pairing = registry_with(sender, &["owner-x"]);
        let empty: HashSet<String> = HashSet::new();
        assert!(!authorize_send(
            sender,
            "target-machine",
            &mesh,
            &pairing,
            true,
            Some(&empty)
        ));
    }

    /// The LOCAL-target branch is unchanged: full sender+target membership.
    #[test]
    fn local_branch_unchanged_membership_check() {
        use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
        let key = |byte: u8| B64.encode([byte; 32]);
        let mesh = MeshStore::open_in_memory().unwrap();
        let sender = key(0x0a);
        let target = key(0x0b);
        let owner = key(0xcc);
        // Siblings under one owner (both machines' allow-lists name the same
        // owner) ⇒ authorized — the target owner set is IGNORED on the local
        // branch (None must not refuse).
        let pairing = PairingRegistry::new();
        pairing.set(sender.clone(), vec![owner.clone()]);
        pairing.set(target.clone(), vec![owner]);
        assert!(authorize_send(
            &sender, &target, &mesh, &pairing, false, None
        ));
        // Not a member ⇒ refused.
        assert!(!authorize_send(
            &sender,
            &key(0x0c),
            &mesh,
            &pairing,
            false,
            None
        ));
    }
}
