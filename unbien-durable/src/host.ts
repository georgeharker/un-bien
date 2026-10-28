/**
 * The un-bien durable host: a small always-on agent program that opens a
 * pi-durable Harness over SQLite storage, installs the un-bien durable
 * extension + CodingTools, joins the local UDS agent mesh, and serves the
 * un-bien mobile app over the relay through the bridge.
 *
 * Because the conversation id is stable (SQLite), there is no session
 * bootstrap racing here: the room id is derived from the root conversation
 * id and survives every restart — the app reconnects to the same room and
 * its get_entries reconstructs the transcript from the mirror.
 *
 * Usage:
 *   unbien-durable [--cwd <dir>] [--name <agent-name>] [--relay <url>]
 *                   [--db <path>] [--model <provider/model>]
 *
 * Env: provider API keys are read by pi-ai's provider registry exactly as
 * pi reads them (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). The model defaults
 * from the pi-ai catalog's first configured provider/model.
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
import { CodingTools } from "@earendil-works/pi-durable/tools"
import {
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { loadConfig } from "@geohar/un-bien/dist/config.js"
import {
  MeshNode,
} from "@geohar/un-bien/dist/session/mesh_node.js"
import { MeshInbox } from "@geohar/un-bien/dist/session/mesh_inbox.js"
import {
  LOCAL_SESSION_NAME,
  ensureGlobalDirs,
  sessionSockPath,
} from "@geohar/un-bien/dist/session/global_config.js"
import { createUnBienDurableExtension } from "./extension.js"
import { HeadlessPiLaunch } from "./pi_launch.js"
import { DurableBridge } from "./bridge.js"

// ── CLI ────────────────────────────────────────────────────────────────────

interface HostOptions {
  cwd: string
  name: string
  relayUrl: string
  dbPath: string
  model: string | undefined // "provider/modelId"
}

function parseArgs(argv: string[]): HostOptions {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!key.startsWith("--") || value === undefined) {
      process.stderr.write(`Usage: unbien-durable [--cwd <dir>] [--name <agent-name>] [--relay <url>] [--db <path>] [--model <provider/model>]\n`)
      process.exit(2)
    }
    args.set(key.slice(2), value)
  }
  const cwd = resolve(args.get("cwd") ?? process.cwd())
  const relayUrl =
    args.get("relay") ??
    loadConfig().relay ??
    "http://127.0.0.1:8081"
  const name = args.get("name") ?? "durable"
  const stateDir = join(
    process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"),
    "un-bien",
    "durable",
  )
  const dbPath = resolve(args.get("db") ?? join(stateDir, "session.sqlite"))
  return { cwd, name, relayUrl, dbPath, model: args.get("model") }
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

  // The Harness over SQLite — durable conversations, stable ids, resume.
  const storage = await openNodeSqliteStorage(opts.dbPath)
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
    cwd: opts.cwd,
    log: (message, level) => log(message, level ?? "info"),
    shutdownHost: shutdown,
  })
  bridgeRef = bridge
  await bridge.attach(root)
  await bridge.start()

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