import { requireMachine, connectControlRoom, launchAndWait, waitForRoom, handoffToConnect, requireMachineOrRemote } from "./machine.js"
import { pickRaw } from "./picker.js"
import { Shell } from "./tui.js"

/**
 * `unbien resume-session <machine> [--dir <cwd>] [--filter <text>] [--all] [--name <session-name>]`
 *
 * Resume a stored session on a machine: the launcher daemon lists stored pi
 * sessions (pi's public SessionManager — per-directory or global scope,
 * filtered on name/first-message, sorted by recency), the CLI shows them in a
 * type-to-filter picker, and the chosen session is relaunched via
 * `session_launch {resume: <path>}` — pi reopens the file in a tmux/herdr
 * window and joins the mesh, attachable like any live session.
 */

interface StoredSession {
  path: string
  id: string
  name?: string
  summary: string
  cwd: string
  modified: string
  messageCount: number
}

function relTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime()
  const m = Math.round(delta / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Send `sessions_list`, await the correlated result. */
async function listSessions(
  client: import("./client.js").SessionClient,
  params: { scope: "cwd" | "all"; cwd?: string; filter?: string },
  timeoutMs = 10_000,
): Promise<StoredSession[]> {
  const id = `sl-${Date.now()}`
  return new Promise((resolve) => {
    let settled = false
    function onUb(frame: Record<string, unknown>): void {
      try {
        handle(frame)
      } catch (err) {
        // A malformed frame must not crash the verb mid-wait.
        console.error(`frame handling error (ignored): ${String(err).slice(0, 120)}`)
      }
    }
    function handle(frame: Record<string, unknown>): void {
      if (settled) return
      const type = String(frame.type ?? "")
      if (type === "error") {
        // Daemon gate/launch rejections (unknown_peer, permission_denied…)
        // must reach the user — an empty list would read as "nothing stored".
        settled = true
        client.off("ub", onUb)
        console.error(`machine rejected the listing: ${String(frame.message ?? frame.code)}`)
        resolve([])
        return
      }
      if (type === "sessions_list_result" && frame.in_reply_to === id) {
        settled = true
        client.off("ub", onUb)
        resolve(Array.isArray(frame.sessions) ? (frame.sessions as StoredSession[]) : [])
      }
    }
    // The reply is a ub-FRAMED envelope — SessionClient emits those on
    // "envelope" (raw inner frames land on "control", relay refusals on
    // "relayControl"; both handled above via onError).
    const onEnvelope = (env: { ub?: Record<string, unknown> }) => {
      if (env.ub) onUb(env.ub)
    }
    client.on("envelope", onEnvelope)
    // Errors arrive on TWO other surfaces, both terminal for this request:
    //  - control: the daemon's own error frames (unknown_peer, list_failed…)
    //  - relayControl: relay-level refusals (fail-closed content gate)
    const onError = (frame: Record<string, unknown>) => {
      if (settled) return
      if (String(frame.type ?? "") === "error") {
        settled = true
        client.off("ub", onUb)
        client.off("control", onError)
        client.off("relayControl", onError)
        console.error(
          `machine refused the listing: ${String(frame.code)} — ${String(frame.message ?? "").slice(0, 120)}`,
        )
        resolve([])
      }
    }
    client.on("control", onError)
    client.on("relayControl", onError)
    client.sendUb("sessions_list", { id, ...params })
    setTimeout(() => {
      if (settled) return
      settled = true
      client.off("ub", onUb)
      console.error(
        "no reply from the machine (is the launcher daemon installed and the relay up?)",
      )
      resolve([])
    }, timeoutMs)
  })
}

export async function run(argv: string[]): Promise<void> {
  const flags = new Map<string, string>()
  let target = ""
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dir") flags.set("dir", argv[++i] ?? "")
    else if (a === "--filter") flags.set("filter", argv[++i] ?? "")
    else if (a === "--name") flags.set("name", argv[++i] ?? "")
    else if (a === "--relay") flags.set("relay", argv[++i] ?? "")
    else if (a === "--all") flags.set("all", "1")
    else if (!a.startsWith("--")) target = a
  }

  const machine = await requireMachineOrRemote(target, flags.get("relay"))
  const label = machine.name ?? machine.epk.slice(0, 12)
  const client = await connectControlRoom(machine, machine.relayUrl)

  // Default GLOBAL: bare `resume-session` must not depend on the daemon's
  // cwd (under launchd that's "/", and scoping to it is meaningless — and
  // was crashing the daemon's lister). --dir opts into directory scope.
  const scope: "cwd" | "all" = flags.get("dir") && !flags.get("all") ? "cwd" : "all"
  const cwd = flags.get("dir") || undefined
  const filter = flags.get("filter") || undefined
  console.error(
    `stored sessions on ${label} (${scope === "all" ? "all directories" : cwd ?? "machine cwd"})…`,
  )
  const sessions = await listSessions(client, { scope, cwd, filter })
  if (sessions.length === 0) {
    console.error("no stored sessions matched.")
    Shell.exitAfterDrain(0)
    process.exit(0)
  }

  // Type-to-filter picker, recency order (the daemon sorts). Global scope
  // shows cwd per row — it's the disambiguator there.
  const items = sessions.map((s) => ({
    value: s.path,
    label: `${s.name ?? s.summary.slice(0, 56)} · ${relTime(s.modified)} · ${s.messageCount} msgs`,
    description: scope === "all" ? s.cwd : undefined,
  }))
  // Substring filter over WHAT THE ROWS SHOW (name/summary + cwd) — the
  // SelectList's own setFilter is prefix-on-value (the path), which never
  // matches what a person types.
  const picked = await pickRaw(items, {
    filter: (filter, all) =>
      all.filter((it) => {
        const s = sessions.find((sess) => sess.path === it.value)
        const hay = `${s?.name ?? ""} ${s?.summary ?? ""} ${s?.cwd ?? ""}`.toLowerCase()
        return hay.includes(filter.toLowerCase())
      }),
  })
  if (!picked) {
    console.error("cancelled.")
    Shell.exitAfterDrain(0)
    process.exit(0)
  }
  const chosen = sessions.find((s) => s.path === picked)
  if (!chosen) {
    console.error("picked session vanished — retry.")
    Shell.exitAfterDrain(1)
    process.exit(1)
  }

  const name = flags.get("name") || undefined
  const outcome = await launchAndWait(client, {
    cwd: chosen.cwd || cwd,
    name,
    resume: chosen.path,
  })
  if (!outcome.ok) {
    console.error(`launch rejected: ${outcome.note}`)
    Shell.exitAfterDrain(1)
    process.exit(1)
  }
  console.error(`launched — waiting for the session to go live…`)
  // pi REUSES the session id on resume (it lives in the session file header),
  // so the resumed room is matchable by sessionId deterministically.
  const room = await waitForRoom(client, (r) => r.sessionId === chosen.id)
  if (!room) {
    console.error(
      `the session did not come live within 30s — it may still be starting. ` +
        `Attach later with:\n  unbien connect ${machine.epk.slice(0, 8)} --session ${chosen.id}`,
    )
    Shell.exitAfterDrain(1)
    process.exit(1)
  }
  console.error(`session is live — attaching…`)
  process.exit(await handoffToConnect(machine, chosen.id))
}

await run(process.argv.slice(2))
