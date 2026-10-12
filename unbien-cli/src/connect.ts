#!/usr/bin/env node
/**
 * Attach to a live pi session over the relay and drive it: transcript in,
 * prompts out. Rendering is the same reducer + pi components the replay
 * prototype uses, so a live turn and a fixture replay draw identically.
 */
import { createInterface } from "node:readline"
import { createInterface as createPromptInterface } from "node:readline/promises"
import { SessionClient, type RoomInfo } from "./client.js"
import { applyTheme, availableThemes } from "./theme.js"
import { loadOrCreateIdentity } from "./identity.js"
import { parseInvite, type PairingInvite } from "./invite.js"
import {
  answerResponse,
  cancelResponse,
  effectiveType,
  plainResponse,
  routeNotify,
  staleFlows,
  type AskAnswer,
  type AskPrompt,
} from "./ask.js"
import {
  findCommand,
  type CommandContext,
  type SessionEntry,
} from "./commands.js"
import { PanelStore } from "./panels.js"
import { pickSession } from "./picker.js"
import { entriesToEnvelopes, reduce, type EnvelopeMessage } from "./reduce.js"
import { Shell } from "./tui.js"
import {
  renderAgentsPanel,
  renderPlanPanel,
  summariseAgents,
  summarisePlan,
} from "./panels.js"
import { renderStreaming, renderThinking, renderTranscript } from "./render.js"
import { loadSettings, saveSettings, settingsPath } from "./settings.js"
import { loadPeers, rememberPeer, loadRelays } from "./store.js"
import type { PairedPeer } from "./store.js"
import type { Ed25519Keypair } from "@geohar/un-bien/client"

function parseArgs(argv: readonly string[]) {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--list") flags.set("list", "1")
    else if (arg === "--list-themes") flags.set("list-themes", "1")
    else if (arg === "--debug") flags.set("debug", "1")
    else if (arg.startsWith("--")) flags.set(arg.slice(2), argv[++i] ?? "")
    else positional.push(arg)
  }
  return { target: positional[0], flags }
}

const { target, flags } = parseArgs(process.argv.slice(2))

if (flags.has("list-themes")) {
  console.log((await availableThemes()).join("\n"))
  process.exit(0)
}

/**
 * Either a fresh `unbien://pair?…` invite, or a machine we already paired with
 * — pairing is machine-level, so a remembered peer needs no token.
 */
function resolveTarget(): { invite: PairingInvite; relayUrl: string } | null {
  const explicitRelay = flags.get("relay")
  if (target?.startsWith("unbien://")) {
    const relayUrl = explicitRelay ?? process.env["UNBIEN_RELAY"]
    if (!relayUrl) return null
    return { invite: parseInvite(target), relayUrl }
  }

  const peers = loadPeers()
  const peer = target
    ? peers.find((p) => p.epk.startsWith(target) || p.name === target)
    : peers[peers.length - 1]
  if (!peer) return null

  return {
    // A remembered peer has no token; `room` is chosen after listing.
    invite: { token: "", epk: peer.epk, roomId: "main" },
    // A pairing is only valid on the relay it was made on, so the peer's own
    // relay beats the ambient env var — which names whatever this shell last
    // pointed a pi at, not where this peer lives.
    relayUrl: explicitRelay ?? peer.relayUrl,
  }
}

/** A session choice enriched with relay provenance (which relay+peer it
 *  came from) so the unified picker can disambiguate machines on different
 *  relays that happen to share a session name. */
interface SessionChoice extends RoomInfo {
  relayUrl: string
  relayLabel: string
}

/** Group peers by their relay URL — each group becomes one relay connection. */
function peersByRelay(peers: readonly PairedPeer[]): Map<string, PairedPeer[]> {
  const groups = new Map<string, PairedPeer[]>()
  for (const p of peers) {
    const list = groups.get(p.relayUrl) ?? []
    list.push(p)
    groups.set(p.relayUrl, list)
  }
  return groups
}

/** Relay label for the picker: the relay's registered name if known, else the
 *  URL's hostname. Short — it's an inline tag, not a column. */
function relayLabelFor(url: string): string {
  const remembered = loadRelays().find((r) => r.url === url)
  if (remembered) return remembered.name
  try {
    return new URL(url).hostname
  } catch {
    return url.slice(0, 20)
  }
}

/** Fan out to every relay that has peers, list rooms from each machine,
 *  aggregate with provenance. Unreachable relays are skipped with a note —
 *  one dead relay must not wedge the whole picker. */
async function listAllSessions(
  keypair: Ed25519Keypair,
): Promise<{ choices: SessionChoice[]; clients: Map<string, SessionClient> }> {
  const groups = peersByRelay(loadPeers())
  const clients = new Map<string, SessionClient>()
  const choices: SessionChoice[] = []
  const deadRelays: string[] = []

  await Promise.all(
    [...groups.entries()].map(async ([relayUrl, relayPeers]): Promise<void> => {
      // The invite's epk is per-machine; we need one client per relay, but
      // listRooms is scoped per invite.epk — so we create one client per
      // (relay, machine) pair. The FIRST machine on each relay provides the
      // client; subsequent machines on the same relay reuse it (listRooms
      // just sends rooms_check for that machine's epk).
      let fedPromise: Promise<RoomInfo[]> = Promise.resolve([])
      for (const peer of relayPeers) {
        const invite: PairingInvite = {
          token: "",
          epk: peer.epk,
          roomId: "main",
        }
        let client = clients.get(relayUrl)
        if (!client) {
          client = new SessionClient(relayUrl, keypair, invite)
          try {
            await client.connect()
            clients.set(relayUrl, client)
            // Start listening for federated_peer_list RIGHT AFTER connect —
            // the relay pushes it on connect, before listRooms. If we wait
            // until after listRooms, the frame is already gone.
            fedPromise = client.listFederatedSessions()
          } catch {
            deadRelays.push(relayLabelFor(relayUrl))
            return // unreachable relay: skip this group
          }
        }
        const label = relayLabelFor(relayUrl)
        const rooms = await client.listRooms()
        for (const room of rooms) {
          choices.push({ ...room, relayUrl, relayLabel: label })
        }
      }

      // Await the federated sessions (listener was started on connect).
      const fedRooms = await fedPromise
      for (const room of fedRooms) {
        choices.push({
          ...room,
          relayUrl,
          relayLabel: room.peerRelay ?? relayLabelFor(relayUrl),
        })
      }

      return undefined // explicit: Promise.all worker; array-callback-return wants a value
    }),
  )

  if (deadRelays.length > 0) {
    console.error(`[relay] unreachable: ${deadRelays.join(", ")} (skipped)`)
  }
  return { choices, clients }
}

const resolved = resolveTarget()
if (!resolved) {
  console.error(
    "usage:\n" +
      "  unbien connect '<unbien://pair?...>'   # first run: pair with a machine\n" +
      "  unbien connect [<epk-prefix>] --list   # list that machine's sessions\n" +
      "  unbien connect [<epk-prefix>] --session <id>        # pi session id\n" +
      "  unbien connect [<epk-prefix>] --session-name <name>\n" +
      "options: --relay <url> (default $UNBIEN_RELAY) --name <device>\n" +
      "         --theme <name> (default: your pi theme setting) --list-themes",
  )
  if (loadPeers().length === 0) {
    console.error("\nno paired machines yet — run `/unbien pair` in a session.")
  }
  process.exit(1)
}

/**
 * Registered BEFORE any async work: if startup stalls (relay, rooms, attach)
 * there is no shell yet to handle keys, and raw mode left on by the picker
 * suppresses the default Ctrl-C. Without this the process is unkillable from
 * the terminal it is running in.
 */
// Declared BEFORE hardQuit: a SIGINT during startup runs it while the rest of
// this module is still initialising, and a `let` read in its temporal dead
// zone would throw instead of exiting.
let shell: Shell | null = null
/** Flows we are showing, keyed by request id (which IS the pi-ask flowId). */
const openAsks = new Map<string, AskPrompt>()
/**
 * Open sync window: the flow ids the host replayed since we asked. A push can
 * be lost (a dismissal notify we never saw), so the PULL reconciles — anything
 * we still show that the host did NOT replay has since resolved.
 *
 * Null means no window in flight, which deliberately FAILS OPEN: a dropped
 * terminator must never retire a live prompt.
 */
let syncWindow: Set<string> | null = null
let quitting = false
function hardQuit(reason: string): void {
  if (quitting) process.exit(130) // double-interrupt: immediate (already quitting)
  quitting = true
  // Once the shell exists, pi owns the terminal — let its teardown run rather
  // than restoring stdin by hand (which loses the original raw-mode state).
  if (shell) {
    shell.quit()
    return
  }
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    /* stdin already torn down */
  }
  process.stderr.write(`\n[exit] ${reason}\n`)
  Shell.exitAfterDrain(130)
}
process.on("SIGINT", () => hardQuit("interrupted"))
process.on("SIGTERM", () => hardQuit("terminated"))

// UNCAUGHT/UNHANDLED SAFETY NET: an error thrown from an async event handler
// (a relay frame that triggers an unhandled path — e.g. a mesh revocation
// notification) kills the process with the terminal still in raw mode: no
// echo, no cursor, Kitty protocol active. These handlers restore the terminal
// before exiting, whatever went wrong. They are the LAST resort — everything
// above tries to tear down cleanly first.
function emergencyRestore(reason: string, err: unknown): void {
  try {
    if (shell) shell.quit()
    else if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    /* terminal already gone */
  }
  process.stderr.write(
    `\n[exit] ${reason}: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  Shell.exitAfterDrain(1)
}
process.on("uncaughtException", (err) =>
  emergencyRestore("uncaught exception", err),
)
process.on("unhandledRejection", (reason) =>
  emergencyRestore("unhandled rejection", reason),
)

const debug = flags.has("debug")
function trace(direction: string, detail: string): void {
  if (debug) process.stderr.write(`[${direction}] ${detail}\n`)
}

const settings = loadSettings()
const appliedTheme = await applyTheme(flags.get("theme") ?? settings.theme)
if (appliedTheme.startsWith("dark (")) console.error(`[theme] ${appliedTheme}`)

const { invite, relayUrl } = resolved
let client = new SessionClient(relayUrl, loadOrCreateIdentity(), invite)
// Note: in the multi-relay path, the client's internals may be re-bound to
// the chosen relay's connection after the session picker (see below).

// WIDTH is LIVE: updated on terminal resize so text wrapping follows the
// actual terminal, not the width at process start.
let width = process.stdout.columns ?? 100
process.stdout.on("resize", () => {
  width = process.stdout.columns ?? 100
})
/** Frames seen so far; the transcript is re-reduced from the whole stream. */
const seen: EnvelopeMessage[] = []
const panels = new PanelStore()
/** The walked session log, kept so commands can derive forks and turns. */
let walkedEntries: SessionEntry[] = []
let drawn = 0
let cwd = process.cwd()

function emit(lines: readonly string[]): void {
  if (shell) shell.print(lines)
  else for (const line of lines) console.log(line)
}

// RENDER COALESCING (the CLI wedge fix): envelopes arrive in bursts during
// streaming, and draw() is O(n) per call (full reduce + renderTranscript).
// Calling it on EVERY envelope starves the event loop — WebSocket reads, TUI
// repaints, and keystrokes all queue behind a synchronous render cascade.
// This coalesces to AT MOST one render per event-loop turn (setImmediate
// fires after I/O, unlike process.nextTick which runs before it).
// WINDOWED DRAW (the O(n) fix): renderTranscript + setTranscript were O(n)
// per draw — for long sessions, every streaming delta re-rendered the entire
// conversation. Two caps:
//   1. ITEM WINDOW: only the last ~4-screens of items go to renderTranscript
//      (the TUI scrolls from the bottom; anything above ~10 screens is wasted)
//   2. LINE CAP: the rendered lines are capped to DRAW_LINE_CAP for the TUI
// The reduce is still O(n) but it's a cheap loop — the RENDER was the cost.
// Item window scales with terminal HEIGHT (flexible, not fixed): ~4 screens
// of items is the useful tail. Re-derived on each draw so resize takes effect
// immediately. Floor 20 (tiny terminals), ceiling 200 (huge ones).
function drawItemWindow(): number {
  const h = process.stdout.rows ?? 40
  return Math.max(20, Math.min(200, h * 4))
}
const DRAW_LINE_CAP = 2_000
let drawPending = false
function draw(): void {
  if (drawPending) return
  drawPending = true
  setImmediate(() => {
    drawPending = false
    const items = reduce(seen)
    // WINDOW: the TUI shows the bottom — older items are dead render cost
    const itemWindow = drawItemWindow()
    const windowed =
      items.length > itemWindow ? items.slice(-itemWindow) : items
    const lines = renderTranscript(windowed, width, cwd, !settings.showThinking)
    const capped =
      lines.length > DRAW_LINE_CAP ? lines.slice(-DRAW_LINE_CAP) : lines
    if (shell) {
      shell.setTranscript(capped)
    } else {
      for (const line of capped.slice(
        Math.max(0, drawn - (lines.length - capped.length)),
      ))
        console.log(line)
    }
    drawn = lines.length
  })
}

/** Assistant text accumulated from deltas while a turn is in flight. */
let streaming = ""
/** Reasoning accumulated separately: it is replaced, never merged into text. */
let reasoning = ""

function paintLive(): void {
  if (!shell) return
  const parts: string[] = []
  if (settings.streamThinking && reasoning) {
    parts.push(...renderThinking(reasoning, width))
  }
  if (streaming) parts.push(...renderStreaming(streaming, width))
  shell.setLive(parts)
}

function applyStreaming(rpc: Record<string, unknown>): void {
  if (!shell) return
  const event = rpc.assistantMessageEvent as
    { type?: string; delta?: string } | undefined

  switch (rpc.type) {
    case "message_start":
      streaming = ""
      reasoning = ""
      shell.setLive([])
      return
    case "message_update":
      if (event?.type === "text_delta" && event.delta) {
        streaming += event.delta
        paintLive()
      } else if (event?.type === "thinking_delta" && event.delta) {
        reasoning += event.delta
        // Reasoning ends when the visible answer starts, so only paint while
        // no text has arrived — otherwise it lingers above the real reply.
        if (!streaming) paintLive()
      }
      return
    case "message_end":
      // draw() is about to put the settled message in the transcript.
      streaming = ""
      reasoning = ""
      shell.setLive([])
      return
  }
}

/**
 * Frames that can change the SETTLED transcript. Everything else (streaming
 * deltas, partial tool output, turn lifecycle) only moves the live region or
 * the spinner — redrawing the whole transcript for those means re-reducing and
 * re-rendering thousands of entries hundreds of times per turn, which starves
 * the event loop and makes the spinner stutter.
 */
const TRANSCRIPT_FRAMES = new Set([
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "compaction_end",
  "extension_ui_request",
  "entry_appended",
])

/**
 * The pinned panel widgets, re-rendered whenever a panel arrives or a mode
 * changes — mirroring pi-plan's widget, which lives above the composer and has
 * hidden / collapsed / expanded states.
 */
function paintWidgets(): void {
  if (!shell) return
  const lines: string[] = []
  const plan = panels.get("plan")
  const agents = panels.get("subagents")

  if (settings.planMode === "expanded") {
    lines.push(
      ...renderPlanPanel(plan, {
        showDone: settings.planShowDone,
        showContext: settings.planShowContext,
        maxRows: settings.planMaxRows,
      }),
    )
  } else if (settings.planMode === "collapsed") {
    lines.push(...summarisePlan(plan))
  }

  if (settings.subagentsMode === "expanded") {
    if (lines.length > 0) lines.push("")
    lines.push(...renderAgentsPanel(agents))
  } else if (settings.subagentsMode === "collapsed") {
    lines.push(...summariseAgents(agents))
  }
  shell.setWidgets(lines)
}

/** Wire the SessionClient event surface — called on whichever client the
 *  multi-relay picker promoted (single-relay: the original, called once). */
function wireClient(c: SessionClient): void {
  c.on("envelope", (env) => {
    const kind = env.rpc ? "rpc" : env.evt ? "evt" : "ub"
    const inner = (env.rpc ?? env.evt ?? env.ub) as
      { type?: string } | undefined
    trace("in", `${kind} ${inner?.type ?? "?"}`)
    if (env.ub && inner?.type === "session_sync_end") closeSyncWindow()
    // Panels are ephemeral view state, not transcript.
    if (panels.apply(env)) {
      paintWidgets()
      return
    }
    const rpc = env.rpc as Record<string, unknown> | undefined
    if (rpc?.type === "extension_ui_request") handleUiRequest(rpc)
    if (rpc) applyStreaming(rpc)
    seen.push(env)
    if (!rpc || TRANSCRIPT_FRAMES.has(String(rpc.type))) draw()
    // Busy state comes from the turn lifecycle; the running tool's name makes the
    // indicator say what it is waiting on rather than just that it is waiting.
    if (rpc?.type === "turn_start" || rpc?.type === "agent_start") {
      shell?.setStatus({ working: true, activity: "thinking" })
    } else if (rpc?.type === "tool_execution_start") {
      shell?.setStatus({
        working: true,
        activity: String(rpc.toolName ?? "tool"),
      })
    } else if (rpc?.type === "tool_execution_end") {
      shell?.setStatus({ working: true, activity: "thinking" })
    } else if (
      rpc?.type === "turn_end" ||
      rpc?.type === "agent_end" ||
      rpc?.type === "agent_settled"
    ) {
      shell?.setStatus({ working: false, activity: undefined })
    }
  })

  client.on("relayControl", (frame) => {
    trace("relay", String(frame.type ?? Object.keys(frame).join(",")))
  })

  client.on("control", (frame) => {
    trace("in", `control ${String(frame.type)}`)
    // session_sync replays pending asks on the STOCK path (`sender.send`), not
    // the envelope, so they arrive here rather than as {rpc} frames.
    if (frame.type === "extension_ui_request") {
      handleUiRequest(frame)
      return
    }
    if (frame.type === "pair_error") {
      console.error(
        `[pair failed] ${String(frame.message ?? frame.code ?? "")}`,
      )
      Shell.exitAfterDrain(1)
    }
    if (frame.type === "error" && frame.code === "unknown_peer") {
      console.error("[not paired] run `/unbien pair` and pass the new invite.")
      Shell.exitAfterDrain(1)
    }
  })

  c.on("close", () => {
    console.error("[relay] connection closed")
    Shell.exitAfterDrain(1)
  })
}
wireClient(client)

function describeSession(room: RoomInfo, index: number): string {
  const label = room.name ?? room.sessionId?.slice(0, 8) ?? room.room_id
  const child = room.parent ? " (subagent)" : ""
  const id = room.sessionId?.slice(0, 8) ?? room.room_id
  const remote = room.peerRelay ? ` (remote: ${room.peerRelay})` : ""
  return `  ${index + 1}. ${label}${child}${remote}\n      ${room.cwd ?? "?"}  [${id}]`
}

/** `--session` selects by IDENTITY: the pi sessionId (prefix ok) or room id. */
function matchesSessionId(room: RoomInfo, id: string): boolean {
  return room.sessionId?.startsWith(id) === true || room.room_id === id
}

async function pickRoom(rooms: readonly RoomInfo[]): Promise<RoomInfo | null> {
  if (rooms.length === 1) return rooms[0]!
  // A non-TTY stdin (piped input, CI) can't drive a highlight list.
  if (!process.stdin.isTTY) {
    // Group: local sessions first, then federated grouped by peerRelay.
    const local = rooms.filter((r) => !r.peerRelay)
    const remoteRelays = [...new Set(rooms.map((r) => r.peerRelay).filter(Boolean))] as string[]
    let idx = 0
    const lines: string[] = []
    if (local.length > 0) {
      lines.push("Local sessions:")
      for (const room of local) lines.push(describeSession(room, idx++))
    }
    for (const relay of remoteRelays) {
      lines.push("")
      lines.push("Remote (" + relay + "):")
      for (const room of rooms.filter((r) => r.peerRelay === relay)) {
        lines.push(describeSession(room, idx++))
      }
    }
    console.error("\n" + lines.join("\n"))
    const rl = createPromptInterface({
      input: process.stdin,
      output: process.stderr,
    })
    const answer = await rl.question("\nattach to # ")
    rl.close()
    return rooms[Number(answer.trim()) - 1] ?? null
  }
  return pickSession(rooms)
}

try {
  await client.connect()
} catch (err) {
  console.error(`[relay] could not connect to ${relayUrl}: ${String(err)}`)
  process.exit(1)
}

// A token means this is a first pairing; a remembered machine skips straight
// to routing, since the extension auto-attaches any peer it already trusts.
// The verdict is AWAITED: a stale/expired token previously looked successful
// (rememberPeer ran before the machine's pair_error landed), leaving a peers
// entry the machine's allow-list never learned — frames silently undeliverable.
if (invite.token) {
  const deviceName = flags.get("name") ?? "unbien-cli"
  const verdict = await new Promise<{ ok: boolean; detail?: string }>(
    (resolve) => {
      const onControl = (frame: Record<string, unknown>) => {
        const t = String(frame.type ?? "")
        if (t === "pair_ok") resolve({ ok: true })
        else if (t === "pair_error")
          resolve({
            ok: false,
            detail: String(frame.message ?? frame.code ?? "rejected"),
          })
      }
      client.on("control", onControl)
      client.pair(deviceName)
      setTimeout(() => {
        client.off("control", onControl)
        resolve({
          ok: false,
          detail: "timed out — run /unbien pair for a fresh code and retry",
        })
      }, 10_000)
    },
  )
  if (!verdict.ok) {
    console.error(`[pair] machine did not accept the pairing: ${verdict.detail}`)
    process.exit(1)
  }
  rememberPeer({
    epk: invite.epk,
    relayUrl,
    name: deviceName,
    pairedAt: new Date().toISOString(),
  })
  console.error(`[paired] ${deviceName} remembered — future runs need no token`)
}

// MULTI-RELAY SESSION LISTING: fan out to every relay with paired peers,
// aggregate rooms with provenance. Falls back to the single-relay path when
// only one relay is in play (identical to the pre-multi-relay behavior).
const relayGroups = peersByRelay(loadPeers())
const multiRelay = !target?.startsWith("unbien://") && relayGroups.size > 1

let choices: SessionChoice[]
let clientsByRelay: Map<string, SessionClient> | null = null

if (multiRelay) {
  const result = await listAllSessions(loadOrCreateIdentity())
  choices = result.choices
  clientsByRelay = result.clients
  // Close the non-chosen relay clients after picking (below).
} else {
  // NOTE: client.connect() was ALREADY called above (line ~497) — the
  // single-relay path reuses that connection. Calling it again would
  // register duplicate message handlers (every envelope processed twice:
  // the duplicate-transcript + relay-wedge bug).
  const rooms = await client.listRooms()
  const label = relayLabelFor(relayUrl)
  choices = rooms.map((room) => ({ ...room, relayUrl, relayLabel: label }))
}

if (choices.length === 0) {
  console.error("[sessions] none open — is a pi running on that machine?")
  process.exit(1)
}

if (flags.has("list")) {
  console.error("Sessions:\n")
  choices.forEach((room, i) => {
    const relay = multiRelay ? ` [${room.relayLabel}]` : ""
    console.error(`  ${describeSession(room, i)}${relay}`)
  })
  process.exit(0)
}

const wantedId = flags.get("session")
const wantedName = flags.get("session-name")

let chosen: (RoomInfo & Partial<SessionChoice>) | null
if (wantedId) {
  chosen = choices.find((r) => matchesSessionId(r, wantedId)) ?? null
  if (!chosen) console.error(`[sessions] no session with id "${wantedId}"`)
} else if (wantedName) {
  // Names are user-set and NOT unique, so an ambiguous one must not silently
  // pick a session — that would attach to an arbitrary agent.
  const named = choices.filter(
    (r) => r.name === wantedName && (!multiRelay || r.relayUrl === relayUrl),
  )
  if (named.length > 1) {
    console.error(`[sessions] "${wantedName}" is ambiguous — use --session:`)
    named.forEach((room, i) => console.error(describeSession(room, i)))
    process.exit(1)
  }
  chosen = named[0] ?? null
  if (!chosen) console.error(`[sessions] no session named "${wantedName}"`)
} else {
  chosen = await pickRoom(choices)
}

if (!chosen) process.exit(1)

// MULTI-RELAY: promote the chosen relay's client, close the others.
if (multiRelay && clientsByRelay) {
  const promoted = chosen.relayUrl
    ? clientsByRelay.get(chosen.relayUrl)
    : undefined
  for (const [url, c] of clientsByRelay) {
    if (url !== chosen.relayUrl) {
      try {
        c.close()
      } catch {
        /* already down */
      }
    }
  }
  if (promoted) {
    // Adopt the promoted client wholesale: event listeners re-wired below
    // (the original client's listeners stay on the abandoned instance).
    try {
      client.close()
    } catch {
      /* not connected */
    }
    client = promoted
    wireClient(client)
  }
}

client.room = chosen.room_id
cwd = chosen.cwd ?? cwd
console.error(
  `[attached] ${chosen.name ?? chosen.room_id} — ${chosen.cwd ?? "?"}\n` +
    "type a prompt, /help for commands, Ctrl-C to exit\n",
)
// The first frame to a trusted peer is what triggers the extension's attach.
// Opening the window BEFORE the request: the replay arrives ahead of the
// terminator, and anything still open that isn't replayed has since resolved.
syncWindow = new Set()
client.requestSync()

/** Set while an ask wants free text: the next submitted line answers it. */
let awaitingText: { prompt: AskPrompt; questionId: string } | null = null

/**
 * Close the reconciliation window: any ask we are still showing that the host
 * did NOT replay has resolved without us seeing the dismissal, so retire it.
 * The host only replays flows still awaiting an answer, which is what makes
 * "not replayed" mean "answered" rather than "maybe missed".
 */
function closeSyncWindow(): void {
  const replayed = syncWindow
  syncWindow = null
  for (const id of staleFlows(openAsks.keys(), replayed)) {
    openAsks.delete(id)
    if (awaitingText?.prompt.id === id) awaitingText = null
    emit(["  (clarification resolved elsewhere)"])
  }
}

function handleUiRequest(rpc: Record<string, unknown>): void {
  if (typeof rpc.id === "string") syncWindow?.add(rpc.id)
  if (rpc.method === "notify") {
    const routed = routeNotify(rpc, (id) => openAsks.has(id))
    if (routed.kind === "dismiss") {
      openAsks.delete(routed.id)
      if (awaitingText?.prompt.id === routed.id) awaitingText = null
      emit(["  (clarification resolved elsewhere)"])
    }
    // notice → the reducer already renders it; drop → nothing to do.
    return
  }
  // SAFETY: the non-notify extension_ui_request shapes (select/confirm/input/
  // editor) are exactly AskPrompt's fields, and every one of them is optional
  // here except `id`/`method`, which the dispatch above has already matched.
  // presentAsk reads nothing it doesn't first check.
  const prompt = rpc as unknown as AskPrompt
  openAsks.set(prompt.id, prompt)
  void presentAsk(prompt)
}

function respond(frame: Record<string, unknown>, promptId: string): void {
  openAsks.delete(promptId)
  if (awaitingText?.prompt.id === promptId) awaitingText = null
  client.sendEnvelope({ rpc: frame })
}

/**
 * Present a flow question by question. Scoped to select / confirm / input —
 * the realistic ask surface the app also implements; an `editor` degrades to
 * free text rather than pretending to be an editor.
 */
async function presentAsk(prompt: AskPrompt): Promise<void> {
  if (!shell) return
  const questions = prompt.ask?.questions ?? []
  const header = prompt.ask?.title ?? prompt.title ?? "Clarification"

  if (prompt.method === "confirm") {
    const picked = await shell.choose(header, [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ])
    if (!picked) return respond(cancelResponse(prompt), prompt.id)
    return respond(plainResponse(prompt, picked.value === "yes"), prompt.id)
  }

  // No pi-ask envelope: pi's own select/input dialog.
  if (questions.length === 0) {
    if (prompt.method === "select" && prompt.options?.length) {
      const picked = await shell.choose(
        header,
        prompt.options.map((o) => ({ value: o, label: o })),
      )
      if (!picked) return respond(cancelResponse(prompt), prompt.id)
      return respond(plainResponse(prompt, picked.value), prompt.id)
    }
    emit([`  ${header}`, "  (type your answer and press enter)"])
    awaitingText = { prompt, questionId: "" }
    return
  }

  const answers: Record<string, AskAnswer> = {}
  for (const question of questions) {
    if (question.options.length === 0) {
      emit([`  ${question.prompt}`, "  (type your answer and press enter)"])
      awaitingText = { prompt, questionId: question.id }
      return // the submit handler resumes the flow
    }
    // pi-ask encodes "the user should type an answer" as exactly ONE option
    // marked `freeform`, never mixed with real choices. Presenting that as a
    // one-item list would submit the literal "freeform" token instead of what
    // the user typed — it wants customText and NO values.
    if (question.options.length === 1 && question.options[0]?.freeform) {
      emit([`  ${question.prompt}`, "  (type your answer and press enter)"])
      awaitingText = { prompt, questionId: question.id }
      return
    }
    const type = effectiveType(question)
    const picked = await shell.choose(
      question.prompt,
      question.options.map((o) => ({
        value: o.value,
        // `recommended` is presentation-only metadata; surface it as a marker
        // rather than letting it change the value we submit.
        label: o.recommended ? `${o.label}  ★` : o.label,
        description: o.description ?? (type === "preview" ? o.preview : ""),
      })),
    )
    if (!picked) return respond(cancelResponse(prompt), prompt.id)
    answers[question.id] = { values: [picked.value] }
    if (type === "multi") {
      // Honest degradation: the list picks one, so say so rather than
      // silently sending a single value for a multi-select.
      emit([`  (${question.label ?? question.id}: one option sent)`])
    }
  }
  respond(answerResponse(prompt, answers), prompt.id)
}

function commandContext(): CommandContext {
  return {
    client,
    panels,
    entries: () => walkedEntries,
    settings,
    saveSettings: () => {
      saveSettings(settings)
      paintWidgets()
    },
    settingsPath: settingsPath(),
    print: emit,
    quit: () => (shell ? shell.quit() : Shell.exitAfterDrain(0)),
    choose: (title, items) =>
      shell ? shell.choose(title, items) : (items[0] ?? null),
    chooseAction: (title, items, hint, keys) =>
      shell
        ? shell.chooseAction(title, items, hint, keys)
        : Promise.resolve(null),
  }
}

async function submit(text: string): Promise<void> {
  // An ask waiting on free text owns the next line — otherwise the answer would
  // be sent to the agent as a fresh prompt while it sits blocked on the dialog.
  if (awaitingText) {
    const { prompt, questionId } = awaitingText
    awaitingText = null
    if (text === "/cancel") {
      respond(cancelResponse(prompt), prompt.id)
      emit(["  clarification cancelled"])
      return
    }
    if (questionId) {
      respond(
        answerResponse(prompt, { [questionId]: { customText: text } }),
        prompt.id,
      )
    } else {
      respond(plainResponse(prompt, text), prompt.id)
    }
    emit(["  answer sent"])
    return
  }

  const found = findCommand(text)
  if (found) {
    try {
      await found.command.run(commandContext(), found.args)
    } catch (err) {
      emit([`  /${found.command.name} failed: ${String(err)}`])
    }
    return
  }
  // /connect (or /sessions): switch to a different session on this machine
  // without quitting. Lists rooms, picks one, clears local state, re-syncs.
  if (text === "/connect" || text === "/sessions") {
    const rooms = await client.listRooms()
    // Exclude the current room from the picker (it's where we already are)
    const others = rooms.filter((r) => r.room_id !== client.room)
    if (others.length === 0) {
      emit(["  no other sessions open on this machine"])
      return
    }
    const chosen = await pickRoom(others)
    if (!chosen) return
    client.room = chosen.room_id
    // Reset the local transcript state — the new session's sync rebuilds it
    seen.length = 0
    walkedEntries = []
    drawn = 0
    syncWindow = new Set()
    client.requestSync()
    emit([
      `  switched to ${chosen.name ?? chosen.room_id.slice(0, 8)} — ${chosen.cwd ?? "?"}`,
      "  transcript rebuilding from sync…",
    ])
    return
  }

  // /queue: followUp semantics — queues until the turn ends, then runs fresh
  if (text.startsWith("/queue ")) {
    const queued = text.slice(7)
    if (!queued.trim()) {
      emit(["  usage: /queue <text> — queues until the current turn ends"])
      return
    }
    trace("out", `queue room=${client.room} chars=${queued.length}`)
    client.queue(queued)
    emit([
      `  ⏳ queued: ${queued.slice(0, 60)}${queued.length > 60 ? "…" : ""}`,
    ])
    return
  }

  // Unknown slash: PASS THROUGH to the machine. The extension's prompt
  // interceptor provides TUI semantics server-side - pi built-ins with
  // remote equivalents execute (/compact /new /name /thinking /model),
  // TUI-only commands and unknown slash refuse with a transient notice
  // (rendered via handleUiRequest above), and /unbien* / skills / prompt
  // templates run as registered. Local-first commands were handled above;
  // everything else is remote - same busy-aware routing as plain text.
  {
    // BUSY-AWARE ROUTING (matches the app): while the agent is working, a
    // typed prompt STEERS into the running turn (mid-turn injection); when
    // idle, it starts a fresh turn. The user never picks the verb — the
    // busy state (the same signal that drives the spinner) routes it.
    if (shell?.status.working) {
      trace("out", `steer room=${client.room} chars=${text.length}`)
      client.steer(text)
      emit([`  → steering: ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`])
    } else {
      trace("out", `prompt room=${client.room} chars=${text.length}`)
      client.prompt(text)
    }
  }
}

/**
 * History is pulled AFTER the prompt box is up. `get_entries` waits on the
 * extension, and blocking the shell on it left the terminal blank for as long
 * as that took — with keystrokes going nowhere.
 */
async function loadHistory(): Promise<void> {
  const entries = await client.getEntries()
  walkedEntries = entries as SessionEntry[]
  if (entries.length === 0) return
  // History is the AUTHORITATIVE prefix: it goes before anything that arrived
  // live while we were fetching, and the transcript is rebuilt in log order.
  seen.unshift(...entriesToEnvelopes(entries))
  drawn = 0
  draw()
}

if (process.stdin.isTTY) {
  shell = new Shell(
    { session: chosen.name ?? chosen.room_id, cwd: chosen.cwd ?? cwd },
    (text) => void submit(text),
    () => {
      // The relay socket is a live handle; leaving it open is what keeps the
      // process alive after the TUI has gone.
      try {
        client.close()
      } catch {
        /* already down */
      }
      Shell.exitAfterDrain(0)
    },
  )
  shell.start()
  // The footer's model comes from pi's own state, not from room_meta.
  client
    .request<{ model?: { id?: string } }>("get_state")
    .then((state) => shell?.setStatus({ model: state?.model?.id }))
    .catch(() => {})
  void loadHistory()
} else {
  await loadHistory()
  const rl = createInterface({ input: process.stdin, terminal: false })
  for await (const line of rl) {
    const text = line.trim()
    if (text) await submit(text)
  }
}
