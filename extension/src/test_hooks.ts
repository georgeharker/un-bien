/**
 * Test-only hooks for index.ts.
 *
 * The `_xForTest` surface (state readers/mutators + lifecycle shortcuts the
 * integration tests drive) lives here, behind a factory seam: index.ts builds
 * one `TestHooksDeps` (accessor closures over its module state + function
 * references) and re-exports each hook under its EXACT original name, so every
 * existing `import { _xForTest } from "../index.js"` keeps working unchanged.
 *
 * This module MUST NOT import `../index.js` (circular import). The `/unbien`
 * join/start/stop shortcuts reuse the command seam directly
 * (`./commands/lifecycle.js` + the `CommandDeps` object index.ts builds).
 *
 * NOT here: `_runTestScenario` / `_emitTestBus` — those are the e2e UI-test
 * harness driven by the `test` completion, not test-only hooks.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Ed25519Keypair } from "./pairing/crypto.js"
import type { SelfRevoke } from "./mesh/self_revoke.js"
import type { MeshNode } from "./session/mesh_node.js"
import type { AcquiredLock } from "./session/cwd_lock.js"
import type { PlainPeerChannel } from "./transport/peer_channel.js"
import type { PanelBridge } from "./panel_bridge.js"
import type { ExtensionUiBridge } from "./extension_ui_bridge.js"
import type { SubagentRoomsController } from "./subagent_rooms.js"
import type { CommandDeps } from "./commands/deps.js"
import { _cmdJoin, _cmdStart, _cmdStop } from "./commands/lifecycle.js"

/**
 * Structural mirror of index.ts's local `MeshEnvelope` (mesh delivery frame).
 * Kept local so this module never imports the composition root.
 */
type MeshEnvelope = {
  id: string
  from: string
  re: string | null
  body: unknown
}

/**
 * The seam between index.ts (composition root) and the test-only hooks.
 *
 * Same shape as `CommandDeps`: index.ts owns every piece of mutable module
 * state the hooks touch; this module reaches it only through accessor
 * closures / function references on this object. Members are added exactly as
 * the moved code requires them — nothing speculative. Write-only state is a
 * bare `set`; read-only state is `readonly`.
 */
export interface TestHooksDeps {
  /** The `/unbien` command seam index.ts builds (join/start/stop reuse it). */
  readonly commandDeps: CommandDeps

  // ── Mutable module state (accessor closures over index.ts's variables) ──

  /** Set by session_shutdown; blocks outgoing candidates until rearm. */
  set disposed(value: boolean)
  /** Once-per-session auto-init gate. */
  set autoInited(value: boolean)
  /** Panel/ui bridge singletons — reset disposes + nulls each. */
  get panelBridge(): PanelBridge | null
  set panelBridge(value: PanelBridge | null)
  get rpcEnvelope(): { dispose(): void } | null
  set rpcEnvelope(value: { dispose(): void } | null)
  get subagentRooms(): SubagentRoomsController | null
  set subagentRooms(value: SubagentRoomsController | null)
  get extensionUiBridge(): ExtensionUiBridge | null
  set extensionUiBridge(value: ExtensionUiBridge | null)
  /** Root session id — cleared with the per-session state map. */
  set rootSessionId(value: string | null)
  /** Relay start deferred pending a session id (design 01M1CAW0). */
  set relayStartDeferred(value: boolean)
  /** Per-(cwd,name) singleton lock backing the mesh registration. */
  get cwdLock(): AcquiredLock | null
  set cwdLock(value: AcquiredLock | null)
  /** Name the cwd-lock actually reserved (`name` or `name#N`). */
  get lockedName(): string | null
  set lockedName(value: string | null)
  /** Epoch ms the state machine entered 'started'. */
  set sessionStartedAt(value: number | null)
  /** Last-known model name (root session projection). */
  set currentModel(value: string | undefined)
  /** The ROOT session's ExtensionAPI (never a subagent child's). */
  set pi(value: ExtensionAPI | null)

  // ── Read-only state ──────────────────────────────────────────────────────

  /** globalThis slot key for the root-session bridge ownership claim. */
  readonly rootSessionOwnerKey: symbol
  /** Keyed per-session state map — reset clears it at test boundaries. */
  readonly sessions: { clear(): void }
  /** Local UDS mesh node, null when not joined. */
  readonly meshNode: MeshNode | null
  /** SelfRevoke topology producer for the relay path. */
  readonly selfRevoke: SelfRevoke | null
  /** Cached Ed25519 identity of this connect cycle. */
  readonly cachedEd25519: Ed25519Keypair | null
  /** Reconnect backoff timer, null when none is scheduled. */
  readonly reconnectTimer: ReturnType<typeof setTimeout> | null
  /** Connected owner channels, keyed by canonical owner pubkey. */
  readonly activePeers: ReadonlyMap<string, PlainPeerChannel>

  // ── Helpers (direct function references from index.ts) ──────────────────

  /** The ROOT session's state record (turnId for cancel routing). */
  rootState(): { turnId: string | null }
  /** Seed the ROOT session record + id (test-only session emulation). */
  seedRootSession(sid: string): void
  /** Queue an inbound mesh message for agent delivery. */
  deliverMeshMessageToAgent(env: MeshEnvelope): void
}

/** The hooks `createTestHooks` returns (re-exported 1:1 by index.ts). */
export interface TestHooks {
  /** Test-only: emulate what `/unbien` does on the returning-user path
   *  (join the local mesh, then start the relay) without touching the FS for
   *  a `localConfigExists()` lookup. Lets tests bring the relay up without
   *  mocking the wizard or the local config storage.
   *
   * Typed loosely to accept any ctx shape with `ui.notify` + `cwd` — the
   * unit tests use minimal mocks that don't satisfy the full
   * `ExtensionContext` interface. */
  connectForTest(ctx: unknown): Promise<void>
  /** Test-only: tear everything down (mirrors `/unbien stop`). */
  stopForTest(ctx: unknown): Promise<void>
  /** Test-only: read the `_disposed` flag. Production clears it only when
   *  a host reuses this module for a replacement session; tests share one module
   *  across cases, so they also reset it to avoid cross-test pollution. */
  getDisposedForTest(): boolean
  /** Test-only: write the `_disposed` flag (see getDisposedForTest). */
  setDisposedForTest(v: boolean): void
  /** Test-only: reset the once-per-session auto-init gate so session_start re-runs it. */
  resetAutoInitedForTest(): void
  /** Test-only: clear the globalThis panel/ui bridge ownership so each fresh
   *  `extension(pi)` in a shared test process can (re)claim and rebuild bridges. */
  resetBridgeOwnersForTest(): void
  /** Test-only: reset the keyed per-session state at a TEST BOUNDARY (beforeEach).
   *  Must NOT be folded into resetBridgeOwnersForTest — that fires mid-test on
   *  every captureEventHandler call and would wipe state a test seeds across two
   *  captures (e.g. input seeds turnId, message_update reads it). Also clears a
   *  deferred relay start (design 01M1CAW0) so a pending announce never leaks
   *  across tests. */
  resetSessionsForTest(): void
  /** Test-only: seed the ROOT session (id + sessionManager record) so
   *  `_deriveRoomId` has a session id — production always has one by the time
   *  `/unbien` runs (design 01M1CAW0: no room announce without it). Tests of
   *  the pre-id refusal simply skip this (or call resetSessionsForTest). */
  seedRootSessionForTest(sid?: string): void
  /** Test-only: set the auto-init gate for lifecycle replacement tests. */
  setAutoInitedForTest(value: boolean): void
  /** Test-only: true when this instance holds a live local-mesh node. */
  hasMeshNodeForTest(): boolean
  /** Test-only: drive the current real SelfRevoke producer through one sweep. */
  checkSelfRevokeForTest(): Promise<void>
  /** Test-only: the effective (possibly `#N`-suffixed) name the cwd-lock reserved. */
  getLockedNameForTest(): string | null
  /** Test-only: release + clear the cwd lock (the lock normally survives stop). */
  resetCwdLockForTest(): void
  /** Test-only: relay-only startup, no UDS mesh join. Replaces the old
   *  `unbien relay start` handler that some tests captured to bring up
   *  the relay in isolation (e.g. ping/pong tests that don't care about
   *  the agent-network broker). */
  startRelayForTest(ctx: unknown): Promise<void>
  /** Test-only: public marker for canceled-keypair cache regression checks. */
  getCachedPublicKeyForTest(): string | null
  /** Test-only override of session started timestamp. */
  setSessionStartedAtForTest(ts: number | null): void
  /** Test-only: reset the cached model name (between tests). */
  setCurrentModelForTest(name: string | undefined): void
  /** Test-only: read the active turn id used for plain `cancel` routing. */
  getCurrentTurnIdForTest(): string | null
  /** Test-only: override the bound AgentSession so a spy can capture the
   *  content handed to `sendUserMessage` (plan/30 multimodal ingest). */
  setPiForTest(pi: unknown): void
  /** Test-only: exposes pending reconnect timer state. */
  hasPendingReconnect(): boolean
  /** Test-only: number of owners currently attached via PlainPeerChannel. */
  getActivePeerCountForTest(): number
  /** Test-only: true if a specific peer (base64 std) has an attached channel. */
  hasActivePeerForTest(appPeerIdStd: string): boolean
  /** Test-only entry point for verifying mesh-to-agent delivery semantics. */
  deliverMeshMessageToAgentForTest(env: MeshEnvelope): void
}

/** Build the test-hook surface over index.ts's state + helpers. */
export function createTestHooks(deps: TestHooksDeps): TestHooks {
  return {
    async connectForTest(ctx: unknown): Promise<void> {
      const real = ctx as Parameters<typeof _cmdJoin>[1]
      await _cmdJoin(deps.commandDeps, real)
      await _cmdStart(deps.commandDeps, real)
    },

    async stopForTest(ctx: unknown): Promise<void> {
      await _cmdStop(deps.commandDeps, ctx as Parameters<typeof _cmdStop>[1])
    },

    getDisposedForTest(): boolean {
      return deps.disposed
    },

    setDisposedForTest(v: boolean): void {
      deps.disposed = v
    },

    resetAutoInitedForTest(): void {
      deps.autoInited = false
    },

    resetBridgeOwnersForTest(): void {
      const g = globalThis as typeof globalThis &
        Record<symbol, ExtensionAPI | undefined>
      delete g[deps.rootSessionOwnerKey]
      deps.panelBridge?.dispose()
      deps.panelBridge = null
      deps.rpcEnvelope?.dispose()
      deps.rpcEnvelope = null
      deps.subagentRooms?.dispose()
      deps.subagentRooms = null
      deps.extensionUiBridge?.dispose()
      deps.extensionUiBridge = null
    },

    resetSessionsForTest(): void {
      deps.sessions.clear()
      deps.rootSessionId = null
      deps.relayStartDeferred = false
    },

    seedRootSessionForTest(sid = "test-root-session"): void {
      deps.seedRootSession(sid)
    },

    setAutoInitedForTest(value: boolean): void {
      deps.autoInited = value
    },

    hasMeshNodeForTest(): boolean {
      return deps.meshNode !== null
    },

    async checkSelfRevokeForTest(): Promise<void> {
      await deps.selfRevoke?.checkOnce()
    },

    getLockedNameForTest(): string | null {
      return deps.lockedName
    },

    resetCwdLockForTest(): void {
      try {
        deps.cwdLock?.release()
      } catch {
        /* ignored */
      }
      deps.cwdLock = null
      deps.lockedName = null
    },

    async startRelayForTest(ctx: unknown): Promise<void> {
      await _cmdStart(deps.commandDeps, ctx as Parameters<typeof _cmdStart>[1])
    },

    getCachedPublicKeyForTest(): string | null {
      return deps.cachedEd25519
        ? Buffer.from(deps.cachedEd25519.publicKey).toString("base64")
        : null
    },

    setSessionStartedAtForTest(ts: number | null): void {
      deps.sessionStartedAt = ts
    },

    setCurrentModelForTest(name: string | undefined): void {
      deps.currentModel = name
    },

    getCurrentTurnIdForTest(): string | null {
      return deps.rootState().turnId
    },

    setPiForTest(pi: unknown): void {
      deps.pi = pi as ExtensionAPI | null
    },

    hasPendingReconnect(): boolean {
      return deps.reconnectTimer !== null
    },

    getActivePeerCountForTest(): number {
      return deps.activePeers.size
    },

    hasActivePeerForTest(appPeerIdStd: string): boolean {
      return deps.activePeers.has(appPeerIdStd)
    },

    deliverMeshMessageToAgentForTest(env: MeshEnvelope): void {
      deps.deliverMeshMessageToAgent(env)
    },
  }
}
