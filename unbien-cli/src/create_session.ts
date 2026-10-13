import { loadPeers } from "./store.js"
import { connectControlRoom, launchAndWait, waitForRoom, handoffToConnect, requireMachineOrRemote } from "./machine.js"
import { Shell } from "./tui.js"

/**
 * `unbien create-session <machine> [--dir <cwd>] [--name <session-name>]`
 *
 * Creates a NEW pi session on an idle machine: sends `ub.session_launch` to
 * that machine's control room, where the launcher daemon (remote_launch cap)
 * spawns a pi window via tmux/herdr — the same path the app's LaunchSessionSheet
 * uses. No live pi needs to be running; the daemon is the whole story.
 *
 * The new session joins the mesh once pi starts (same announce path as any
 * launch), so it shows up in `unbien connect --list` and the app — attach is
 * a separate, normal connect.
 */

export async function run(argv: string[]): Promise<void> {
  const flags = new Map<string, string>()
  let target = ""
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dir") flags.set("dir", argv[++i] ?? "")
    else if (a === "--name") flags.set("name", argv[++i] ?? "")
    else if (a === "--relay") flags.set("relay", argv[++i] ?? "")
    else if (!a.startsWith("--")) target = a
  }

  if (loadPeers().length === 0) {
    console.error(
      "no paired machines yet — run `/unbien pair` in a session, then `unbien connect '<invite>'`",
    )
    Shell.exitAfterDrain(1)
    process.exit(1)
  }
  // Paired local-relay machine first; federated remote machine via the local
  // relay's federated_peer_list (gap 5) — routing goes through the LOCAL
  // relay, the cross-relay hop is invisible.
  const machine = await requireMachineOrRemote(target, flags.get("relay"))
  const label = machine.name ?? machine.epk.slice(0, 12)
  const client = await connectControlRoom(machine, machine.relayUrl)

  const cwd = flags.get("dir") || undefined
  const name = flags.get("name") || undefined
  console.error(
    `launching pi on ${label}${cwd ? ` in ${cwd}` : ""}${name ? ` as '${name}'` : ""} …`,
  )
  // Pre-launch room snapshot: the new session is the room that appears after
  // this point (pi mints a fresh id, so there is no id to match upfront).
  const beforeRooms = new Set(
    (await client.listRooms()).map((r) => r.room_id),
  )
  const outcome = await launchAndWait(client, { cwd, name })

  if (!outcome.ok) {
    console.error(`launch rejected: ${outcome.note}`)
    Shell.exitAfterDrain(1)
    process.exit(1)
  }

  console.error(`launched — waiting for the session to go live…`)
  const room = await waitForRoom(client, (r) => {
    if (beforeRooms.has(r.room_id)) return false // pre-existing session
    if (name && r.name === name) return true
    if (cwd && r.cwd === cwd) return true
    return !name && !cwd // no matcher given: any new room is ours
  })
  if (!room) {
    console.error(
      `the session did not come live within 30s — it may still be starting. ` +
        `Check the machine and attach later with:\n  unbien connect ${machine.epk.slice(0, 8)} --list`,
    )
    Shell.exitAfterDrain(1)
    process.exit(1)
  }
  if (!room.sessionId) {
    console.error(
      `session is live (${room.name ?? room.room_id}) — attach with:\n  unbien connect ${machine.epk.slice(0, 8)} --list`,
    )
    Shell.exitAfterDrain(0)
    process.exit(0)
  }
  console.error(`session is live — attaching…`)
  process.exit(await handoffToConnect(machine, room.sessionId))
}

await run(process.argv.slice(2))
