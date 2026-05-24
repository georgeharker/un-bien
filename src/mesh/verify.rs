use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, VerifyingKey};

use super::types::{MeshEnvelope, MeshEnvelopeWire, MeshHeader};

#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    #[error("invalid base64: {0}")]
    BadBase64(String),
    #[error("blob is not valid JSON or missing required fields: {0}")]
    BadBlobJson(String),
    #[error("owner_pk in blob is not a valid 32-byte Ed25519 key")]
    BadOwnerPk,
    #[error("sig is not 64 bytes")]
    BadSigLength,
    #[error("Ed25519 signature verification failed")]
    SigFailed,
}

/// Verifies the envelope's signature against the blob using the owner_pk
/// embedded in the blob, and returns the parsed header (version + owner_pk).
///
/// **Canonical-JSON contract**: the relay does NOT canonicalize the blob —
/// it verifies the signature against exactly the bytes received. Clients are
/// responsible for producing canonical JSON before signing: keys sorted
/// lexicographically, no whitespace, JCS-style (RFC 8785 simplified).
/// Different serializers may produce different bytes for the same logical
/// object — agree on one canonical form across Dart, Rust, TypeScript.
pub fn verify_envelope(env: &MeshEnvelope) -> Result<MeshHeader, VerifyError> {
    let header: MeshHeader = serde_json::from_slice(&env.blob)
        .map_err(|e| VerifyError::BadBlobJson(e.to_string()))?;

    let owner_pk_bytes = B64
        .decode(&header.owner_pk)
        .map_err(|e| VerifyError::BadBase64(format!("owner_pk: {e}")))?;
    let owner_pk_arr: [u8; 32] = owner_pk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| VerifyError::BadOwnerPk)?;
    let vk = VerifyingKey::from_bytes(&owner_pk_arr).map_err(|_| VerifyError::BadOwnerPk)?;

    let sig_arr: [u8; 64] = env
        .sig
        .as_slice()
        .try_into()
        .map_err(|_| VerifyError::BadSigLength)?;
    let sig = Signature::from_bytes(&sig_arr);

    vk.verify_strict(&env.blob, &sig)
        .map_err(|_| VerifyError::SigFailed)?;

    Ok(header)
}

/// Decodes the wire envelope (base64 strings) into raw bytes.
pub fn decode_wire(wire: &MeshEnvelopeWire) -> Result<MeshEnvelope, VerifyError> {
    let blob = B64
        .decode(&wire.blob)
        .map_err(|e| VerifyError::BadBase64(format!("blob: {e}")))?;
    let sig = B64
        .decode(&wire.sig)
        .map_err(|e| VerifyError::BadBase64(format!("sig: {e}")))?;
    Ok(MeshEnvelope { blob, sig })
}

/// SHA-256 of the raw owner_pk bytes, lowercase hex (matches what clients
/// embed in the URL path).
pub fn owner_pk_hash(owner_pk: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(owner_pk);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sign_envelope(sk: &SigningKey, blob: Vec<u8>) -> MeshEnvelope {
        let sig = sk.sign(&blob).to_bytes().to_vec();
        MeshEnvelope { blob, sig }
    }

    fn make_blob(version: u64, owner_pk: &str) -> Vec<u8> {
        // Canonical-ish: serde_json with field order — owner_pk + version.
        // We don't strictly need canonicalization for the relay's verify path,
        // only consistent bytes. Tests sign whatever bytes they produce here.
        serde_json::to_vec(&serde_json::json!({
            "owner_pk": owner_pk,
            "version": version,
        }))
        .unwrap()
    }

    #[test]
    fn verifies_valid_envelope() {
        let sk = SigningKey::generate(&mut rand::thread_rng());
        let pk_b64 = B64.encode(sk.verifying_key().to_bytes());
        let blob = make_blob(7, &pk_b64);
        let env = sign_envelope(&sk, blob);

        let header = verify_envelope(&env).unwrap();
        assert_eq!(header.version, 7);
        assert_eq!(header.owner_pk, pk_b64);
    }

    #[test]
    fn rejects_tampered_blob() {
        let sk = SigningKey::generate(&mut rand::thread_rng());
        let pk_b64 = B64.encode(sk.verifying_key().to_bytes());
        let mut env = sign_envelope(&sk, make_blob(7, &pk_b64));
        // Flip a byte in the signed blob.
        env.blob[0] ^= 0xff;
        // Re-serialize JSON so it still parses cleanly but with bad bytes
        // — actually the easier way: keep blob valid JSON but mismatch sig.
        let original_blob = make_blob(7, &pk_b64);
        let env2 = MeshEnvelope { blob: original_blob, sig: env.sig.clone() };
        // env2 has a sig that was made over a different blob → sig fails.
        let _ = env; // silence unused
        // We want to assert verification fails; trick: swap blob with sig over different version.
        let other_blob = make_blob(99, &pk_b64);
        let bad = MeshEnvelope { blob: other_blob, sig: env2.sig };
        assert!(matches!(verify_envelope(&bad), Err(VerifyError::SigFailed)));
    }

    #[test]
    fn rejects_wrong_pk() {
        let sk = SigningKey::generate(&mut rand::thread_rng());
        let other_sk = SigningKey::generate(&mut rand::thread_rng());
        let other_pk_b64 = B64.encode(other_sk.verifying_key().to_bytes());
        // Blob says owner_pk = other, but signed by sk.
        let blob = make_blob(1, &other_pk_b64);
        let env = sign_envelope(&sk, blob);
        assert!(matches!(verify_envelope(&env), Err(VerifyError::SigFailed)));
    }

    #[test]
    fn computes_sha256_lowercase_hex() {
        // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        let h = owner_pk_hash(&[]);
        assert_eq!(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
