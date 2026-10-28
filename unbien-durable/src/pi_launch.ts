/**
 * Durable binding's HeadlessLaunchPort implementation: the launch-wait-quit
 * primitive behind the `launch_pi_task` tool — the ONE place the two
 * bindings meet at runtime.
 *
 * Launch path: the pi SDK's headless `createAgentSession` (the programmatic
 * equivalent of `pi` without a TUI — NOT `pi -p`, whose print-mode exit the
 * un-bien extension deliberately never auto-starts the relay in). The session
 * loads its extensions through pi's own resource discovery from the target
 * cwd (installed pi-packages, `<cwd>/.pi/extensions`, `<agentDir>`), so the
 * un-bien pi extension must be discoverable there — when it is, its
 * session_start auto-init joins the UDS mesh under the session's display
 * name, which is the SCOPED name minted per invocation.
 *
 * Readiness: the local UDS broker is probed (observer probe — never
 * registers, never perturbs the roster) until the scoped name appears as a
 * peer address; that address is the agent_send routing key for the task.
 *
 * Teardown: `session.dispose()` — the un-bien extension's session_shutdown
 * handler leaves the mesh and closes the relay, exactly as it does for a
 * quitting interactive pi.
 */
import {
  createAgentSession,
  type AgentSession,
} from "@earendil-works/pi-coding-agent"
import type {
  HeadlessLaunchPort,
  HeadlessLaunchedSession,
} from "@geohar/un-bien/core"
import {
  probeListPeers,
} from "@geohar/un-bien"
import {
  LOCAL_SESSION_NAME,
  sessionSockPath,
} from "@geohar/un-bien/dist/session/global_config.js"

/** Default readiness deadline: the launched session's auto-init does a cwd
 *  lock + config read + UDS broker join before the name is visible. */
const DEFAULT_READY_TIMEOUT_MS = 60_000
const READY_POLL_INTERVAL_MS = 250

export class HeadlessPiLaunch implements HeadlessLaunchPort {
  async launchHeadless(opts: {
    cwd: string
    name: string
  }): Promise<HeadlessLaunchedSession> {
    const { session } = await createAgentSession({ cwd: opts.cwd })
    return new HeadlessPiSession(session, opts.name)
  }
}

export class HeadlessPiSession implements HeadlessLaunchedSession {
  constructor(
    private readonly session: AgentSession,
    readonly name: string,
  ) {}

  /** join-mesh-under-name: bind the scoped name, then bring the un-bien
   *  extension up. `bindExtensions` fires session_start; the extension's
   *  auto-init resolves the mesh name from the session display name (set
   *  FIRST so the join sees it) and connects the broker. */
  async joinMeshUnderName(): Promise<void> {
    this.session.setSessionName(this.name)
    await this.session.bindExtensions({})
  }

  /** await-ready: poll the broker's observer probe until the scoped name is
   *  a registered peer. Resolves with the broker-assigned address (the name
   *  may carry a `#N` collision suffix the broker added). */
  async awaitReady(opts?: {
    timeoutMs?: number
  }): Promise<{ address: string }> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const probe = await probeListPeers(
        sessionSockPath(LOCAL_SESSION_NAME),
        2_000,
      )
      if (probe.status === "ok") {
        const match = probe.detailed.find(
          (entry) =>
            entry.name === this.name ||
            entry.name.startsWith(`${this.name}#`),
        )
        if (match) return { address: match.address }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `launched pi session "${this.name}" did not join the mesh within ` +
            `${timeoutMs}ms — the un-bien extension must be discoverable by ` +
            `pi from the target cwd (installed pi-package or .pi/extensions) ` +
            `and that cwd needs a un-bien local config (auto_start_relay)`,
        )
      }
      await new Promise((resolve) =>
        setTimeout(resolve, READY_POLL_INTERVAL_MS),
      )
    }
  }

  /** tear-down: quit gracefully (extension disposal leaves the mesh). */
  async tearDown(): Promise<void> {
    try {
      this.session.dispose()
    } catch {
      /* best-effort — dispose must not throw even mid-run */
    }
  }
}