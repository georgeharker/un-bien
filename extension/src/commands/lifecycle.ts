/**
 * `/unbien` lifecycle commands: root (connect-or-setup), rootInner, setup
 * wizard, start (relay), stop (teardown), join (local UDS mesh).
 *
 * The heaviest handler lives here: `_cmdStart` touches relay startup, the
 * auto-listener, SelfRevoke topology production, and the first-run model/
 * thinking seeding. Everything it needs from index.ts's module scope comes
 * through `CommandDeps` (see deps.ts). Carved out of index.ts (phase 1 of
 * the index.ts carve-up).
 */
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { SettingsManager } from "@earendil-works/pi-coding-agent"
import {
  conditionalRemovePeer,
  getOrCreateEd25519Keypair,
  KeyringUnavailableError,
  PairedIdentityMissingError,
  snapshotOwnerPubkeys,
} from "../pairing/storage.js"
import { resolveRelayUrl, toWebSocketUrl } from "../config.js"
import { MeshClient } from "../mesh/client.js"
import { SelfRevoke } from "../mesh/self_revoke.js"
import { RelayClient, RoomAlreadyOpenError } from "../transport/relay_client.js"
import {
  defaultAgentName,
  effectiveAutoStartRelay,
  loadLocalConfig,
  localConfigExists,
  piSessionName,
  resolveAgentName,
  saveLocalConfig,
} from "../session/local_config.js"
import { runSetupWizard, type WizardUI } from "../session/setup_wizard.js"
import { acquireCwdLock } from "../session/cwd_lock.js"
import { sessionCapabilities } from "../session/capabilities.js"
import {
  ensureGlobalDirs,
  LOCAL_SESSION_NAME,
  sessionAuditPath,
  sessionSockPath,
  skillsDir,
} from "../session/global_config.js"
import { MeshNode } from "../session/mesh_node.js"
import { ensureModelRegistry } from "../actions/registry.js"
import type { ActionCtx } from "../actions/handlers.js"
import type { ThinkingLevel } from "../protocol/types.js"
import { mkdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import type { CommandDeps } from "./deps.js"
import { _cmdStatus } from "./info.js"

// Coalesces concurrent `/unbien` startup paths inside ONE extension instance.
// Separate Pi processes still keep the existing #N behavior via the cwd lock.
let _cmdRootInFlight: Promise<void> | null = null

export type RootRestartAuthority = Readonly<{
  rootLifecycleGeneration: number
}>

/**
 * Root handler for `/unbien`. On first run (no local config) drops into
 * the wizard; on subsequent runs auto-joins the local mesh + starts the
 * relay (if opted in during setup), then prints the status.
 *
 * `/unbien` is intentionally the only command users need day-to-day:
 * idempotent connect + status display.
 */
export async function _cmdRoot(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
  restartAuthority?: RootRestartAuthority,
): Promise<void> {
  const rootLifecycleGeneration =
    restartAuthority?.rootLifecycleGeneration ?? deps.rootLifecycleGeneration

  if (_cmdRootInFlight) {
    try {
      await _cmdRootInFlight
    } catch (err) {
      // Stale authority stops here. A current normal duplicate preserves the
      // outgoing error, while a current replacement suppresses that old-session
      // failure and falls through to start one fresh root below.
      if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration)) return
      if (!restartAuthority) throw err
    }
    if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration)) return
    if (!restartAuthority) {
      _cmdStatus(deps, ctx)
      return
    }
  }

  if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration)) return

  const run = _cmdRootInner(deps, ctx, rootLifecycleGeneration)
  _cmdRootInFlight = run
  try {
    await run
  } finally {
    if (_cmdRootInFlight === run) _cmdRootInFlight = null
  }
}

export async function _cmdRootInner(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
  rootLifecycleGeneration: number,
): Promise<void> {
  // A root retains its startup epoch through every pre-candidate await. This is
  // stronger than `deps.disposed`, which a same-module session_start intentionally
  // clears while an outgoing continuation may still be pending.
  if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration)) return

  const cwd =
    "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd()
  // Lock identity is (cwd, name). Several agents may run in the SAME folder; the
  // requested name just has to be made unique. Derive the name the same way
  // `_cmdJoin` does so the lock and the mesh registration agree on identity.
  // A session-scoped name (pi -n, set by the remote launcher) beats the
  // configured agent_name so a launched Pi locks/joins under what the app
  // asked for.
  const requestedName = resolveAgentName(cwd, piSessionName(deps.pi))

  // Per-(cwd,name) lock. Interactive agents may coexist by auto-suffixing
  // (`name#2`, `name#3`, …), but supervised daemons must be singletons for their
  // registered cwd/name. If a daemon silently came up as `#2`, the supervisor
  // would report "running" while the mesh had duplicate peers for one repo.
  if (deps.cwdLock === null) {
    const isDaemon = process.env["UNBIEN_DAEMON"] === "1"
    const maxAttempts = isDaemon ? 1 : 1000
    for (let n = 1; n <= maxAttempts; n++) {
      const candidate = n === 1 ? requestedName : `${requestedName}#${n}`
      const result = await acquireCwdLock(cwd, candidate)
      if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration)) {
        if (result.ok) {
          try {
            result.release()
          } catch {
            /* best-effort stale lock cleanup */
          }
        }
        return
      }
      if (result.ok) {
        deps.cwdLock = result
        deps.lockedName = candidate
        break
      }
    }
    if (deps.cwdLock === null) {
      if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration)) return
      ctx.ui.notify(
        process.env["UNBIEN_DAEMON"] === "1"
          ? `[un-bien] Daemon not started: another live agent already owns "${requestedName}" in this folder. Stop the old Pi process, then restart the daemon.`
          : `[un-bien] Could not start: too many agents named "${requestedName}" already running in this folder.`,
        "warning",
      )
      return
    }
  }

  // First-time wizard: no local config in this cwd → run interactive setup.
  if (!localConfigExists(cwd)) {
    // SAFETY: ctx.ui MIGHT carry the wizard's select/input methods (interactive
    // Pi) or not (headless); the `typeof ui.select !== "function"` guard on the
    // next line validates the structural assumption before any method call.
    const ui = ctx.ui as unknown as WizardUI
    if (typeof ui.select !== "function") {
      _cmdStatus(deps, ctx)
      return
    }
    const baseDefault = defaultAgentName(cwd)
    const newConfig = await runSetupWizard(ui, {
      agent_name: baseDefault,
      use_relay: true,
    })
    if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration)) return
    if (!newConfig) {
      ctx.ui.notify("[un-bien] Setup cancelled.", "info")
      return
    }
    saveLocalConfig(cwd, newConfig)
    ctx.ui.notify(
      `[un-bien] Config saved to ${cwd}/.pi/un-bien/config.json`,
      "info",
    )
    if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration)) return
    await _cmdJoin(deps, ctx)
    if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration) || !deps.meshNode)
      return
    if (effectiveAutoStartRelay(newConfig)) await _cmdStart(deps, ctx)
    if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration) || !deps.meshNode)
      return
    _cmdStatus(deps, ctx)
    return
  }

  // Returning user with config: ALWAYS join the local UDS mesh on connect; the
  // relay is the only thing gated by auto_start_relay. So auto_start_relay:false
  // now means "local mesh, no relay" (matching the first-time/wizard path and
  // the field's documented intent) — previously a false flag skipped the mesh
  // join entirely, leaving the agent (incl. daemons) fully idle.
  const config = loadLocalConfig(cwd)
  if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration)) return
  if (!deps.meshNode) await _cmdJoin(deps, ctx)
  // `_cmdJoin` returns void on a canceled/failed join, so recheck both the
  // root lifecycle and publication before bringing the Relay up.
  if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration) || !deps.meshNode)
    return
  if (effectiveAutoStartRelay(config) && deps.state === "idle")
    await _cmdStart(deps, ctx)
  if (!deps.isCurrentRootLifecycle(rootLifecycleGeneration) || !deps.meshNode)
    return
  _cmdStatus(deps, ctx)
}

/**
 * `/unbien setup` — re-run the wizard. Defaults pre-fill from the
 * existing config so it doubles as an "edit" flow.
 */
export async function _cmdSetup(
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
): Promise<void> {
  const cwd =
    "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd()
  // SAFETY: ctx.ui MIGHT carry the wizard's select/input methods (interactive
  // Pi) or not (headless); the `typeof ui.select !== "function"` guard on the
  // next line validates the structural assumption before any method call.
  const ui = ctx.ui as unknown as WizardUI
  if (typeof ui.select !== "function") {
    ctx.ui.notify("[un-bien] Setup requires an interactive UI.", "warning")
    return
  }
  const current = loadLocalConfig(cwd)
  const baseDefault = defaultAgentName(cwd)
  const newConfig = await runSetupWizard(ui, {
    agent_name: current.agent_name ?? baseDefault,
    use_relay: effectiveAutoStartRelay(current),
  })
  if (!newConfig) {
    ctx.ui.notify("[un-bien] Setup cancelled.", "info")
    return
  }
  saveLocalConfig(cwd, newConfig)
  ctx.ui.notify("[un-bien] Config updated. Run /unbien to apply now.", "info")
}

export async function _cmdStart(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
): Promise<void> {
  if (deps.state !== "idle") {
    ctx.ui.notify("[un-bien] Already started.", "warning")
    return
  }
  const lifecycleGeneration = ++deps.relayLifecycleGeneration
  const isCurrentCandidate = (): boolean =>
    !deps.disposed &&
    lifecycleGeneration === deps.relayLifecycleGeneration &&
    deps.state === "idle" &&
    deps.relay === null

  let edKp: Awaited<ReturnType<typeof getOrCreateEd25519Keypair>>
  try {
    edKp = await getOrCreateEd25519Keypair()
  } catch (err) {
    // Identity lookup is part of the candidate lifecycle. A later stop/off or
    // session replacement must silence its stale rejection before any UI or
    // error propagation touches the superseded context.
    if (!isCurrentCandidate()) return
    if (err instanceof KeyringUnavailableError) {
      // The platform keyring (macOS Keychain / Windows Credential Manager) is
      // locked/denied and there's no file identity to fall back to. We refuse
      // to mint a new key (that's what silently broke pairing after idle), so
      // abort cleanly with an actionable message instead of crashing or
      // re-pairing. Unlocking the keychain and re-running fixes it.
      ctx.ui.notify(
        "[un-bien] Could not read this machine's identity: the system " +
          "keychain is locked or access was denied. Unlock it (open the app / " +
          "log in) and run /unbien again. Your pairing is NOT lost. " +
          '(For a headless host, set "identity": { "storage": "file" } in un-bien.json.)',
        "error",
      )
      return
    }
    if (err instanceof PairedIdentityMissingError) {
      // Issues #95/#69: this process can't reach the keyring that holds the
      // paired identity (classically a `systemd --user` daemon vs. the desktop
      // session that paired). Minting a fresh key here would make SelfRevoke
      // wipe peers.json seconds later and take the phone offline, so storage
      // refuses. Surface the actionable fix instead of failing silently.
      ctx.ui.notify(
        "[un-bien] Could not read this machine's identity, but devices are " +
          "already paired — refusing to generate a new one (that would revoke " +
          "them). This process likely cannot reach the same keyring as the " +
          "session that paired (e.g. the unbien-launcher systemd --user service). " +
          "Give the service keyring access, or copy the paired keypair to " +
          "~/.local/state/un-bien/identity.json " +
          "(0600) so both contexts read the same identity.",
        "error",
      )
      return
    }
    throw err
  }
  // Re-check immediately after the first await, before cache/config/model/UI
  // mutation or Relay construction. `deps.disposed` alone is insufficient because
  // same-module session_start intentionally clears it for the replacement.
  if (!isCurrentCandidate()) return
  deps.cachedEd25519 = edKp

  const { url: relayUrl, source } = resolveRelayUrl()
  if (relayUrl === null) {
    ctx.ui.notify(
      "[un-bien] No relay configured — staying on the local mesh only. Set one " +
        "with `/unbien set-relay <url>` (or the UNBIEN_RELAY env var) to connect " +
        "the phone app.",
      "warning",
    )
    return
  }
  const myShort = Buffer.from(edKp.publicKey).toString("base64").slice(0, 8)

  const cwd =
    "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd()
  // Same name we send in pair_ok — keeps room_meta.name and the per-pair
  // session_name aligned so the app shows consistent labels.
  const sessionName = deps.displayName(cwd)
  // design 01M1CAW0 (announce waits for the session id): the App↔Pi room is
  // ALWAYS session-id-derived (rooms.ts). With no session id there is NO room
  // to announce — the retired (cwd, name) fallback produced an id IDENTICAL
  // for same-cwd processes, so a pre-session subprocess could announce the
  // room an earlier session already occupies. Connecting room-less is not an
  // option either: the relay registers a room-less hello into the shared
  // "main" room, which surfaces in the app as a phantom session. So the WHOLE
  // connect is deferred — the root session_start handler re-runs this start
  // once the session id exists (see the relayStartDeferred re-arm in
  // index.ts). The cwd lock (lockIdFor) is unaffected: lock ids are NOT room
  // ids and stay (cwd, name)-keyed by design.
  const roomId = deps.deriveRoomId(cwd, sessionName)
  if (roomId === null) {
    deps.relayStartDeferred = true
    ctx.ui.notify(
      "[un-bien] No session id yet — refusing to announce a cwd-derived room " +
        "(design 01M1CAW0). The relay will connect once this session has started.",
      "warning",
    )
    return
  }

  // Seed the current model from the SDK's resolved selection so room_meta
  // carries it on connect. `model_select` only fires on an explicit set/cycle
  // (NOT on settings load), so a headless daemon that just runs its default
  // model never emits it — without this its room_meta would omit the model and
  // the app shows "unknown". `getModel()` returns the session's resolved model
  // in every mode (interactive + RPC daemon); turn_start hydrates it later if
  // the SDK resolves the model lazily.
  if (!deps.currentModel) {
    try {
      const c = ctx as Partial<ExtensionContext> & {
        model?: { name?: string; id?: string }
        getModel?: () => { name?: string; id?: string } | undefined
      }
      // Prefer the live getModel() / ctx.model — populated for an interactive
      // Pi. For a HEADLESS DAEMON both are undefined at connect: the SDK only
      // resolves `this.model` lazily at the first turn, and `model_select`
      // never fires for a default-model session. So fall back to the CONFIGURED
      // default (defaultProvider/defaultModel in <cwd>/.pi/settings.json) — the
      // model the daemon will actually use. Without this an idle daemon (never
      // prompted → no turn) would never report its model and the app shows
      // "unknown". turn_start still hydrates a later override.
      const live = c.getModel?.() ?? c.model
      if (live) {
        deps.currentModel = live.name ?? live.id ?? undefined
      } else {
        const sm = SettingsManager.create(cwd)
        const provider = sm.getDefaultProvider()
        const modelId = sm.getDefaultModel()
        if (modelId) {
          // SAFETY: ensureModelRegistry only reads modelRegistry/getModel off
          // the ctx; c and the deps.lastEventCtx fallback carry those when
          // present, and it tolerates null.
          const regCtx = (c ?? deps.lastEventCtx) as unknown as ActionCtx | null
          const found = provider
            ? ensureModelRegistry(regCtx).find(provider, modelId)
            : undefined
          deps.currentModel = found?.name ?? modelId
        }
      }
    } catch {
      /* defensive — never block start on a model lookup */
    }
  }

  // Plan/28 Wave D.1: seed thinking from the SDK's current level so the
  // first room_meta hello already carries it. `pi.getThinkingLevel()` is
  // safe at this point — extension factory has been bound by the SDK
  // before any command handler fires. Future toggles go through the
  // `thinking_level_select` event handler above.
  try {
    deps.currentThinking = deps.pi?.getThinkingLevel() as
      ThinkingLevel | undefined
  } catch {
    /* defensive — never block /unbien start on this */
  }

  const roomMeta: {
    name: string
    cwd: string
    model?: string
    thinking?: ThinkingLevel
    sessionId?: string
    caps?: string[]
  } = { name: sessionName, cwd }
  // Advertise session caps on the room announce (design 01M1SJDZ) so the app
  // learns remote_terminate etc. on DISCOVERY — the ub hello only reaches it
  // after attach, so Home's End Chat gating was blind until you opened the
  // chat. Same set as the hello (sessionCapabilities), reused on reconnect via
  // deps.myRoomMeta below.
  roomMeta.caps = sessionCapabilities()
  const modelName = deps.currentModelName()
  if (modelName) roomMeta.model = modelName
  if (deps.currentThinking) roomMeta.thinking = deps.currentThinking
  // The room's OWN pi sessionId on the announce — so the app keys per-session
  // state by the pi id (wire identity), not the routing roomId. roomId stays
  // relay-routing only.
  const rootSid =
    deps.rootState().sessionManager?.getSessionId() ??
    deps.rootSessionId ??
    undefined
  if (rootSid) roomMeta.sessionId = rootSid
  // Persist so _attemptReconnect can replay the same hello payload — without
  // this, reconnect issues a bare hello and the relay creates a "default room"
  // entry that surfaces in the app as a phantom legacy session.
  deps.myRoomMeta = roomMeta

  ctx.ui.notify(
    `[un-bien] Connecting to relay ${relayUrl} (source: ${source}, room: ${roomId})…`,
    "info",
  )

  // Transport opens WebSocket; convert the canonical http(s):// stored
  // form to ws(s):// at this boundary. The relayUrl variable keeps the
  // http(s):// form for logging + mesh client construction below.
  const relay = new RelayClient(toWebSocketUrl(relayUrl), edKp)
  try {
    await relay.connect({ roomId, roomMeta })
  } catch (err) {
    // A rejected local candidate is never published and must always be closed,
    // regardless of whether this lifecycle is still authoritative.
    try {
      relay.close()
    } catch {
      /* best-effort rejected candidate cleanup */
    }
    // A stop, shutdown/replacement, relay-off, or newer start may supersede a
    // candidate before its rejection arrives. Keep the outgoing context silent;
    // only the authoritative attempt may report an error.
    if (!isCurrentCandidate()) return
    if (err instanceof RoomAlreadyOpenError) {
      ctx.ui.notify(
        "[un-bien] Already running in this cwd. Stop the other terminal first.",
        "error",
      )
      return
    }
    ctx.ui.notify(`[un-bien] relay connect failed: ${String(err)}`, "error")
    return
  }

  // The candidate is local until this publication point. Session shutdown,
  // stop/relay-off, or a newer start may have invalidated it while connect()
  // was pending; never let that stale continuation resurrect the Relay.
  if (!isCurrentCandidate()) {
    try {
      relay.close()
    } catch {
      /* best-effort stale candidate cleanup */
    }
    return
  }

  deps.relay = relay
  deps.relayUrl = relayUrl
  deps.peerShort = myShort
  deps.myRoomId = roomId
  deps.state = "started"
  // Set deps.sessionStartedAt ONLY on first /unbien start since process boot.
  // Subsequent start cycles (after stop) preserve the original epoch so the
  // app keeps treating it as the same session (and merges new events from
  // the terminal turns that happened during the idle window). Pi process
  // restart is the only thing that produces a fresh session_started_at.
  if (deps.sessionStartedAt === null) deps.sessionStartedAt = Date.now()
  // _messageBuffer intentionally preserved across stop/start — it accumulates
  // message_end events for the lifetime of the Pi process, including turns
  // initiated from the terminal while the relay was disconnected.

  relay.on("close", () => deps.onRelayClose(relay))

  deps.stopAutoListener = deps.installAutoListener(relay)
  deps.refreshFooter(ctx)

  // SelfRevoke is the Pi path's single initial topology producer. Its first
  // coalesced sweep always publishes verified membership or a safe fallback
  // before the bridge may attach.
  let createdProducer = false
  if (deps.selfRevoke === null) {
    createdProducer = true
    const producerEpoch = ++deps.selfRevokeEpoch
    deps.selfRevokeTopologyReadyEpoch = -1
    deps.selfRevokeTopology = null
    let producer!: SelfRevoke
    producer = new SelfRevoke({
      client: new MeshClient(relayUrl),
      storage: { snapshotOwnerPubkeys, conditionalRemovePeer },
      myPubkey: edKp.publicKey,
      onRevoke: (rawOwnerPubkey, canonicalOwnerPubkey) => {
        if (
          deps.selfRevoke !== producer ||
          producerEpoch !== deps.selfRevokeEpoch
        ) {
          return
        }
        deps.revokeActiveOwnerRuntime(canonicalOwnerPubkey)
        void rawOwnerPubkey // exact storage removal already happened upstream
      },
      onAuthoritativeOwners: (canonicalOwnerPubkeys) => {
        if (
          deps.selfRevoke !== producer ||
          producerEpoch !== deps.selfRevokeEpoch
        ) {
          return
        }
        const presentOwners = new Set(canonicalOwnerPubkeys)
        let effectFailed = false
        for (const canonicalOwnerPubkey of [...deps.activePeers.keys()]) {
          if (
            deps.selfRevoke !== producer ||
            producerEpoch !== deps.selfRevokeEpoch
          ) {
            return
          }
          if (presentOwners.has(canonicalOwnerPubkey)) continue
          try {
            deps.revokeActiveOwnerRuntime(canonicalOwnerPubkey)
          } catch {
            effectFailed = true
          }
        }
        if (effectFailed) throw new Error("Owner runtime reconciliation failed")
      },
      onTopologyChanged: (snapshot) => {
        if (
          deps.selfRevoke !== producer ||
          producerEpoch !== deps.selfRevokeEpoch
        ) {
          return
        }
        deps.selfRevokeTopology = snapshot
        deps.meshNode?.setTopology(snapshot)
        deps.selfRevokeTopologyReadyEpoch = producerEpoch
        deps.attachBridgeIfReady()
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })
    deps.selfRevoke = producer
    producer.start()
    await producer.checkOnce()
    if (
      deps.disposed ||
      deps.selfRevoke !== producer ||
      producerEpoch !== deps.selfRevokeEpoch ||
      deps.relay !== relay
    ) {
      return
    }
  }

  // Relay reconnect reuses the current producer's retained snapshot. Initial
  // startup is callback-driven above, so it must not issue a second attach.
  if (!createdProducer) deps.attachBridgeIfReady()

  deps.emitRelayState() // → connected
  ctx.ui.notify(
    `[un-bien] state: started (peer=${myShort}) — Connected to relay ${relayUrl}`,
    "info",
  )
}

/**
 * `/unbien stop` — full teardown. Leaves the local UDS mesh AND closes
 * the relay. Safe when one or both are already off. To resume, run
 * `/unbien` again.
 */
export async function _cmdStop(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui">,
): Promise<void> {
  // Invalidate queued root work and local async candidates even when none has
  // published yet.
  deps.rootLifecycleGeneration += 1
  deps.meshJoinGeneration += 1
  const meshUp = deps.meshNode !== null
  const relayUp = deps.state !== "idle"
  if (!meshUp && !relayUp) {
    deps.relayLifecycleGeneration += 1
    ctx.ui.notify("[un-bien] Already stopped — nothing to do.", "info")
    return
  }

  // Revoke Relay/SelfRevoke/bridge authority while the global node is still
  // visible and before close() begins UDS leave.
  if (relayUp) {
    deps.goIdle()
  } else {
    deps.relayLifecycleGeneration += 1
    deps.meshNode?.detachBridge()
  }

  const meshNode = deps.meshNode
  deps.meshNode = null
  deps.sessionName = null
  deps.sessionPeerCount = 0
  let meshClose: Promise<void> | null = null
  try {
    meshClose = meshNode?.close() ?? null
  } catch {
    /* best-effort */
  }
  try {
    await meshClose
  } catch {
    /* best-effort */
  }

  ctx.ui.notify("[un-bien] Stopped (mesh + relay disconnected).", "info")
  deps.refreshFooter(ctx)
}

/**
 * Joins the fixed local UDS mesh ("local" session — see LOCAL_SESSION_NAME).
 * Called by `_cmdRoot` on first run and on subsequent runs when the relay
 * is up and the user hasn't explicitly stopped. The session name is no
 * longer user-configurable: every Pi on the same machine joins the same
 * broker.
 */
export async function _cmdJoin(
  deps: CommandDeps,
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
): Promise<void> {
  const cwd =
    "cwd" in ctx ? (ctx as ExtensionCommandContext).cwd : process.cwd()
  const sessionName = LOCAL_SESSION_NAME
  // What the user configured for this agent… (a session-scoped `pi -n` name
  // from a remote launch wins — see resolveAgentName)
  const requestedName = resolveAgentName(cwd, piSessionName(deps.pi))
  // `requestedName` or a `#N` variant when same-named agents share this folder.
  // Falls back to requestedName when join runs without a prior `_cmdRoot` lock
  // (e.g. legacy/test paths).
  const agentName = deps.lockedName ?? requestedName

  if (deps.meshNode) {
    ctx.ui.notify("[un-bien] Already on the local mesh.", "warning")
    return
  }
  const joinGeneration = ++deps.meshJoinGeneration

  ensureGlobalDirs()
  mkdirSync(join(skillsDir(), "..", "sessions", sessionName), {
    recursive: true,
  })

  const sock = sessionSockPath(sessionName)
  const audit = sessionAuditPath(sessionName)
  // Forward the cwd so the broker keys this peer by (cwd, name): a same-folder
  // same-name reincarnation (switch_session re-eval, app restart) takes over the
  // name instead of registering behind a mute `name#N` ghost. Canonicalize via
  // realpath so symlinked cwds map to one identity (matches roomIdForCwd).
  let canonCwd = cwd
  try {
    canonCwd = realpathSync(cwd)
  } catch {
    /* cwd missing — use raw path */
  }
  const peer = new MeshNode({
    sockPath: sock,
    name: agentName,
    cwd: canonCwd,
    auditPath: audit,
    takeoverExisting: process.env["UNBIEN_DAEMON"] === "1",
  })

  peer.onMessage((env) => {
    const body = env.body as { type?: string } | null
    // Broker system events: re-query broker for authoritative count.
    // Incremental ±1 drifts when peer_left is missed (leader leaves cleanly,
    // failover, etc.) — querying list_peers makes the count self-healing.
    if (body && (body.type === "peer_joined" || body.type === "peer_left")) {
      deps.refreshSessionPeerCount(peer, ctx)
      // Plan/25 Wave B: push fresh peer list to all siblings so their
      // remotePeers cache stays current without polling.
      void peer
        .request("broker", { type: "list_peers" }, 2000)
        .then((reply) => {
          const body = reply.body as {
            peers?: string[]
            peers_detailed?: Array<{ pc?: string; address?: string }>
          } | null
          // onLocalPeersChanged wants LOCAL-only addresses (list_peers returns
          // the aggregated local + cross-PC roster). Prefer the structured
          // roster (plan/38): a local peer has no `pc`. This is drive-letter
          // safe — a Windows local address `C:\…@app` contains ':' but is NOT
          // remote, so the old naive `!p.includes(":")` misclassified it.
          let local: string[] | null = null
          const detailed = body?.peers_detailed
          if (Array.isArray(detailed)) {
            local = detailed
              .filter((p) => !p.pc && typeof p.address === "string")
              .map((p) => p.address as string)
          } else if (Array.isArray(body?.peers)) {
            // Fallback for a legacy broker without `peers_detailed`.
            local = body!.peers!.filter((p) => !p.includes(":"))
          }
          // No-op when the bridge isn't up (follower / relay down).
          if (local) peer.onLocalPeersChanged(local)
        })
        .catch(() => {
          /* bridge not bound yet, or list_peers failed */
        })
      return
    }
    if (env.from === "broker") return // other broker control messages — ignore

    // Real agent-to-agent message (SessionPeer already correlated replies via
    // env.re before this point). Show it in the app's TOOL timeline and wake
    // the agent as a CUSTOM message — never as the user's own message.
    deps.deliverMeshMessageToAgent(env)
  })

  // After failover (leader died, we re-elected): the new broker's peers map
  // starts fresh, but our cached `deps.sessionPeerCount` is stale. Re-seed it so
  // surviving peers don't carry the pre-failover count forever.
  //
  // The cross-PC bridge re-attach on failover (drop the stale broker ref,
  // re-wire against the fresh `localBroker()` if we were promoted to leader)
  // is handled INSIDE MeshNode — no manual teardown/ensure needed here.
  peer.onReconnect(() => {
    deps.refreshSessionPeerCount(peer, ctx)
  })

  const isCurrentCandidate = (): boolean =>
    !deps.disposed &&
    joinGeneration === deps.meshJoinGeneration &&
    deps.meshNode === null

  try {
    const assigned = await peer.connect()
    // The candidate stays local until connect resolves. Shutdown, stop, or a
    // newer join invalidates its generation; close it instead of publishing a
    // ghost peer or allowing _cmdRoot to continue into Relay startup.
    if (!isCurrentCandidate()) {
      try {
        await peer.close()
      } catch {
        /* best-effort */
      }
      return
    }
    deps.meshNode = peer
    deps.sessionName = sessionName
    deps.sessionPeerCount = 1 // optimistic — overwritten by list_peers below
    // Broker broadcasts `peer_joined` only to existing peers when a new one
    // arrives — the newcomer doesn't get retroactive joined events. Ask the
    // broker for the live peer list to seed the count correctly on join.
    deps.refreshSessionPeerCount(peer, ctx)
    // Tell RPC clients (e.g. Cockpit) the EFFECTIVE mesh name. The broker
    // appends a `#N` suffix only on a same-(cwd,name) collision, so the name we
    // requested and the one actually assigned can differ. Emit a pure-data event
    // (display:false) carrying both + a `changed` flag so the client can rename
    // the agent in its own UI to match what the mesh/relay will show. Fired on
    // every join (incl. failover re-elect, which can re-assign the name), so the
    // client always reflects the live name, not just the first one.
    //
    // plan/38 decision E: we deliberately DO NOT persist `assigned`. A `#N` is a
    // RUNTIME collision resolution; freezing it into `agent_name` fossilizes an
    // accident and causes cross-folder name ping-pong across restarts. The clean
    // name (wizard / explicit `agent_name`) already lives in config or re-derives
    // from `basename(cwd)`; the event above carries the live `#N` for the UI.
    deps.pi?.sendMessage({
      customType: "un-bien:name-assigned",
      content:
        assigned === requestedName
          ? `Mesh name: ${assigned}`
          : `Mesh name reassigned: "${requestedName}" → "${assigned}" (collision)`,
      details: {
        requested: requestedName,
        assigned,
        changed: assigned !== requestedName,
      },
      display: false,
    })
    ctx.ui.notify(
      `[un-bien] Joined local mesh as "${assigned}" (${peer.currentRole()})`,
      "info",
    )
    deps.refreshFooter(ctx)
    // Plan/25 Wave B/C: try to bring up cross-PC routing now that the
    // local broker exists. No-op if the relay isn't up yet (will fire
    // again from `_cmdStart`).
    deps.attachBridgeIfReady()
  } catch (err) {
    // A replacement/stop/newer join can invalidate this candidate before its
    // failure arrives. Clean it up and never notify the outgoing session ctx.
    if (!isCurrentCandidate()) {
      try {
        await peer.close()
      } catch {
        /* best-effort */
      }
      return
    }
    ctx.ui.notify(`[un-bien] join failed: ${String(err)}`, "error")
  }
}
