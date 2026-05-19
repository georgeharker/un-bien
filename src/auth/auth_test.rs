use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signer as _, SigningKey};

use super::challenge::{gen_nonce, parse_hello, verify_auth, AuthError};

/// First message is not "hello" → NoHello error.
#[test]
fn sem_hello() {
    // Send an "auth" message before any hello
    let line = r#"{"type":"auth","sig":"AAAA"}"#;
    let err = parse_hello(line).unwrap_err();
    assert!(matches!(err, AuthError::NoHello));
}

/// Valid key pair but signature covers wrong bytes → InvalidSig.
#[test]
fn sig_invalida() {
    let (nonce, _) = gen_nonce();
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let vk = sk.verifying_key();

    // Sign something other than the nonce
    let wrong_sig = sk.sign(b"not the nonce");
    let sig_b64 = B64.encode(wrong_sig.to_bytes());
    let line = format!(r#"{{"type":"auth","sig":"{}"}}"#, sig_b64);

    let err = verify_auth(&nonce, &vk, &line).unwrap_err();
    assert!(matches!(err, AuthError::InvalidSig));
}

/// Valid key pair, signature covers the correct nonce bytes → success.
#[test]
fn sig_valida() {
    let (nonce, _) = gen_nonce();
    let sk = SigningKey::generate(&mut rand::thread_rng());
    let vk = sk.verifying_key();

    let sig = sk.sign(&nonce);
    let sig_b64 = B64.encode(sig.to_bytes());
    let line = format!(r#"{{"type":"auth","sig":"{}"}}"#, sig_b64);

    verify_auth(&nonce, &vk, &line).unwrap();
}
