/**
 * The durable-host subpath (`@geohar/un-bien/durable`): the versioned import
 * surface for unbien-durable (the pi-durable Harness host). The raw `./dist/*`
 * exports hole let any consumer reach ANY internal module — a private-by-
 * convention tree exposed as public API. This barrel replaces it: unbien-durable
 * consumes exactly these named re-exports, and everything else in dist/ is
 * unreachable through the exports map again.
 *
 * What's here is not a "best of" — it's precisely what unbien-durable imports
 * today (transport, pairing, mesh, the shared rpc dispatch). If the durable
 * host needs another internal module, the fix is a named re-export HERE (and a
 * version bump), not a path import.
 */
export { loadConfig, toWebSocketUrl } from "./config.js"
export { roomIdForSession } from "./rooms.js"
export type {
  ClientMessage,
  PairErrorCode,
  ServerMessage,
} from "./protocol/types.js"

// ── Pairing ──────────────────────────────────────────────────────────────────
export type { Ed25519Keypair } from "./pairing/crypto.js"
export { generateEd25519Keypair } from "./pairing/crypto.js"
export type { KeyStoreBackend } from "./pairing/storage.js"
export {
  _setKeyStoreBackendForTest,
  _setKeyringExpectedForTest,
  _setKeyringRetryForTest,
  addPeer,
  getOrCreateEd25519Keypair,
  listPeers,
  nextAllowListVersion,
  pairingAllowList,
} from "./pairing/storage.js"
export { buildSignedAllowList } from "./pairing/signed_allow_list.js"
export {
  TOKEN_TTL_MS,
  buildQRUri,
  qrSession,
  renderQRAscii,
} from "./pairing/qr.js"
export { _findKnownPeer } from "./pairing/peer_trust.js"

// ── Mesh + session ──────────────────────────────────────────────────────────
export { sessionCapabilities } from "./session/capabilities.js"
export {
  LOCAL_SESSION_NAME,
  ensureGlobalDirs,
  sessionSockPath,
} from "./session/global_config.js"
export { MeshInbox } from "./session/mesh_inbox.js"
export { MeshNode } from "./session/mesh_node.js"
export type { SessionPeer } from "./session/peer.js"

// ── Shared rpc dispatch (the app sees the same traffic as a pi session) ──────
export {
  createRpcEnvelope,
  helloEnvelope,
  isEnvelopeFrame,
  type EnvelopeMessage,
} from "./session/rpc_envelope.js"
export { dispatchRpcCommand } from "./session/rpc_inbound.js"
export {
  createRpcHandlers,
  type RpcHandlersDeps,
} from "./session/rpc_handlers.js"

// ── Local config (the durable host honors the same opt-outs it advertises) ────
// The shared sessionCapabilities() already gates the advertised
// remote_terminate/remote_launch caps on these; the durable bridge's inbound
// gates read them too, so the advertised set and honored behavior can't drift.
export {
  effectiveAllowRemoteTerminate,
  loadLocalConfig,
} from "./session/local_config.js"

// ── Transport ────────────────────────────────────────────────────────────────
export { PlainPeerChannel } from "./transport/peer_channel.js"
export { RelayClient } from "./transport/relay_client.js"