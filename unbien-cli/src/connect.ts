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
import { loadPeers, rememberPeer } from "./store.js"

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

const resolved = resolveTarget()
if (!resolved) {
  console.error(
    "usage:\n" +
      "  unbien-cli connect '<unbien://pair?...>'   # first run: pair with a machine\n" +
      "  unbien-cli connect [<epk-prefix>] --list   # list that machine's sessions\n" +
      "  unbien-cli connect [<epk-prefix>] --session <id>        # pi session id\n" +
      "  unbien-cli connect [<epk-prefix>] --session-name <name>\n" +
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
let quitting = false
function hardQuit(reason: string): void {
  if (quitting) process.exit(130)
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
  process.exit(130)
}
process.on("SIGINT", () => hardQuit("interrupted"))
process.on("SIGTERM", () => hardQuit("terminated"))

const debug = flags.has("debug")
function trace(direction: string, detail: string): void {
  if (debug) process.stderr.write(`[${direction}] ${detail}\n`)
}

const settings = loadSettings()
const appliedTheme = await applyTheme(flags.get("theme") ?? settings.theme)
if (appliedTheme.startsWith("dark (")) console.error(`[theme] ${appliedTheme}`)

const { invite, relayUrl } = resolved
const client = new SessionClient(relayUrl, loadOrCreateIdentity(), invite)

const width = process.stdout.columns ?? 100
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

function draw(): void {
  const lines = renderTranscript(
    reduce(seen),
    width,
    cwd,
    !settings.showThinking,
  )
  if (shell) {
    // The shell owns the screen, so hand it the whole transcript: history
    // replay re-reduces from scratch and would otherwise duplicate rows.
    shell.setTranscript(lines)
  } else {
    for (const line of lines.slice(drawn)) console.log(line)
  }
  drawn = lines.length
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

client.on("envelope", (env) => {
  const kind = env.rpc ? "rpc" : env.evt ? "evt" : "ub"
  const inner = (env.rpc ?? env.evt ?? env.ub) as { type?: string } | undefined
  trace("in", `${kind} ${inner?.type ?? "?"}`)
  // Panels are ephemeral view state, not transcript.
  if (panels.apply(env)) {
    paintWidgets()
    return
  }
  const rpc = env.rpc as Record<string, unknown> | undefined
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
  if (frame.type === "pair_error") {
    console.error(`[pair failed] ${String(frame.message ?? frame.code ?? "")}`)
    process.exit(1)
  }
  if (frame.type === "error" && frame.code === "unknown_peer") {
    console.error("[not paired] run `/unbien pair` and pass the new invite.")
    process.exit(1)
  }
})

client.on("close", () => {
  console.error("[relay] connection closed")
  process.exit(1)
})

function describeSession(room: RoomInfo, index: number): string {
  const label = room.name ?? room.sessionId?.slice(0, 8) ?? room.room_id
  const child = room.parent ? " (subagent)" : ""
  const id = room.sessionId?.slice(0, 8) ?? room.room_id
  return `  ${index + 1}. ${label}${child}\n      ${room.cwd ?? "?"}  [${id}]`
}

/** `--session` selects by IDENTITY: the pi sessionId (prefix ok) or room id. */
function matchesSessionId(room: RoomInfo, id: string): boolean {
  return room.sessionId?.startsWith(id) === true || room.room_id === id
}

async function pickRoom(rooms: readonly RoomInfo[]): Promise<RoomInfo | null> {
  if (rooms.length === 1) return rooms[0]!
  // A non-TTY stdin (piped input, CI) can't drive a highlight list.
  if (!process.stdin.isTTY) {
    console.error("\nSessions on this machine:\n")
    rooms.forEach((room, i) => console.error(describeSession(room, i)))
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
if (invite.token) {
  client.pair(flags.get("name") ?? "unbien-proxy")
  rememberPeer({
    epk: invite.epk,
    relayUrl,
    name: flags.get("name") ?? "unbien-proxy",
    pairedAt: new Date().toISOString(),
  })
  console.error("[paired] machine remembered — future runs need no token")
}

const rooms = await client.listRooms()
if (rooms.length === 0) {
  console.error("[sessions] none open — is a pi running on that machine?")
  process.exit(1)
}

if (flags.has("list")) {
  console.error("Sessions on this machine:\n")
  rooms.forEach((room, i) => console.error(describeSession(room, i)))
  process.exit(0)
}

const wantedId = flags.get("session")
const wantedName = flags.get("session-name")

let chosen: RoomInfo | null
if (wantedId) {
  chosen = rooms.find((r) => matchesSessionId(r, wantedId)) ?? null
  if (!chosen) console.error(`[sessions] no session with id "${wantedId}"`)
} else if (wantedName) {
  // Names are user-set and NOT unique, so an ambiguous one must not silently
  // pick a session — that would attach to an arbitrary agent.
  const named = rooms.filter((r) => r.name === wantedName)
  if (named.length > 1) {
    console.error(`[sessions] "${wantedName}" is ambiguous — use --session:`)
    named.forEach((room, i) => console.error(describeSession(room, i)))
    process.exit(1)
  }
  chosen = named[0] ?? null
  if (!chosen) console.error(`[sessions] no session named "${wantedName}"`)
} else {
  chosen = await pickRoom(rooms)
}

if (!chosen) process.exit(1)

client.room = chosen.room_id
cwd = chosen.cwd ?? cwd
console.error(
  `[attached] ${chosen.name ?? chosen.room_id} — ${chosen.cwd ?? "?"}\n` +
    "type a prompt, /help for commands, Ctrl-C to exit\n",
)
// The first frame to a trusted peer is what triggers the extension's attach.
client.requestSync()

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
    quit: () => (shell ? shell.quit() : process.exit(0)),
    choose: (title, items) =>
      shell ? shell.choose(title, items) : (items[0] ?? null),
    chooseAction: (title, items, hint, keys) =>
      shell
        ? shell.chooseAction(title, items, hint, keys)
        : Promise.resolve(null),
  }
}

async function submit(text: string): Promise<void> {
  const found = findCommand(text)
  if (found) {
    try {
      await found.command.run(commandContext(), found.args)
    } catch (err) {
      emit([`  /${found.command.name} failed: ${String(err)}`])
    }
    return
  }
  if (text.startsWith("/steer ")) client.steer(text.slice(7))
  else if (text.startsWith("/")) emit([`  unknown command: ${text}`])
  else {
    trace("out", `prompt room=${client.room} chars=${text.length}`)
    client.prompt(text)
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
      process.exit(0)
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
