//! The relay's own Ed25519 identity keypair — used for relay-to-relay
//! peering authentication (signing `relay_hello`/`relay_hello_ack` to
//! prove possession of the private key). Generated on first run, persisted
//! in `<state_root>/relay-keypair.json`.
//!
//! The file format is compatible with the CLI's `@noble/ed25519` keypair:
//! both use the 32-byte seed as the private key.

use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};

use crate::paths::relay_keypair_path;

#[derive(Debug, Clone)]
pub struct RelayKeypair {
    pub signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
}

#[derive(Debug, Serialize, Deserialize)]
struct KeypairFile {
    public_key: String,
    private_key: String,
}

impl RelayKeypair {
    /// The relay's public key, base64-encoded (the relay's "id").
    pub fn pubkey_b64(&self) -> String {
        B64.encode(self.verifying_key.to_bytes())
    }

    /// Sign a message with the relay's private key.
    pub fn sign(&self, msg: &[u8]) -> String {
        let sig: Signature = self.signing_key.sign(msg);
        B64.encode(sig.to_bytes())
    }

    /// Verify a signature against a public key (base64-encoded).
    pub fn verify(pubkey_b64: &str, msg: &[u8], sig_b64: &str) -> bool {
        let Ok(pk_bytes) = B64.decode(pubkey_b64) else {
            return false;
        };
        let Ok(sig_bytes) = B64.decode(sig_b64) else {
            return false;
        };
        let pk_arr: [u8; 32] = match pk_bytes.as_slice().try_into() {
            Ok(a) => a,
            Err(_) => return false,
        };
        let Ok(vk) = VerifyingKey::from_bytes(&pk_arr) else {
            return false;
        };
        let sig_arr: [u8; 64] = match sig_bytes.as_slice().try_into() {
            Ok(a) => a,
            Err(_) => return false,
        };
        let sig = Signature::from_bytes(&sig_arr);
        vk.verify(msg, &sig).is_ok()
    }

    fn generate_and_save(path: &Path) -> RelayKeypair {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng);
        let verifying_key = signing_key.verifying_key();
        let file = KeypairFile {
            public_key: B64.encode(verifying_key.to_bytes()),
            private_key: B64.encode(signing_key.to_bytes()),
        };
        let _ = std::fs::write(
            path,
            serde_json::to_string_pretty(&file).unwrap_or_default(),
        );
        RelayKeypair {
            signing_key,
            verifying_key,
        }
    }
}

/// Load the relay keypair from the state dir, or generate + persist a new one.
/// The path defaults to `relay_keypair_path()` but can be overridden (for tests).
pub fn load_or_generate(path: Option<&Path>) -> RelayKeypair {
    let default_path = relay_keypair_path();
    let path = path.unwrap_or(&default_path);

    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Ok(file) = serde_json::from_str::<KeypairFile>(&raw) {
            if let (Ok(sk_bytes), Ok(pk_bytes)) =
                (B64.decode(&file.private_key), B64.decode(&file.public_key))
            {
                if sk_bytes.len() == 32 && pk_bytes.len() == 32 {
                    let sk_arr: [u8; 32] = match sk_bytes.as_slice().try_into() {
                        Ok(a) => a,
                        Err(_) => return RelayKeypair::generate_and_save(path),
                    };
                    let signing_key = SigningKey::from_bytes(&sk_arr);
                    let verifying_key = signing_key.verifying_key();
                    return RelayKeypair {
                        signing_key,
                        verifying_key,
                    };
                }
            }
        }
    }

    RelayKeypair::generate_and_save(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keypair_roundtrip() {
        let dir = std::env::temp_dir().join("relay_keypair_test_roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("relay-keypair.json");

        let kp1 = load_or_generate(Some(&path));
        let kp2 = load_or_generate(Some(&path));

        assert_eq!(
            kp1.pubkey_b64(),
            kp2.pubkey_b64(),
            "second load should be same key"
        );

        let msg = b"hello relay";
        let sig = kp1.sign(msg);
        assert!(RelayKeypair::verify(&kp1.pubkey_b64(), msg, &sig));
        assert!(!RelayKeypair::verify(&kp1.pubkey_b64(), b"tampered", &sig));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keypair_generates_on_missing_file() {
        let dir = std::env::temp_dir().join("relay_keypair_test_missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("relay-keypair.json");

        assert!(!path.exists());
        let kp = load_or_generate(Some(&path));
        assert!(path.exists(), "keypair file should be created");
        assert!(!kp.pubkey_b64().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
