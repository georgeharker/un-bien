// Tipos ainda não usados no handler — serão conectados no próximo passo
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OuterEnvelope {
    pub peer: String,
    pub ct: String, // base64 — nunca decodificado aqui
}

// 1 MiB do payload base64-decoded. Relay não precisa conhecer o tamanho
// exato do inner — só protege o duto de payloads abusivos.
pub const MAX_CT_BYTES: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("invalid json: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("payload too large: {0} bytes (max {1})")]
    TooLarge(usize, usize),
}

/// Parseia uma linha JSONL no outer envelope e valida o tamanho de `ct`.
/// Nunca decodifica o conteúdo de `ct` — apenas mede o comprimento da string
/// base64 para estimar o tamanho do payload (3/4 do len base64).
pub fn parse_line(line: &str) -> Result<OuterEnvelope, ParseError> {
    let env: OuterEnvelope = serde_json::from_str(line)?;
    let estimated = env.ct.len() * 3 / 4;
    if estimated > MAX_CT_BYTES {
        return Err(ParseError::TooLarge(estimated, MAX_CT_BYTES));
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_envelope() {
        let line = r#"{"peer":"abc","ct":"AAA="}"#;
        let env = parse_line(line).unwrap();
        assert_eq!(env.peer, "abc");
        assert_eq!(env.ct, "AAA=");
    }

    #[test]
    fn rejects_too_large() {
        let big = "A".repeat(2 * 1024 * 1024);
        let line = format!(r#"{{"peer":"abc","ct":"{}"}}"#, big);
        assert!(matches!(parse_line(&line), Err(ParseError::TooLarge(..))));
    }

    #[test]
    fn rejects_invalid_json() {
        assert!(matches!(
            parse_line("not json at all"),
            Err(ParseError::InvalidJson(_))
        ));
    }
}
