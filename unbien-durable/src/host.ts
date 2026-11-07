#!/usr/bin/env node
/**
 * The un-bien durable host: a small always-on agent program that opens a
 * pi-durable Harness over JSONL storage, installs the un-bien durable
 * extension + CodingTools, joins the local UDS agent mesh, and serves the
 * un-bien mobile app over the relay through the bridge.
 *
 * Because the conversation id is stable (JSONL storage), there is no session
 * bootstrap racing here: the room id is derived from the root conversation
 * id and survives every restart — the app reconnects to the same room and
 * its get_entries reconstructs the transcript from the mirror.
 *
 * Usage:
 *   unbien-durable [--cwd <dir>] [--name <agent-name>] [--relay <url>]
 *                   [--db <path>] [--model <provider/model>]
 *                   [--thinking <level>] [--no-pairing-qr]
 *
 * Env: provider API keys are read by pi-ai's provider registry exactly as
 * pi reads them (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). The model defaults
 * from the pi-ai catalog's first configured provider/model.
 * UNBIEN_NO_PAIRING_QR suppresses the auto-minted rotating pairing QR (same
 * as --no-pairing-qr): the invite mints with no user gesture, which headless
 * hosts pair via the un-bien CLI instead.
 * --thinking (or UNBIEN_DURABLE_THINKING) sets the thinking level a
 * conversation still at "off" is raised to: default "medium", pi's default,
 * clamped to the model; "off" keeps pi-durable's default.
 */
import { join, dirname, resolve } from "node:path"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { googleProvider } from "@earendil-works/pi-ai/providers/google"
import { groqProvider } from "@earendil-works/pi-ai/providers/groq"
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek"
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"
import { ollamaCloudProvider } from "./ollama_cloud.js"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import {
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable"
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { loadConfig } from "@geohar/un-bien/durable"
import { MeshNode } from "@geohar/un-bien/durable"
import { MeshInbox } from "@geohar/un-bien/durable"
import {
  LOCAL_SESSION_NAME,
  ensureGlobalDirs,
  sessionSockPath,
} from "@geohar/un-bien/durable"
import { createUnBienDurableExtension } from "./extension.js"
import { HeadlessPiLaunch } from "./pi_launch.js"
import { DurableBridge } from "./bridge.js"
import { wireMeshInbox } from "./mesh_delivery.js"
import {
  DEFAULT_THINKING_LEVEL,
  parseThinkingLevel,
} from "./thinking.js"
import type { ModelThinkingLevel } from "@earendil-works/pi-ai"

// ── CLI ────────────────────────────────────────────────────────────────────

interface HostOptions {
  cwd: string
  name: string
  machineName?: string
  relayUrl: string
  dbPath: string
  model: string | undefined // "provider/modelId"
  thinkingLevel: ModelThinkingLevel
  /** Suppress the auto-minted rotating pairing QR (CLI flag --no-pairing-qr
   *  or env UNBIEN_NO_PAIRING_QR). Pairing then happens via the un-bien CLI. */
  noPairingQr: boolean
}

function parseArgs(argv: string[]): HostOptions {
  const args = new Map<string, string>()
  let noPairingQr =
    process.env["UNBIEN_NO_PAIRING_QR"] !== undefined &&
    process.env["UNBIEN_NO_PAIRING_QR"] !== "0" &&
    process.env["UNBIEN_NO_PAIRING_QR"] !== "false"
  for (let i = 0; i < argv.length; ) {
    const key = argv[i] as string
    if (key === "--no-pairing-qr") {
      noPairingQr = true
      i += 1
      continue
    }
    const value = argv[i + 1]
    if (!key.startsWith("--") || value === undefined) {
      process.stderr.write(`Usage: unbien-durable [--cwd <dir>] [--name <agent-name>] [--relay <url>] [--db <path>] [--model <provider/model>] [--thinking <level>] [--no-pairing-qr]\n`)
      process.exit(2)
    }
    args.set(key.slice(2), value)
    i += 2
  }
  const cwd = resolve(args.get("cwd") ?? process.cwd())
  const relayUrl =
    args.get("relay") ??
    loadConfig().relay ??
    "http://127.0.0.1:8081"
  const name = args.get("name") ?? "durable"
  const machineName = args.get("machine-name")
  const stateDir = join(
    process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"),
    "un-bien",
    "durable",
  )
  const dbPath = resolve(args.get("db") ?? join(stateDir, "session"))
  const thinkingArg =
    args.get("thinking") ?? process.env["UNBIEN_DURABLE_THINKING"]
  const thinkingLevel = parseThinkingLevel(thinkingArg)
  if (thinkingArg !== undefined && thinkingLevel === undefined) {
    process.stderr.write(`unbien-durable: unknown thinking level "${thinkingArg}"\n`)
    process.exit(2)
  }
  return {
    cwd,
    name,
    machineName,
    relayUrl,
    dbPath,
    model: args.get("model"),
    thinkingLevel: thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    noPairingQr,
  }
}

function log(message: string, level: "info" | "warning" | "error" = "info"): void {
  const prefix = level === "info" ? "" : `[${level}] `
  process.stdout.write(`[un-bien-durable] ${prefix}${message}\n`)
}

// ── Host ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  ensureGlobalDirs()
  mkdirSync(dirname(opts.dbPath), { recursive: true })

  // Fire-and-forget async must never kill the host: several paths hand a
  // promise to the void (the pairing QR rotation, relay reconnects,
  // conversation abort/compact) and their per-site .catch() calls cover the
  // EXPECTED failures — this process-level net catches the rest (an
  // unexpected throw mid-path). Logs and continues; Node's default handler
  // would exit the process, taking the always-on host down with a stray
  // rejection.
  process.on("unhandledRejection", (reason: unknown) => {
    const detail =
      reason instanceof Error
        ? reason.stack ?? reason.message
        : String(reason)
    log(`unhandled rejection: ${detail}`, "error")
  })

  // Models: pi-ai's provider registry reads the same env keys pi reads
  // (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). A provider without credentials
  // simply has no configured models in the catalog.
  const models = createModels()
  for (const provider of [
    anthropicProvider(),
    openaiProvider(),
    googleProvider(),
    groqProvider(),
    deepseekProvider(),
    mistralProvider(),
    openrouterProvider(),
    // Ollama Cloud: composed host-side (pi-durable has no pi-extension
    // interface, so the pi-ollama-cloud extension can't run here — see
    // ollama_cloud.ts). Auth via OLLAMA_API_KEY; without it the provider
    // registers inert (pi-ai skips credential-less providers at use time).
    ollamaCloudProvider(),
  ])
    models.setProvider(provider)

  // Registry: coding tools + the un-bien mesh/launch extension.
  const registry = createRegistry()
  registry.install(CodingTools)
  const inbox = new MeshInbox()
  const meshNode = new MeshNode({
    sockPath: sessionSockPath(LOCAL_SESSION_NAME),
    name: opts.name,
    cwd: opts.cwd,
  })
  // Feed the inbox BEFORE the join: inbound agent-to-agent envelopes are
  // stored for the model's pull/wait surface (launch_pi_task's correlated
  // reply waits, the mesh_* tools), so nothing delivered between connect
  // and the first tool call is lost.
  wireMeshInbox(meshNode, inbox)
  const relayPeers: string[] = []
  const relayPeersDetail = new Map<
    string,
    { relayName: string; addresses: string[] }
  >()
  const unBien = createUnBienDurableExtension({
    getMeshNode: () => meshNode,
    getInbox: () => inbox,
    getRemoteRelayPeers: () => relayPeers,
    getRemoteRelayPeersDetail: () => relayPeersDetail,
    getRelay: () => null, // v1: the bridge owns the relay; federated routing arrives with the cross-PC bridge
    launch: new HeadlessPiLaunch(),
    cwd: opts.cwd,
  })
  registry.install(unBien)

  // JSONL storage: a directory of append-only .jsonl files — durable
  // conversations, stable ids, resume. Inspectable and git-friendly, with no
  // native sqlite binding (portable to Bun / Cloudflare later).
  const storage = await openNodeJsonlStorage(opts.dbPath, BACKGROUND_CONTEXT)
  let shuttingDown = false
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? opts.cwd }),
      onReport: (error) => {
        log(`extension failure: ${String(error)}`, "warning")
      },
    },
    BACKGROUND_CONTEXT,
  )
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      ...(opts.model && opts.model.includes("/")
        ? {
            model: (() => {
              const [provider, ...rest] = opts.model!.split("/")
              return { provider, modelId: rest.join("/") }
            })(),
          }
        : {}),
      cwd: opts.cwd,
    },
  })
  harness.resume()

  // Graceful shutdown: bridge stop → mesh leave → harness close → exit.
  let bridgeRef: DurableBridge | null = null
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log("shutting down…")
    try {
      await bridgeRef?.stop()
    } catch {
      /* best-effort */
    }
    try {
      await meshNode.close()
    } catch {
      /* best-effort */
    }
    try {
      await harness.close(BACKGROUND_CONTEXT)
    } catch {
      /* best-effort */
    }
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

  // The relay<->conversation bridge (session-replacement machinery deleted
  // by design — stable conversation ids).
  const bridge = new DurableBridge({
    harness,
    context: BACKGROUND_CONTEXT,
    relayUrl: opts.relayUrl,
    displayName: opts.name,
    machineName: opts.machineName,
    cwd: opts.cwd,
    pairingQr: !opts.noPairingQr,
    models,
    thinkingLevel: opts.thinkingLevel,
    log: (message, level) => log(message, level ?? "info"),
    shutdownHost: shutdown,
  })
  bridgeRef = bridge
  await bridge.attach(root)
  await bridge.start()
  if (opts.noPairingQr)
    log(
      "pairing QR suppressed — pair this machine via the un-bien CLI, or restart without --no-pairing-qr / UNBIEN_NO_PAIRING_QR",
    )

  // Join the local UDS agent mesh (the model's agent_send/launch_pi_task
  // surface). A broker absence is tolerated: the mesh reconnects via
  // MeshNode's own failover when a leader appears.
  try {
    const assigned = await meshNode.connect()
    log(`mesh joined as "${assigned}"`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log(`mesh join deferred: ${detail}`, "warning")
  }

  log(
    `durable host up — conversation ${String(root.id)}, relay ${opts.relayUrl}`,
  )
  log(`db: ${opts.dbPath}`)
  log("press Ctrl-C to shut down")
}

void main().catch((err: unknown) => {
  process.stderr.write(
    `[un-bien-durable] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  )
  process.exit(1)
})