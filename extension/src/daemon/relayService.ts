/**
 * Relay service install — the unbien-relay binary as a user-level OS service.
 *
 * The launcher daemon install (install.ts) manages the MACHINE-side service;
 * this module manages the RELAY-side one. Same shape, different binary:
 *
 *   - **macOS**:  `~/Library/LaunchAgents/com.georgeharker.unbien.relay.plist`
 *   - **Linux**:  `~/.config/systemd/user/unbien-relay.service`
 *   - **Windows**: not supported (the relay is typically hosted on Linux/macOS;
 *     a Task Scheduler variant is future work).
 *
 * The relay binary is a Rust artifact. We resolve it in order:
 *   1. `unbien-relay` on `$PATH` (cargo install's default puts it in
 *      `~/.cargo/bin`, which is usually on PATH)
 *   2. `~/.cargo/bin/unbien-relay` directly (PATH may differ in this shell)
 *   3. `cargo install un-bien-relay` — OFFERED, not run silently: a release
 *      compile of rusqlite's bundled SQLite takes minutes. The caller decides
 *      whether to proceed (`autoInstall` opt).
 *
 * State: the relay resolves its own DB paths from `UNBIEN_STATE_DIR` /
 * `XDG_STATE_HOME` / `~/.local/state/un-bien` — the unit just pins `HOME` so
 * that default resolves even under launchd's sparse environment.
 */

import { execFile, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import {
  renderUnbienEnvPlist,
  renderUnbienEnvSystemd,
  resolvePiAgentDirSnapshot,
} from "./install.js"
import { dirname, join } from "node:path"
import { userInfo } from "node:os"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// ── Identity ───────────────────────────────────────────────────────────────

export const RELAY_LAUNCHD_LABEL = "com.georgeharker.unbien.relay"
export const RELAY_SYSTEMD_UNIT = "unbien-relay.service"
/** Default port the service unit pins via UNBIEN_RELAY_PORT. */
export const RELAY_DEFAULT_PORT = 3000

export function relayLaunchdPlistPath(): string {
  return join(
    homedir(),
    "Library",
    "LaunchAgents",
    "com.georgeharker.unbien.relay.plist",
  )
}

export function relaySystemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "unbien-relay.service")
}

/** The relay's own default state root (matches relay/src/paths.rs). */
export function relayStateDir(): string {
  return join(homedir(), ".local", "state", "un-bien")
}

/** Combined stdout/stderr log launchd appends to (launchd creates the file,
 *  not its parent dir — we mkdir the state root before bootstrap). */
export function relayLogPath(): string {
  return join(relayStateDir(), "relay.log")
}

// ── Binary discovery ───────────────────────────────────────────────────────

export interface RelayBinary {
  /** Absolute path to the unbien-relay executable. */
  path: string
  /** How we found it — surfaced in the install log. */
  source: "path" | "cargo-home" | "cargo-install"
}

/** Locate `unbien-relay` without spawning cargo install. Returns null when
 *  not found — the caller decides whether to offer the slow install. */
export function findRelayBinary(): RelayBinary | null {
  // 1. PATH lookup via `which` / `where` — the common case post-install.
  const which = process.platform === "win32" ? "where" : "which"
  try {
    const out = execFileSync(which, ["unbien-relay"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    const first = out.split("\n")[0]?.trim()
    if (first && existsSync(first)) {
      return { path: first, source: "path" }
    }
  } catch {
    /* not on PATH — fall through */
  }
  // 2. cargo's default bin dir — PATH in this (GUI-launched / TUI) context
  //    may be sparser than the user's login shell.
  const cargoBin = join(homedir(), ".cargo", "bin", "unbien-relay")
  if (existsSync(cargoBin)) {
    return { path: cargoBin, source: "cargo-home" }
  }
  return null
}

/** Whether `cargo` itself is available (to compile the relay when missing). */
export function hasCargo(): boolean {
  const which = process.platform === "win32" ? "where" : "which"
  try {
    execFileSync(which, ["cargo"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return true
  } catch {
    const cargoBin = join(homedir(), ".cargo", "bin", "cargo")
    return existsSync(cargoBin)
  }
}

/** Compile + install the relay via cargo. Takes minutes (bundled SQLite C
 *  compile) — the caller MUST have surfaced that to the user first. */
export async function cargoInstallRelay(
  onLog?: (line: string) => void,
): Promise<RelayBinary> {
  const { stdout, stderr } = await execFileAsync(
    "cargo",
    ["install", "un-bien-relay"],
    { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
  ).catch((err) => {
    const detail =
      (err as { stderr?: string; message?: string }).stderr ??
      (err as { message?: string }).message ??
      String(err)
    throw new Error(`cargo install un-bien-relay failed: ${detail}`)
  })
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    if (line.trim()) onLog?.(line.trim())
  }
  const cargoBin = join(homedir(), ".cargo", "bin", "unbien-relay")
  if (!existsSync(cargoBin)) {
    throw new Error(`cargo install reported success but ${cargoBin} is missing`)
  }
  return { path: cargoBin, source: "cargo-install" }
}

// ── Template rendering ─────────────────────────────────────────────────────

export interface RelayRenderVars {
  relayBin: string
  port: number
  home: string
  logPath: string
  /** PI agent config dir — keeps env shape symmetric with the launcher's. */
  piAgentDir: string
  /** Pre-rendered UNBIEN_* env entries (see install.ts helpers). */
  unbienEnvPlist: string
  unbienEnvSystemd: string
  /** Pi session storage dir snapshot (parity with the launcher's env). */
  sessionDir: string
}

export function renderRelayTemplate(
  template: string,
  vars: RelayRenderVars,
): string {
  return template
    .replace(/\{RELAY_BIN\}/g, vars.relayBin)
    .replace(/\{PORT\}/g, String(vars.port))
    .replace(/\{HOME\}/g, vars.home)
    .replace(/\{LOG\}/g, vars.logPath)
    .replace(/\{PI_AGENT_DIR\}/g, vars.piAgentDir)
    .replace(/\{UNBIEN_ENV_PLIST\}/g, vars.unbienEnvPlist)
    .replace(/\{UNBIEN_ENV_SYSTEMD\}/g, vars.unbienEnvSystemd)
    .replace(/\{SESSION_DIR\}/g, vars.sessionDir)
}

function relayTemplatePath(kind: "launchd" | "systemd"): string {
  const here = fileURLToPath(import.meta.url) // dist/daemon/relayService.js
  const pkgRoot = dirname(dirname(dirname(here))) // package root
  return join(
    pkgRoot,
    "service-templates",
    kind === "launchd"
      ? "relay-launchd.plist.template"
      : "relay-systemd.service.template",
  )
}

// ── Install / uninstall ────────────────────────────────────────────────────

export interface RelayInstallResult {
  platform: "macos" | "linux"
  unitPath: string
  binary: string
  port: number
  log: string[]
}

export async function installRelayService(opts: {
  port?: number
  /** When the binary is missing: offer cargo install (caller has already
   *  warned it takes minutes). Default false → throw with instructions. */
  autoInstall?: boolean
  onLog?: (line: string) => void
}): Promise<RelayInstallResult> {
  const log: string[] = []
  const push = (l: string) => {
    log.push(l)
    opts.onLog?.(l)
  }

  if (process.platform === "darwin") {
    // macOS path
  } else if (process.platform === "linux") {
    // Linux path
  } else {
    throw new Error(
      `relay service install supports macOS and Linux (this is ${process.platform}). ` +
        "On Windows, run the relay under Docker: docker build -t un-bien-relay ./relay",
    )
  }
  const platform = process.platform === "darwin" ? "macos" : "linux"

  let binary = findRelayBinary()
  if (!binary) {
    if (opts.autoInstall && hasCargo()) {
      push(
        "relay binary not found — compiling via cargo install (this takes a few minutes)…",
      )
      binary = await cargoInstallRelay(push)
    } else {
      throw new Error(
        "`unbien-relay` binary not found. Either:\n" +
          "  • cargo install un-bien-relay        (compiles from source; needs Rust)\n" +
          "  • download a release binary: https://github.com/georgeharker/un-bien/releases\n" +
          "then re-run /unbien install relay",
      )
    }
  }
  push(`relay binary: ${binary.path} (${binary.source})`)

  const port = opts.port ?? RELAY_DEFAULT_PORT
  const vars: RelayRenderVars = {
    relayBin: binary.path,
    port,
    home: homedir(),
    logPath: relayLogPath(),
    piAgentDir: resolvePiAgentDirSnapshot(),
    unbienEnvPlist: renderUnbienEnvPlist(),
    unbienEnvSystemd: renderUnbienEnvSystemd(),
    sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR ?? "",
  }
  const tplPath = relayTemplatePath(
    platform === "macos" ? "launchd" : "systemd",
  )
  if (!existsSync(tplPath)) {
    throw new Error(`relay service template missing: ${tplPath}`)
  }
  const rendered = renderRelayTemplate(readFileSync(tplPath, "utf8"), vars)

  const unitPath =
    platform === "macos" ? relayLaunchdPlistPath() : relaySystemdUnitPath()
  mkdirSync(dirname(unitPath), { recursive: true })
  writeFileSync(unitPath, rendered)
  push(`wrote ${unitPath}`)

  if (platform === "macos") {
    // launchd creates the plist's Standard{Out,Error}Path file but not its
    // parent dir — ensure the state root exists or the redirect silently
    // vanishes on a machine that never ran the relay.
    mkdirSync(dirname(relayLogPath()), { recursive: true })
    const uid = userInfo().uid
    // 30s timeouts, same as the Linux systemctl calls below — a wedged
    // launchd must fail loudly, not hang the install silently.
    try {
      await execFileAsync("launchctl", ["bootout", `gui/${uid}`, unitPath], {
        timeout: 30_000,
      })
    } catch {
      /* no stale entry — fine */
    }
    try {
      await execFileAsync("launchctl", ["bootstrap", `gui/${uid}`, unitPath], {
        timeout: 30_000,
      })
    } catch (err) {
      throw new Error(
        `launchctl bootstrap failed — check Console.app for launchd errors for ` +
          `${unitPath}, or load manually with: launchctl bootstrap gui/${uid} ${unitPath}. ` +
          `(${String(err)})`,
      )
    }
    push(`activated via launchctl bootstrap gui/${uid}`)
  } else {
    // 30s timeout each: `systemctl --user` against a missing/wedged user bus
    // must fail LOUDLY here (surfaced by the caller's per-component catch), not
    // hang the whole install silently.
    try {
      await execFileAsync("systemctl", ["--user", "daemon-reload"], {
        timeout: 30_000,
      })
      await execFileAsync(
        "systemctl",
        ["--user", "enable", RELAY_SYSTEMD_UNIT],
        { timeout: 30_000 },
      )
      // restart (NOT enable --now): bounce an already-running relay so the
      // fresh unit + binary take effect — parity with the macOS
      // bootout+bootstrap path above. restart also starts an inactive unit,
      // so fresh installs behave identically.
      await execFileAsync(
        "systemctl",
        ["--user", "restart", RELAY_SYSTEMD_UNIT],
        { timeout: 30_000 },
      )
    } catch (err) {
      throw new Error(
        `systemctl --user failed — is a user systemd session available on this ` +
          `machine? (SSH/headless: run 'loginctl enable-linger ${userInfo().username}'; ` +
          `WSL: enable systemd in /etc/wsl.conf). Start manually with: ` +
          `systemctl --user restart ${RELAY_SYSTEMD_UNIT}. (${String(err)})`,
      )
    }
    push("activated via systemctl --user enable + restart")
  }

  return { platform, unitPath, binary: binary.path, port, log }
}

export async function uninstallRelayService(): Promise<{
  unitPath: string
  removed: boolean
  log: string[]
}> {
  const log: string[] = []
  const platform = process.platform
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(
      `relay service uninstall supports macOS and Linux only (this is ${platform})`,
    )
  }
  const unitPath =
    platform === "darwin" ? relayLaunchdPlistPath() : relaySystemdUnitPath()
  const existed = existsSync(unitPath)

  if (existed) {
    if (platform === "darwin") {
      const uid = userInfo().uid
      try {
        await execFileAsync("launchctl", ["bootout", `gui/${uid}`, unitPath])
        log.push("launchctl bootout done")
      } catch {
        log.push("launchctl bootout: not loaded (ok)")
      }
    } else {
      try {
        await execFileAsync("systemctl", [
          "--user",
          "disable",
          "--now",
          RELAY_SYSTEMD_UNIT,
        ])
        await execFileAsync("systemctl", ["--user", "daemon-reload"])
        log.push("systemctl disable --now + daemon-reload done")
      } catch {
        log.push("systemctl disable failed (unit may not be loaded)")
      }
    }
    const { rmSync } = await import("node:fs")
    rmSync(unitPath)
    log.push(`removed ${unitPath}`)
  } else {
    log.push(`no unit at ${unitPath} (nothing to do)`)
  }

  return { unitPath, removed: existed, log }
}
