import type { MeshNode } from "../session/mesh_node.js"
import type { PlainPeerChannel } from "../transport/peer_channel.js"

/**
 * The seam between index.ts (composition root) and the `/unbien` command
 * modules.
 *
 * index.ts owns every piece of mutable module state and every lifecycle
 * helper the command handlers touch. Command modules MUST NOT import from
 * `../index.js` (that would be a circular import); instead index.ts builds
 * one `CommandDeps` object (accessor closures over its module state plus
 * direct function references) and passes it to `registerUnbienCommands`,
 * which threads it into every handler that needs it.
 *
 * Members are added exactly as the moved code requires them — nothing
 * speculative. Mutable state that commands write is a get/set pair; state
 * they only read is `readonly`.
 */
export interface CommandDeps {
  /** Remote state machine: `idle` → `started` (`paired` is derived). */
  readonly state: "idle" | "started"
  /** Live relay WS connection, null when the relay is off. */
  readonly relayUrl: string | null
  /** Local UDS mesh node, null when not joined. */
  readonly meshNode: MeshNode | null
  /** Authoritative local-mesh peer count (broker `list_peers`). */
  readonly sessionPeerCount: number
  /** Cached "any device is paired machine-wide" flag (peers.json). */
  readonly hasGlobalPairings: boolean
  /** Connected owner channels, keyed by canonical owner pubkey. */
  readonly activePeers: Map<string, PlainPeerChannel>
}
