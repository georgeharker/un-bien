use serde::{Deserialize, Serialize};

/// Wire format that clients POST and that the relay returns on GET.
/// `blob` and `sig` are base64 STANDARD strings on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshEnvelopeWire {
    pub blob: String,
    pub sig: String,
}

/// Decoded envelope after base64-decoding the wire fields.
/// The `blob` bytes are the canonical-JSON payload that was signed;
/// the relay never re-canonicalizes — it only verifies the bytes received.
#[derive(Debug, Clone)]
pub struct MeshEnvelope {
    pub blob: Vec<u8>,
    pub sig: Vec<u8>,
}

/// Header extracted from `blob` JSON. Members and other fields exist in the
/// blob but are NOT inspected by the relay — only `version` and `owner_pk`
/// are needed for verification + storage.
#[derive(Debug, Deserialize)]
pub struct MeshHeader {
    pub version: u64,
    pub owner_pk: String, // base64 STANDARD
}

/// Stored row returned by `MeshStore::get`.
#[derive(Debug, Clone)]
pub struct MeshRecord {
    pub version: u64,
    pub blob: Vec<u8>,
    pub sig: Vec<u8>,
    pub updated_at: i64,
}

/// JSON body returned on `POST /mesh/:hash` success.
#[derive(Debug, Serialize)]
pub struct PostResponse {
    pub version: u64,
    pub updated_at: i64,
}

/// JSON body returned on `GET /mesh/:hash` success.
#[derive(Debug, Serialize)]
pub struct GetResponse {
    pub blob: String, // base64
    pub sig: String,  // base64
    pub version: u64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct GetQuery {
    pub since: Option<u64>,
}
