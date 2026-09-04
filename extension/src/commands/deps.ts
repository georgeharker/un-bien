import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type { Ed25519Keypair } from "../pairing/crypto.js"
import type { SelfRevoke } from "../mesh/self_revoke.js"
import type { MeshTopologySnapshot } from "../mesh/siblings.js"
import type { Envelope } from "../session/envelope.js"
import type { MeshNode } from "../session/mesh_node.js"
import type { AcquiredLock } from "../session/cwd_lock.js"
import type { RelayClient } from "../transport/relay_client.js"
import type { PlainPeerChannel } from "../transport/peer_channel.js"
import type { ThinkingLevel } from "../protocol/types.js"

/** App↔Pi room meta projected by the ROOT session (see index.ts `_myRoomMeta`). */
export type RoomMeta = {
  name: string
  cwd: string
  model?: string
  thinking?: ThinkingLevel
  working?: boolean
  sessionId?: string
}

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
  // ── Mutable module state (accessor closures over index.ts's variables) ──

  /** Remote state machine: `idle` → `started` (`paired` is derived). */
  state: "idle" | "started"
  /** Live relay WS connection, null when off. */
  relay: RelayClient | null
  /** URL used by the current relay connection (http(s):// canonical form). */
  relayUrl: string | null
  /** Local UDS mesh node, null when not joined. */
  meshNode: MeshNode | null
  /** Mesh session name (LOCAL_SESSION_NAME once joined). */
  sessionName: string | null
  /** Authoritative local-mesh peer count (broker `list_peers`). */
  sessionPeerCount: number
  /** Cached Ed25519 identity of this connect cycle. */
  cachedEd25519: Ed25519Keypair | null
  /** Last-known model name (root session projection). */
  currentModel: string | undefined
  /** Last-known thinking level (root session projection). */
  currentThinking: ThinkingLevel | undefined
  /** THE App↔Pi room id for the current chat session. */
  myRoomId: string | null
  /** Room meta hello payload persisted for reconnect replay. */
  myRoomMeta: RoomMeta | null
  /** Shortid of the most recently attached peer (UX hint only). */
  peerShort: string
  /** Epoch of this Pi process's session (stamped on first start). */
  sessionStartedAt: number | null
  /** Per-(cwd,name) singleton lock backing the mesh registration. */
  cwdLock: AcquiredLock | null
  /** Name the cwd-lock actually reserved (`name` or `name#N`). */
  lockedName: string | null
  /** Relay candidate generation (invalidates in-flight starts/stops). */
  relayLifecycleGeneration: number
  /** True when a relay start was deferred because no session id existed yet
   *  (design 01M1CAW0); the root session_start re-runs the start once the id
   *  is available. */
  relayStartDeferred: boolean
  /** Root replacement authority epoch (session replacements). */
  rootLifecycleGeneration: number
  /** Mesh join candidate generation. */
  meshJoinGeneration: number
  /** SelfRevoke topology producer for the relay path. */
  selfRevoke: SelfRevoke | null
  /** Epoch guarding the SelfRevoke producer identity. */
  selfRevokeEpoch: number
  /** Producer epoch that last published a verified topology. */
  selfRevokeTopologyReadyEpoch: number
  /** Last topology snapshot published by the producer. */
  selfRevokeTopology: MeshTopologySnapshot | null
  /** Auto-listener dispose fn for the current relay connection. */
  stopAutoListener: (() => void) | null

  // ── Read-only state ──────────────────────────────────────────────────────

  /** Cached "any device is paired machine-wide" flag (peers.json). */
  readonly hasGlobalPairings: boolean
  /** Connected owner channels, keyed by canonical owner pubkey. */
  readonly activePeers: Map<string, PlainPeerChannel>
  /** Set by session_shutdown; blocks outgoing candidates until rearm. */
  readonly disposed: boolean
  /** Always-fresh session_start ctx (model/registry fallback). */
  readonly lastEventCtx: Pick<
    ExtensionContext,
    "compact" | "abort" | "ui"
  > | null
  /** The ROOT session's ExtensionAPI (never a subagent child's). */
  readonly pi: ExtensionAPI | null
  /** The root session's pi sessionId, null pre-sessionManager. */
  readonly rootSessionId: string | null

  // ── Lifecycle helpers (direct function references from index.ts) ────────

  /** True while `generation` is the current root lifecycle epoch. */
  isCurrentRootLifecycle(generation: number): boolean
  /** Friendly (configured or derived) agent name for a cwd. */
  displayName(cwd: string): string
  /** Room id for the current chat session, derived from the stable pi
   *  session id — or null when no session id exists yet, in which case the
   *  caller must NOT announce/join a room (design 01M1CAW0; the cwd-derived
   *  fallback is retired). */
  deriveRoomId(cwd: string, name: string): string | null
  /** Friendly model name for room_meta. */
  currentModelName(): string | undefined
  /** The ROOT session's state record (turn/agentRun/sessionManager). */
  rootState(): {
    sessionManager?: { getSessionId(): string } | null
  }
  /** Full teardown of relay-side state (relay off, bridge detached). */
  goIdle(): void
  /** Reconnect backoff entry for a closed relay. */
  onRelayClose(closedRelay: RelayClient): void
  /** Attach the pair_request auto-listener to a live relay. */
  installAutoListener(relay: RelayClient): () => void
  /** Repaint the footer status line from current state. */
  refreshFooter(
    ctx?: { ui?: { setStatus?: unknown; setTitle?: unknown } } | null,
  ): void
  /** Tear down an owner's live channel + report the revocation. */
  revokeActiveOwnerRuntime(canonicalOwnerPubkey: string): void
  /** Attach the cross-PC bridge once relay + leader are both up. */
  attachBridgeIfReady(): void
  /** Broadcast relay connectivity state to RPC clients. */
  emitRelayState(force?: boolean): void
  /** Re-query the broker for the authoritative local peer count. */
  refreshSessionPeerCount(
    peer: MeshNode,
    ctx?: Pick<ExtensionContext, "ui"> | null,
  ): void
  /** Queue an inbound mesh message for agent delivery. */
  deliverMeshMessageToAgent(env: Envelope): void
  /** Reads peers.json and refreshes the global-pairings cache + footer. */
  refreshPairingsCache(): void
  /** Tear down a connected owner's channel (revoke / disconnect). */
  detachPeerChannel(appPeerId: string): void
  /** RPC control channel verbs (`relay:toggle` / `relay:on` / `relay:off`). */
  handleControl(cmd: string): Promise<void>
  /** Relay connectivity label for status output. */
  relayStatus(): "connected" | "reconnecting" | "disconnected"
  /** Test-visible state: `idle` | `started` | derived `paired`. */
  getState(): "idle" | "started" | "paired"
  /** Hidden dev-only e2e UI harness (`/unbien test <scenario>`). */
  runTestScenario(scenario: string): string
  /** ctx.ui.notify that never throws (stale-ctx safe). */
  safeNotify(
    message: string,
    level?: "info" | "warning" | "error",
    preferred?: { ui?: unknown } | null,
  ): void
  /** Rename this agent (mesh + relay room) — `/unbien rename`. */
  renameAgent(newName: string): Promise<void>
}
