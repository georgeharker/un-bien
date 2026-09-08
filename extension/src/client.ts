/**
 * The client-side slice of un-bien: everything needed to speak the relay +
 * envelope wire from the OWNER end (the role the app plays), without loading
 * the pi extension itself.
 *
 * The transport is role-neutral — `RelayClient`'s hello/challenge/auth
 * handshake is identical for a pi and for an owner; only the key and the
 * control frames differ. Exposing it here is what lets a client be written
 * once instead of ported per language.
 */
export {
  RelayClient,
  RoomAlreadyOpenError,
  type ConnectOptions,
  type RoomMeta,
} from "./transport/relay_client.js"

export {
  ed25519KeypairFromSeed,
  ed25519Sign,
  ed25519Verify,
  generateEd25519Keypair,
  type Ed25519Keypair,
} from "./pairing/crypto.js"

export {
  canonicalizeEd25519PublicKey,
  decodeEd25519PublicKey,
  encodeEd25519PublicKey,
} from "./mesh/encoding.js"

export {
  EVT_KIND,
  RPC_KIND,
  UB_KIND,
  isEnvelopeFrame,
  type EnvelopeMessage,
} from "./session/rpc_envelope.js"

export type { ClientMessage, ServerMessage } from "./protocol/types.js"
