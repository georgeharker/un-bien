/**
 * Launcher package install — `npm install -g @geohar/un-bien-launcher`.
 *
 * The launcher daemon's wrapper is its own npm package, separate from the
 * extension — and nothing else ever updated it (observed live: the daemon
 * ran 0.20.54 across five ext releases because no install path touched the
 * package). `/unbien install launcher` (and `all`) installs/UPGRADES it
 * globally so the daemon runs current code, mirroring the CLI install.
 *
 * Idempotent: npm install -g over an existing install upgrades to latest.
 * We verify the bin afterwards via `unbien-launcher --version` and report
 * what landed.
 */

import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** The published launcher package (see un-bien-launcher/package.json `name`). */
export const LAUNCHER_PACKAGE = "@geohar/un-bien-launcher"

export interface LauncherInstallResult {
  version: string | null
  log: string[]
}

/** Channel: a DEV extension installs the CLI from the `dev` npm tag rather
 *  than the stable `latest` — so the whole installation rides one channel.
 *  Detect dev by the running extension's own package version (a "-dev"
 *  pre-release suffix). */
export function extIsDevChannel(): boolean {
  try {
    const here = fileURLToPath(import.meta.url)
    // dist/daemon/cliInstall.js → ../../.. = the extension package root
    // (three levels, matching _readExtensionVersion's resolution)
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "..", "package.json"), "utf8"),
    ) as { version?: string }
    return typeof pkg.version === "string" && pkg.version.includes("-dev")
  } catch {
    return false
  }
}

export async function installLauncherPackage(
  onLog?: (line: string) => void,
  opts?: { dev?: boolean },
): Promise<LauncherInstallResult> {
  const dev = opts?.dev ?? extIsDevChannel()
  const spec = dev ? `${LAUNCHER_PACKAGE}@dev` : LAUNCHER_PACKAGE
  const log: string[] = []
  const push = (l: string) => {
    log.push(l)
    onLog?.(l)
  }

  // npm is a sibling of node everywhere node is installed; resolve npm-cli.js
  // from process.execPath's tree so we don't depend on `npm` being on a
  // possibly-sparse PATH (same reasoning as findNodeBinary in install.ts).
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
  push(`npm install -g ${spec}${dev ? "  (dev channel — matches this dev extension)" : ""} …`)

  const { stdout, stderr } = await execFileAsync(
    npmCmd,
    ["install", "-g", spec],
    { timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 },
  ).catch((err) => {
    const detail =
      (err as { stderr?: string; message?: string }).stderr ??
      (err as { message?: string }).message ??
      String(err)
    throw new Error(
      `npm install -g ${LAUNCHER_PACKAGE} failed: ${detail}\n` +
        "  If npm isn't found, install Node from https://nodejs.org and retry.",
    )
  })
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    if (line.trim()) push(line.trim())
  }

  // Verify: `unbien-launcher --version` (win32: npm writes unbien.cmd shims).
  let version: string | null = null
  try {
    const bin = process.platform === "win32" ? "unbien-launcher.cmd" : "unbien-launcher"
    const { stdout: vOut } = await execFileAsync(bin, ["--version"], {
      timeout: 15_000,
    })
    version = vOut.trim() || null
    // Unambiguous channel report: the spec requested + the landed version
    // (a -dev suffix on the landed version CONFIRMS the dev channel took).
    const channel = dev
      ? "dev channel (@geohar/un-bien-launcher@dev)"
      : "stable (latest)"
    const landed =
      version && version.includes("-dev")
        ? "dev"
        : version && !version.includes("-dev")
          ? "stable"
          : "unknown"
    push(
      `verified: unbien-launcher ${version ?? "?"} — ${landed} channel` +
        (dev && landed !== "dev"
          ? " ⚠️ requested DEV but the landed binary is NOT a dev build — check npm"
          : "") +
        ` (requested: ${channel})`,
    )
  } catch {
    push(
      "⚠ installed, but `unbien-launcher --version` failed — the npm global bin dir " +
        "may not be on $PATH. Open a new terminal and run `unbien-launcher --version`.",
    )
  }

  return { version, log }
}
