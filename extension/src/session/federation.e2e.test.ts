/**
 * Federation e2e — the REAL extension against TWO REAL relay binaries.
 *
 * Complements `relay/tests/federation_test.rs`, which proves the relay side
 * with synthetic clients. Here the machine end is actual extension code:
 * RelayClient (real WS + hello/challenge/auth), PlainPeerChannel (real outer
 * envelope codec), routeUnBienPlane (the real session_sync handler in
 * routing.ts) and buildSignedAllowList (the real machine-signed pairing_set
 * signer). The app end is a real RelayClient too — a "raw app client" is
 * exactly RelayClient without the lifecycle on top.
 *
 * Topology: app (this process, relay-a) → relay-a → relay-b → machine
 * (this process). The ub session_sync must cross the federated chain and the
 * extension's replay frames must cross BACK via the learned route.
 *
 * Only the extension LIFECYCLE is reduced to the minimal viable subset (the
 * `_installAutoListener`/`_attachOwner`/`_routeUnBienPlaneFrom` seams are
 * mirrored inline): the full pi-SDK deps graph (sessionManager, bridges, mesh
 * node) is out of scope for a transport/protocol test. The wire surface and
 * the transport code are the production code, byte for byte.
 *
 * Relays are spawned as child processes with HERMETIC state (fresh tempdir
 * per relay: UNBIEN_STATE_DIR, XDG_CONFIG_HOME, XDG_STATE_HOME all re-pointed
 * — never the developer's ~/.local/state/un-bien). Skipped cleanly when
 * `relay/target/debug/unbien-relay` is absent: the relay CI workflow already
 * builds it (`cd relay && cargo build`), so no build is attempted here — this
 * test only runs when the debug binary exists.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import {
  ed25519Sign,
  generateEd25519Keypair,
  type Ed25519Keypair,
} from "../pairing/crypto.js"
import { buildSignedAllowList } from "../pairing/signed_allow_list.js"
import { isEnvelopeFrame } from "../session/rpc_envelope.js"
import type { RpcHandlersDeps } from "../session/rpc_handlers.js"
import { routeUnBienPlane, type PlaneRouterDeps } from "../routing.js"
import { PlainPeerChannel } from "../transport/peer_channel.js"
import { RelayClient } from "../transport/relay_client.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const RELAY_DIR = join(HERE, "..", "..", "..", "relay")
const RELAY_BIN = join(RELAY_DIR, "target", "debug", "unbien-relay")

const HAVE_RELAY = existsSync(RELAY_BIN)
if (!HAVE_RELAY) {
  // CI note: the relay build job produces target/debug/unbien-relay before
  // the extension test job runs. Locally: `cd relay && cargo build`.
  console.warn(
    `[federation.e2e] relay binary missing at ${RELAY_BIN} — suite will skip (build with: cd relay && cargo build)`,
  )
}

// ── Track every process/tempdir created so afterAll cleans no matter what ────

const children: ChildProcess[] = []
const tempdirs: string[] = []

afterAll(() => {
  for (const child of children) {
    try {
      child.kill("SIGTERM")
    } catch {
      /* already gone */
    }
  }
  // Give SIGTERM a beat, then force-kill any survivors.
  const survivors = children.filter((c) => c.exitCode === null && c.pid)
  if (survivors.length > 0) {
    setTimeout(() => {
      for (const child of survivors) {
        try {
          child.kill("SIGKILL")
        } catch {
          /* already gone */
        }
      }
    }, 500).unref()
  }
  for (const dir of tempdirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ── Relay spawn helpers ─────────────────────────────────────────────────────

const relayLogs = new Map<string, string[]>()

function logTail(name: string): string {
  const lines = relayLogs.get(name) ?? []
  return lines.slice(-60).join("\n")
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (addr && typeof addr === "object") {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error("no ephemeral port")))
      }
    })
  })
}

interface RelayHandle {
  port: number
  stateDir: string
  /** The relay's pre-generated identity pubkey (base64) — pinned by the peer. */
  pubkey: string
}

/** Pre-generate the relay's identity keypair in its (not-yet-spawned)
 * state dir — same file format `relay_keypair.rs`/the CLI read (private_key
 * = 32-byte seed) — so the OTHER relay can pin its pubkey BEFORE either
 * starts (federation v2: the pin is the link gate, no shared-owner
 * fallback). */
function pregenRelayIdentity(stateDir: string): string {
  const kp = generateEd25519Keypair()
  const pubkey = Buffer.from(kp.publicKey).toString("base64")
  writeFileSync(
    join(stateDir, "relay-keypair.json"),
    JSON.stringify(
      {
        public_key: pubkey,
        private_key: Buffer.from(kp.secretKey).toString("base64"),
      },
      null,
      2,
    ),
  )
  return pubkey
}

/** Spawns the real relay binary with a fully hermetic state dir. */
async function spawnRelay(name: string, peers: unknown): Promise<RelayHandle> {
  const port = await freePort()
  const stateDir = mkdtempSync(join(tmpdir(), `unbien-fed-${name}-`))
  tempdirs.push(stateDir)
  // Identity keypair FIRST (so its pubkey can be pinned), then the peer
  // config: start_peering reads it at boot.
  const pubkey = pregenRelayIdentity(stateDir)
  writeFileSync(join(stateDir, "relay-peers.json"), JSON.stringify(peers))
  // Hermetic env: strip ambient UNBIEN_* overrides the vitest.setup doesn't
  // know about (direct DB-path overrides would bypass UNBIEN_STATE_DIR, and a
  // stale UNBIEN_RELAY_URL would leak into the relay-hello URL exchange).
  const env = { ...process.env }
  for (const key of [
    "UNBIEN_MESH_DB_PATH",
    "UNBIEN_PAIRING_DB_PATH",
    "UNBIEN_RELAY_URL",
    "UNBIEN_DIRECT_CONFIG",
    "UNBIEN_RELAY",
    "UNBIEN_DIR",
    "UNBIEN_HOME",
  ]) {
    delete env[key]
  }
  const child = spawn(RELAY_BIN, [], {
    env: {
      ...env,
      UNBIEN_RELAY_PORT: String(port),
      UNBIEN_RELAY_NAME: name,
      UNBIEN_STATE_DIR: stateDir,
      // Hermetic config root too: relay_config_path() reads XDG_CONFIG_HOME
      // for the federation.enabled gate — never leak the developer's
      // ~/.config/un-bien/relay.json into the rig.
      XDG_CONFIG_HOME: join(stateDir, "config"),
      XDG_STATE_HOME: join(stateDir, "xdg-state"),
      RUST_LOG: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  const logs: string[] = []
  relayLogs.set(name, logs)
  const grab = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) logs.push(line)
    }
    if (logs.length > 4000) logs.splice(0, logs.length - 2000)
  }
  child.stdout?.on("data", grab)
  child.stderr?.on("data", grab)
  child.on("exit", (code) => logs.push(`[exit code=${String(code)}]`))

  // /health as the readiness gate.
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(
        `relay ${name} never became healthy on :${port}\n${logTail(name)}`,
      )
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { port, stateDir, pubkey }
}

// ── Owner mesh blob publish (shared trust root) ──────────────────────────────

/** Publishes the SAME owner-signed mesh blob to both relays via /mesh —
 *  identical bytes, so both store the same owner hash = the federation
 *  trust root. blob = {owner_pk, version, members, issued_at}; sig = ed25519
 *  over the exact blob bytes; URL = sha256hex(owner pk bytes). */
async function publishSharedOwnerBlob(
  owner: Ed25519Keypair,
  memberEpks: string[],
  relayPorts: number[],
): Promise<void> {
  const blob = {
    owner_pk: Buffer.from(owner.publicKey).toString("base64"),
    version: 1,
    members: memberEpks.map((remote_epk) => ({
      remote_epk,
      // Display/route hint only; one entry per member.
      relay_url: `http://127.0.0.1:${relayPorts[0]}`,
      paired_at: "2025-01-01T00:00:00.000Z",
    })),
    issued_at: Date.now(),
  }
  const blobBytes = Buffer.from(JSON.stringify(blob), "utf8")
  const sig = ed25519Sign(owner.secretKey, blobBytes)
  const envelope = {
    blob: blobBytes.toString("base64"),
    sig: Buffer.from(sig).toString("base64"),
  }
  const hash = createHash("sha256").update(owner.publicKey).digest("hex")
  for (const port of relayPorts) {
    const res = await fetch(`http://127.0.0.1:${port}/mesh/${hash}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    })
    if (!res.ok) {
      throw new Error(
        `mesh publish failed on :${port} (${String(res.status)}): ${await res.text()}`,
      )
    }
  }
}

// ── Line-wait plumbing for a live RelayClient ────────────────────────────────

interface LineTap {
  lines: string[]
  /** Polls already-received lines + new arrivals until `probe` returns a hit. */
  waitFor: <T>(
    what: string,
    probe: (line: string) => T | null | undefined | false,
    timeoutMs: number,
  ) => Promise<T>
}

function tapLines(client: RelayClient): LineTap {
  const lines: string[] = []
  client.on("message", (line: string) => lines.push(line))
  return {
    lines,
    async waitFor<T>(
      what: string,
      probe: (line: string) => T | null | undefined | false,
      timeoutMs: number,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs
      let seen = 0
      for (;;) {
        for (; seen < lines.length; seen++) {
          const hit = probe(lines[seen])
          if (hit) return hit
        }
        if (Date.now() > deadline) {
          throw new Error(
            `timeout (${String(timeoutMs)}ms) waiting for ${what} — received ${String(lines.length)} line(s)`,
          )
        }
        await new Promise((r) => setTimeout(r, 150))
      }
    },
  }
}

function decodeOuter(
  line: string,
): { peer: string; room?: string; inner: Record<string, unknown> } | null {
  try {
    const outer = JSON.parse(line) as {
      peer?: unknown
      room?: unknown
      ct?: unknown
    }
    if (typeof outer.peer !== "string" || typeof outer.ct !== "string")
      return null
    const inner = JSON.parse(
      Buffer.from(outer.ct, "base64").toString("utf8"),
    ) as Record<string, unknown>
    return {
      peer: outer.peer,
      ...(typeof outer.room === "string" ? { room: outer.room } : {}),
      inner,
    }
  } catch {
    return null
  }
}

// ── The extension machine rig: minimal viable lifecycle subset ───────────────

/**
 * The REAL un-bien plane router fed REAL deps-shaped stubs. Every dep the
 * session_sync path reads is real-or-empty exactly as a freshly-started,
 * never-asked-pi session reads (no pending ui, no panels, display name from
 * room meta). `rpcDeps` is never touched on the ub plane (its only reader is
 * routeRpcCommand in routing.ts — no rpc traffic in this test), so null-cast.
 */
function makePlaneDeps(displayName: string): PlaneRouterDeps {
  const startedAt = Date.now()
  return {
    extensionUiBridge: () => null,
    panelBridge: () => null,
    subagentRooms: () => null,
    sessionStartedAt: () => startedAt,
    myRoomMeta: () => ({ name: displayName, cwd: process.cwd() }),
    rootState: () => ({ sessionManager: null }),
    safeNotify: () => {},
    liveCtx: () => null,
    pi: () => null,
    // SAFETY: routeUnBienPlane never reads rpcDeps (routing.ts: only
    // routeRpcCommand does), and this rig only dispatches ub frames.
    rpcDeps: null as unknown as RpcHandlersDeps,
  }
}

/**
 * Mirrors the production seams one-to-one:
 *  - `_installAutoListener`'s reconnect attach path: inner envelope frames
 *    from a known peer attach a PlainPeerChannel and route the first frame
 *    explicitly (the channel's own listener misses that same line);
 *  - `_attachOwner`'s channel construction: PlainPeerChannel over the live
 *    RelayClient with the envelope dispatcher;
 *  - `_routeUnBienPlaneFrom`: ub → routeUnBienPlane.
 * Subsequent frames are dispatched by the channel itself (real _onLine).
 */
function wireMachineSide(
  relay: RelayClient,
  appEpk: string,
  deps: PlaneRouterDeps,
): { channel: () => PlainPeerChannel | null } {
  let channel: PlainPeerChannel | null = null
  const dispatch = (
    env: Parameters<typeof routeUnBienPlane>[2],
    sender: PlainPeerChannel,
  ) => {
    if (env.ub !== undefined) routeUnBienPlane(deps, sender, env)
  }
  relay.on("message", (line: string) => {
    const outer = decodeOuter(line)
    if (!outer || outer.peer !== appEpk) return
    const inner = outer.inner
    if (!isEnvelopeFrame(inner)) return
    if (channel) return // already attached — the channel's own listener handles it
    channel = new PlainPeerChannel(
      relay,
      appEpk,
      "main",
      () => {}, // stock ClientMessages: none exercised in this rig
      undefined,
      (env, sender) => dispatch(env, sender),
      () => undefined, // sessionIdProvider — root session id unknown in this rig
    )
    // SAFETY: isEnvelopeFrame proved the envelope keys; mirror relay_lifecycle's
    // explicit first-frame route (the channel listener missed this line).
    dispatch(inner as Parameters<typeof routeUnBienPlane>[2], channel)
  })
  return { channel: () => channel }
}

// ── The rig (built in beforeAll) ─────────────────────────────────────────────

interface Rig {
  machineRelay: RelayClient
  appRelay: RelayClient
  appTap: LineTap
  appEpk: string
  machineEpk: string
}

let relayA: RelayHandle | null = null
let relayB: RelayHandle | null = null
let rig: Rig

async function buildRig(): Promise<Rig> {
  // 1. Two real relay binaries on random free ports (pre-bound :0 pick — the
  //    binary needs an explicit UNBIEN_RELAY_PORT), hermetic state dirs.
  relayA = await spawnRelay("relay-a", {
    federation: { enabled: true },
    peers: [], // placeholder — rewritten once relay-b's port is known
  })
  relayB = await spawnRelay("relay-b", {
    federation: { enabled: true },
    peers: [],
  })
  // Mutual PINNING (federation v2: the pin is the link gate — the shared
  // owner blob alone no longer federates anything). Relay-a dials out to
  // relay-b (pinned); relay-b's inbound gate pins relay-a's key so the
  // dial is accepted. The fswatch loop picks the rewrite up without a
  // restart.
  writeFileSync(
    join(relayA.stateDir, "relay-peers.json"),
    JSON.stringify({
      federation: { enabled: true },
      peers: [
        {
          name: "relay-b",
          url: `http://127.0.0.1:${relayB.port}`,
          pubkey: relayB.pubkey,
        },
      ],
    }),
  )
  writeFileSync(
    join(relayB.stateDir, "relay-peers.json"),
    JSON.stringify({
      federation: { enabled: true },
      peers: [
        {
          name: "relay-a",
          url: `http://127.0.0.1:${relayA.port}`,
          pubkey: relayA.pubkey,
        },
      ],
    }),
  )

  // 2. Identities: owner / machine / app — the machine key drives the REAL
  //    RelayClient; the app key drives the REAL app-side RelayClient.
  const owner = generateEd25519Keypair()
  const machine = generateEd25519Keypair()
  const app = generateEd25519Keypair()
  const machineEpk = Buffer.from(machine.publicKey).toString("base64")
  const appEpk = Buffer.from(app.publicKey).toString("base64")

  // 3. Shared trust root: the SAME owner blob published to both relays.
  await publishSharedOwnerBlob(
    owner,
    [machineEpk, appEpk],
    [relayA.port, relayB.port],
  )

  // 4. The machine connects to relay-b through the REAL RelayClient
  //    (hello/challenge/auth + room announce) exactly as `_cmdStart` does,
  //    then pushes its machine-signed pairing allow-list through the REAL
  //    signer + sendControl (granting the app and the owner).
  const machineRelay = new RelayClient(`ws://127.0.0.1:${relayB.port}`, machine)
  await machineRelay.connect({
    roomId: "main",
    roomMeta: { name: MACHINE_NAME, cwd: process.cwd() },
  })
  expect(machineRelay.isOpen()).toBe(true)
  machineRelay.sendControl({
    type: "pairing_set",
    ...buildSignedAllowList(
      machine,
      [appEpk, Buffer.from(owner.publicKey).toString("base64")],
      1,
    ),
  })

  // 5. The app client (own ed25519 key) on relay-a — same transport, no
  //    lifecycle, like the real app's raw WS client. Federation v2 §3 makes
  //    the owner-set gates STRICT on both sides: the machine→app REPLY leg is
  //    decided at relay-b, whose gate needs the APP's advertised owner set too
  //    (unknown ⇒ refused, no optimistic forwarding). The rig therefore has the
  //    app push its machine-SIGNED pairing_set (owners = [owner] — the app
  //    declares the owner it belongs to), exactly as a paired device does;
  //    relay-a advertises it in the pairings exchange and relay-b's gate sees
  //    sender-owner ∩ dest-owner = {owner} ≠ ∅.
  const appRelay = new RelayClient(`ws://127.0.0.1:${relayA.port}`, app)
  await appRelay.connect({ roomId: "main" })
  appRelay.sendControl({
    type: "pairing_set",
    ...buildSignedAllowList(
      app,
      [Buffer.from(owner.publicKey).toString("base64")],
      1,
    ),
  })
  const appTap = tapLines(appRelay)

  // 6. The machine side: real attach path + real ub-plane router.
  const deps = makePlaneDeps(MACHINE_NAME)
  wireMachineSide(machineRelay, appEpk, deps)

  return { machineRelay, appRelay, appTap, appEpk, machineEpk }
}

const MACHINE_NAME = "e2e-federation-machine"
const RENAME = "e2e-renamed-live"

// The suite only runs when the relay binary exists; otherwise it skips cleanly.
const d = HAVE_RELAY ? describe : describe.skip

d("cross-relay federation (real extension ↔ two real relay binaries)", () => {
  beforeAll(async () => {
    // A beforeAll failure surfaces with the relay log tails — the chain has
    // four moving parts and silent-forward failures are otherwise invisible.
    try {
      rig = await buildRig()
    } catch (err) {
      console.error(`[federation.e2e] relay-a log tail:\n${logTail("relay-a")}`)
      console.error(`[federation.e2e] relay-b log tail:\n${logTail("relay-b")}`)
      throw err
    }
  })

  it(
    "app on relay-a reaches the machine on relay-b and the extension replays back",
    async () => {
      const { appRelay, appTap, machineEpk, machineRelay } = rig
      expect(relayA).toBeTruthy()
      expect(relayB).toBeTruthy()

      try {
        // ── Federation learning: relay-a must learn relay-b's view of the
        // machine's room before it can route the request leg. Poll the same
        // control frame the extension uses (`get_federated_peer_list`).
        await vi.waitFor(
          () => {
            appRelay.send(JSON.stringify({ type: "get_federated_peer_list" }))
            const hit = appTap.lines.some((line) => {
              try {
                const wire = JSON.parse(line) as {
                  type?: string
                  peers?: Array<{ epk?: string }>
                }
                return (
                  wire.type === "federated_peer_list" &&
                  Array.isArray(wire.peers) &&
                  wire.peers.some((p) => p.epk === machineEpk)
                )
              } catch {
                return false
              }
            })
            if (!hit) throw new Error("relay-a has not learned relay-b's rooms yet")
          },
          { timeout: 30_000, interval: 400 },
        )

        // ── Request leg: app → session_sync → machine, across both relays.
        //    Inner ub envelope, base64-encoded into the opaque outer `ct`.
        const syncOuter = (id: string) =>
          JSON.stringify({
            peer: machineEpk,
            ct: Buffer.from(
              JSON.stringify({ type: "ub", ub: { type: "session_sync", id } }),
              "utf8",
            ).toString("base64"),
          })

        const SYNC_1 = "sync-e2e-1"
        appRelay.send(syncOuter(SYNC_1))
        const reply1 = await appTap.waitFor(
          "first session_sync_end reply",
          (line) => {
            const outer = decodeOuter(line)
            if (!outer) return null
            const ub = outer.inner.ub as {
              type?: string
              in_reply_to?: string
              session_name?: string
            }
            if (ub?.type !== "session_sync_end") return null
            return { outer, ub }
          },
          20_000,
        )
        // The app sees the MACHINE as sender, and the REAL session_sync
        // handler's echo of the request id + the room's display name.
        expect(reply1.outer.peer).toBe(rig.machineEpk)
        expect(reply1.ub.in_reply_to).toBe(SYNC_1)
        expect(reply1.ub.session_name).toBe(MACHINE_NAME)
        expect(typeof reply1.outer.inner.ts).toBe("number")

        // ── Learned route persists: a SECOND round trip rides the same
        //    cross-relay path (route + allow-list still good).
        const SYNC_2 = "sync-e2e-2"
        appRelay.send(syncOuter(SYNC_2))
        const reply2 = await appTap.waitFor(
          "second session_sync_end reply",
          (line) => {
            const outer = decodeOuter(line)
            if (!outer) return null
            const ub = outer.inner.ub as {
              type?: string
              in_reply_to?: string
            }
            if (ub?.type !== "session_sync_end" || !ub.in_reply_to) return null
            if (ub.in_reply_to === SYNC_1) return null // skip a first-reply latecomer
            return { ub }
          },
          20_000,
        )
        expect(reply2.ub.in_reply_to).toBe(SYNC_2)

        // ── A SPONTANEOUS machine-originated frame still routes: the REAL
        //    RelayClient.sendControl emits a room_meta_update; relay-b merges
        //    it, re-pushes the room to relay-a over the peering link, and
        //    relay-a fans a federated_peer_list carrying the NEW name.
        machineRelay.sendControl({
          type: "room_meta_update",
          room_id: "main",
          meta: { name: RENAME },
        })
        await vi.waitFor(
          () => {
            const hit = appTap.lines.some((line) => {
              try {
                const wire = JSON.parse(line) as {
                  type?: string
                  peers?: Array<{
                    epk?: string
                    rooms?: Array<{ room_id?: string; name?: string }>
                  }>
                }
                if (wire.type !== "federated_peer_list") return false
                return (
                  Array.isArray(wire.peers) &&
                  wire.peers.some(
                    (p) =>
                      p.epk === rig.machineEpk &&
                      Array.isArray(p.rooms) &&
                      p.rooms.some(
                        (r) => r.room_id === "main" && r.name === RENAME,
                      ),
                  )
                )
              } catch {
                return false
              }
            })
            if (!hit) throw new Error("renamed room meta never crossed the chain")
          },
          { timeout: 20_000, interval: 300 },
        )
      } catch (err) {
        console.error(`[federation.e2e] relay-a log tail:\n${logTail("relay-a")}`)
        console.error(`[federation.e2e] relay-b log tail:\n${logTail("relay-b")}`)
        throw err
      }
    },
    120_000,
  )
})