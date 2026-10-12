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
pub fn all_owner_hashes(mesh: &MeshStore, pairing: &PairingRegistry) -> HashSet<String> {
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
pub fn owner_member_set(
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
