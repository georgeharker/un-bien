#!/usr/bin/env node
/**
 * `pi-unbien-launcher` — the regime-2 machine-launcher daemon.
 *
 * A lightweight mesh peer (NOT a pi session) that lets a paired app launch a
 * session on THIS machine even when no pi is running here. Reads the machine's
 * un-bien config for identity + relay + launch backend, joins the machine-level
 * control room, advertises `remote_launch`, and spawns tmux/herdr on request.
 *
 * Run by hand during bring-up:
 *   pnpm build && node dist/bin/launcher.js
 * (An OS-service unit for keepalive is a separate install step.)
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { startLauncher } from "../launcher/launcher.js"
import { launcherLog } from "../session/debug_log.js"
import { setLauncherDaemonIdentityMode } from "../pairing/storage.js"

/** Package version for --version reporting (the deploy-stale-binary trap
 *  makes "which build is running" the first diagnostic question). */
function version(): string {
  try {
    // ESM: walk up from dist/bin/ to the package root
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf8"),
    ) as { version?: string }
    return pkg.version ?? "unknown"
  } catch {
    return "unknown"
  }
}

async function main(): Promise<void> {
  // The daemon resolves its identity from the FILE backend only — never the
  // platform keyring (headless service; a launchd-context keyring read was
  // observed to hang). The installer provisions identity.json before this
  // runs. Config identity.storage governs interactive pi sessions only.
  setLauncherDaemonIdentityMode()
  const arg = process.argv[2]
  if (arg === "--version" || arg === "-V") {
    // eslint-disable-next-line no-console
    console.log(`un-bien launcher ${version()}`)
    return
  }
  const handle = await startLauncher()
  // Boot version banner: "which code is the process running" must be
  // answerable from the first line of launcher.log — the package version
  // can look current while the process predates an install (the deploy
  // lesson of 2026-10-14: kickstart ordering was the whole bug).
  launcherLog(`starting, code ${version()}`)
  // eslint-disable-next-line no-console
  console.log(
    `[un-bien launcher] listening on control room ${handle.roomId} ` +
      `(epk ${handle.epk.slice(0, 16)}…) — Ctrl-C to stop`,
  )
  launcherLog(
    `listening on control room ${handle.roomId} (epk ${handle.epk.slice(0, 16)}…)`,
  )

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    // eslint-disable-next-line no-console
    console.log(`[un-bien launcher] ${signal} — shutting down`)
    launcherLog(`${signal} — shutting down`)
    handle.stop()
    process.exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => {
    // Attribution: something restarts this daemon every ~minute — the pid +
    // uptime make the victim (and the killer's cadence) identifiable from
    // the log alone.
    launcherLog(
      `SIGTERM received (pid ${process.pid}, uptime ${Math.round(process.uptime())}s) — shutting down`,
    )
    shutdown("SIGTERM")
  })
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-console
  console.error(`[un-bien launcher] fatal: ${detail}`)
  launcherLog(`fatal: ${detail}`)
  process.exit(1)
})
