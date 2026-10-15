/**
 * `/unbien` housekeeping commands: service install/uninstall, the
 * agent-network skill deploy, extension-dir/skill-path resolution, and the
 * `unbien claude` CLI launcher.
 *
 * None of these touch index.ts module state, so they take no CommandDeps —
 * everything they use is imported from pi-independent modules. Carved out
 * of index.ts (phase 1 of the index.ts carve-up).
 *
 * NOTE: this file lives one directory deeper than index.ts used to, so the
 * import.meta.url-based path math (extension dir, packaged skill, mesh
 * server) climbs one extra level — behavior is otherwise identical.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
  LAUNCHD_LABEL,
  LAUNCHER_SYSTEMD_UNIT,
  installService,
  uninstallService,
  linkCliBinaries,
  unlinkCliBinaries,
} from "../daemon/install.js"
import {
  RELAY_LAUNCHD_LABEL,
  RELAY_SYSTEMD_UNIT,
  type RelayInstallResult,
  installRelayService,
  uninstallRelayService,
} from "../daemon/relayService.js"
import { installCliPackage } from "../daemon/cliInstall.js"
import { installLauncherPackage } from "../daemon/launcherInstall.js"
import {
  defaultAgentName,
  localConfigExists,
  saveLocalConfig,
} from "../session/local_config.js"
import { skillsDir } from "../session/global_config.js"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

// ── Install/uninstall the launcher-daemon service ────────────────────────────
//
// Installs the un-bien launcher daemon as a user-level system service (systemd
// `--user` unit on Linux, launchd LaunchAgent on macOS, Task Scheduler on
// Windows). Once installed the launcher daemon starts at login + survives
// reboots. Uninstall is the inverse.

/**
 * `linkCli` controls whether we symlink `un-bien` into `~/.local/bin/`. The
 * slash-command path passes `true` (user is inside Pi's TUI — they installed
 * via `pi install npm:un-bien` and need us to expose the CLI for them). The
 * standalone-CLI path passes `false` because the user is already running our
 * binary from PATH (they did `npm install -g un-bien`), so re-linking would
 * point their `un-bien` at the Pi-extension copy and diverge on upgrades.
 */
/** Readable suffix for the relay's upgrade action in the durable summary —
 *  unknown/missing actions are left unannotated. */
function relayActionSuffix(action: RelayInstallResult["relayAction"]): string {
  return action && action !== "unknown" ? ` — ${action}` : ""
}

/** Launcher-daemon install WITHOUT notifying — returns the report sections.
 *  _cmdInstallTarget consolidates these into ONE final notify: the pi TUI
 *  replaces toasts as they arrive, so per-step messages were wiping each
 *  other out — only the last toast stayed visible (the "all" run looked like
 *  it only installed the relay). */
function installLauncherSections(
  opts: { linkCli?: boolean } = {},
): { ok: boolean; sections: string[] } {
  const linkCli = opts.linkCli ?? false
  try {
    const result = installService()
    const sections = [
      `[un-bien] Launcher daemon service installed (${result.platform}).`,
      `  Unit: ${result.unitPath}`,
      `  Steps:\n${result.log.map((l) => "    " + l).join("\n")}`,
    ]
    if (linkCli) {
      const link = linkCliBinaries()
      sections.push(
        `  CLI bins linked into ${link.binDir}:`,
        link.links.map((l) => `    ${l.name} → ${l.target}`).join("\n"),
        `  Steps:\n${link.log.map((l) => "    " + l).join("\n")}`,
      )
      if (!link.onPath) {
        if (process.platform === "win32") {
          sections.push(
            `  ⚠ ${link.binDir} was just added to your user PATH (it wasn't there yet).`,
            `    Open a NEW terminal and run \`unbien status\` to verify.`,
          )
        } else {
          sections.push(
            `  ⚠ ${link.binDir} is not on $PATH yet. Add this line to ~/.zshrc / ~/.bashrc:`,
            `      export PATH="$HOME/.local/bin:$PATH"`,
            `    Then open a new terminal and run \`unbien status\` to verify.`,
          )
        }
      }
    }
    return { ok: true, sections }
  } catch (err) {
    return {
      ok: false,
      sections: [`[un-bien] launcher install failed: ${String(err)}`],
    }
  }
}

/** Standalone launcher install: runs the sections builder and reports it.
 *  The multi-component `/unbien install` path goes through _cmdInstallTarget
 *  (which consolidates into one final notify). */
export function _cmdInstall(
  ctx: Pick<ExtensionContext, "ui">,
  opts: { linkCli?: boolean } = {},
): boolean {
  const { ok, sections } = installLauncherSections(opts)
  ctx.ui.notify(sections.join("\n"), ok ? "info" : "error")
  return ok
}

/** Launcher-daemon uninstall WITHOUT notifying — see installLauncherSections. */
function uninstallLauncherSections(opts: {
  linkCli?: boolean
} = {}): { sections: string[] } {
  const linkCli = opts.linkCli ?? false
  try {
    const result = uninstallService()
    const sections = [
      `[un-bien] Launcher daemon service uninstalled (${result.platform}).`,
      `  Unit: ${result.unitPath} (${result.removed ? "removed" : "not present"})`,
      `  Steps:\n${result.log.map((l) => "    " + l).join("\n")}`,
    ]
    if (linkCli) {
      const unlink = unlinkCliBinaries()
      sections.push(
        `  CLI bins cleanup (${unlink.binDir}):`,
        unlink.removed
          .map(
            (r) => `    ${r.name} (${r.existed ? "removed" : "not present"})`,
          )
          .join("\n"),
      )
    }
    return { sections }
  } catch (err) {
    return { sections: [`[un-bien] launcher uninstall failed: ${String(err)}`] }
  }
}

/** Standalone launcher uninstall — see _cmdInstall. */
export function _cmdUninstall(
  ctx: Pick<ExtensionContext, "ui">,
  opts: { linkCli?: boolean } = {},
): void {
  const { sections } = uninstallLauncherSections(opts)
  ctx.ui.notify(sections.join("\n"), "info")
}

// ── Component install dispatch (relay / launcher / cli / all) ──────────────

export type InstallTarget = "launcher" | "relay" | "cli" | "all"

export function parseInstallTarget(raw: string): InstallTarget | null {
  const t = raw.trim().toLowerCase()
  if (t === "" || t === "all") return "all"
  if (t === "launcher" || t === "daemon" || t === "service") return "launcher"
  if (t === "relay") return "relay"
  if (t === "cli") return "cli"
  return null
}

/** Install one or all un-bien components. Async: relay/cli installs spawn
 *  package managers (cargo/npm) that take minutes. Returns true only if every
 *  attempted component succeeded.
 *
 *  Ordering for `all` is launcher → cli → relay: the launcher is a fast,
 *  purely-local supervisor render + activation (systemd/launchd); the relay
 *  goes LAST because on a fresh Linux box it may compile via cargo for
 *  minutes.
 *
 *  REPORTING: the pi TUI replaces notify toasts as they arrive — per-step
 *  messages wipe each other out, so an "all" run looked like it only
 *  installed the relay. Intermediate "installing X…" toasts are kept as
 *  transient alive-signals, but the DURABLE report is the ONE consolidated
 *  notify at the end (all sections joined, error level if anything failed).
 *  Raw package-manager output (cargo/npm lines) streams as transient toasts
 *  and is NOT copied into the summary — the component result lines carry the
 *  verdict. */
export async function _cmdInstallTarget(
  ctx: Pick<ExtensionContext, "ui">,
  target: InstallTarget,
  opts: { linkCli?: boolean } = {},
): Promise<boolean> {
  const linkCli = opts.linkCli ?? false
  const summary: string[] = []
  let ok = true

  const want =
    target === "all"
      ? (["launcher", "cli", "relay"] as const)
      : ([target] as const)

  for (const component of want) {
    if (component === "launcher") {
      ctx.ui.notify("[un-bien] installing launcher daemon…", "info")
      // Headless-service identity: the launcher NEVER touches the keychain
      // (file-only daemon mode; a launchd-context keyring read was observed
      // to hang). Ensure identity.json exists so the daemon resolves its
      // key from disk. Key UNCHANGED — and the config's identity.storage
      // is left alone: it governs interactive pi sessions only.
      try {
        const { provisionFileIdentity } = await import("../pairing/storage.js")
        const { path, wrote } = await provisionFileIdentity()
        summary.push(
          `[un-bien] launcher identity: file backend (${path})` +
            (wrote ? " — provisioned." : " — already present.") +
            ` The launcher daemon is file-stored by design (never the keychain);`,
          `  config identity.storage applies to interactive pi sessions only.`,
        )
      } catch (err) {
        ok = false
        summary.push(`[un-bien] identity provisioning failed: ${String(err)}`)
      }
      const launcher = installLauncherSections({ linkCli })
      ok = ok && launcher.ok
      summary.push(...launcher.sections)
      // The launcher PACKAGE must be installed/updated too — the service
      // above runs whatever package is on disk, and NOTHING else ever
      // updated it (observed live: the daemon ran 0.20.54 across five ext
      // releases because no install path touched the package). Mirrors the
      // CLI install: dev channel when this extension is a dev build.
      const lp = await installLauncherPackage((l) =>
        ctx.ui.notify(`[launcher] ${l}`, "info"),
      )
      summary.push(
        `[un-bien] launcher package installed/updated` +
          `${lp.version ? ` (unbien-launcher ${lp.version})` : ""}.`,
      )
      continue
    }
    ctx.ui.notify(`[un-bien] installing ${component}…`, "info")
    try {
      if (component === "relay") {
        const r = await installRelayService({
          autoInstall: true,
          // transient progress toasts (replaced as they arrive)
          onLog: (l) => ctx.ui.notify(`[relay] ${l}`, "info"),
        })
        const relayLine = r.relayVersion
          ? `  Binary: ${r.binary} (unbien-relay ${r.relayVersion}${relayActionSuffix(r.relayAction)})`
          : `  Binary: ${r.binary}`
        summary.push(
          `[un-bien] Relay service installed (${r.platform}).`,
          relayLine,
          `  Unit: ${r.unitPath}`,
          // Display hint for the app's Add-Relay sheet — NOT a connection.
          // The scheme prefix (plain ws, no TLS) is shown by the sheet's
          // placeholder; the plain-ws posture is a documented design decision
          // (APPSTORE.md ATS notes: user-configured LAN/Tailnet endpoints).
          `  Port: ${r.port} — add the relay in the app (plain WebSocket, host:port; no TLS by design)`,
        )
      } else if (component === "cli") {
        const r = await installCliPackage((l) =>
          ctx.ui.notify(`[cli] ${l}`, "info"),
        )
        const landedChannel = r.version?.includes("-dev") ? "dev channel" : "stable"
        summary.push(
          `[un-bien] CLI installed${r.version ? ` (unbien ${r.version})` : ""} — ${landedChannel}.`,
        )
      }
    } catch (err) {
      ok = false
      summary.push(`[un-bien] ${component} install failed: ${String(err)}`)
    }
  }

  // ALWAYS REKICK (macOS/linux): a launchd service keeps the OLD image loaded
  // until restarted, and systemd --user won't pick up a replaced binary until
  // restart either — an install without a rekick yields "installed but stale"
  // running code (observed: relay updated to 0.7.24 on disk while the service
  // kept 0.7.22 behavior, including the legacy gate read). Kick BOTH services:
  // the launcher daemon follows this extension's dist and the relay runs its
  // own binary; whichever component was touched, both may need the new files.
  if (process.platform === "darwin") {
    for (const label of [LAUNCHD_LABEL, RELAY_LAUNCHD_LABEL]) {
      const r = spawnSync(
        "launchctl",
        ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${label}`],
        { stdio: "ignore" },
      )
      summary.push(
        r.status === 0
          ? `[un-bien] restarted service: ${label}`
          : `[un-bien] could not restart ${label} — not installed (${r.status})`,
      )
    }
  } else if (process.platform === "linux") {
    // systemd --user units (unbien-launcher.service / unbien-relay.service —
    // see install.ts's systemdUnitPath + relayService.ts's unit constant).
    // restart (not try-restart) so a not-yet-running unit comes up too.
    for (const unit of [LAUNCHER_SYSTEMD_UNIT, RELAY_SYSTEMD_UNIT]) {
      const r = spawnSync("systemctl", ["--user", "restart", unit], {
        stdio: "ignore",
      })
      summary.push(
        r.status === 0
          ? `[un-bien] restarted service: ${unit}`
          : `[un-bien] could not restart ${unit} — not installed? (${r.status})`,
      )
    }
  } else {
    summary.push(
      "[un-bien] non-macOS/linux: restart the launcher + relay services to load the new files.",
    )
  }

  // The DURABLE report — last toast standing locally, and broadcast to
  // attached app owners as a transient toast (slash commands run remotely:
  // this is their only feedback surface).
  // ctx.ui.notify is CHAINED (session_start) to broadcast to attached app
  // owners - one call renders locally AND toasts remotely.
  ctx.ui.notify(summary.join("\n"), ok ? "info" : "error")
  return ok
}

/** Uninstall counterpart: relay service + launcher service + CLI shims.
 *  Same consolidated-report rule as _cmdInstallTarget: one final notify
 *  carries everything (TUI toasts replace each other). */
export async function _cmdUninstallTarget(
  ctx: Pick<ExtensionContext, "ui">,
  target: InstallTarget,
  opts: { linkCli?: boolean } = {},
): Promise<void> {
  // Same launcher-first order as install (see _cmdInstallTarget).
  const want =
    target === "all" ? (["launcher", "relay"] as const) : ([target] as const)

  // CLI-shim cleanup rides FULL uninstalls only: `uninstall relay` must not
  // delete the unbien-admin binary that invoked it. Component-scoped
  // uninstalls pass linkCli: false down.
  const componentOpts =
    target === "all" ? opts : { ...opts, linkCli: false }

  const summary: string[] = []
  let ok = true

  if (want.includes("launcher")) {
    ctx.ui.notify("[un-bien] uninstalling launcher daemon…", "info")
    const launcher = uninstallLauncherSections(componentOpts)
    summary.push(...launcher.sections)
    if (launcher.sections.some((s) => s.includes("uninstall failed"))) ok = false
  }
  if (want.includes("relay")) {
    ctx.ui.notify("[un-bien] uninstalling relay service…", "info")
    try {
      const r = await uninstallRelayService()
      summary.push(
        `[un-bien] Relay service uninstalled (${r.removed ? "removed" : "not present"}).`,
        `  Unit: ${r.unitPath}`,
        `  Steps:\n${r.log.map((l) => "    " + l).join("\n")}`,
      )
    } catch (err) {
      ok = false
      summary.push(`[un-bien] relay uninstall failed: ${String(err)}`)
    }
  }

  ctx.ui.notify(summary.join("\n"), ok ? "info" : "error")
}

// ── Agent-network commands (plano 19) ─────────────────────────────────────────
function _resolveExtensionDir(): string {
  // dist/commands/housekeeping.js → dist/commands; skills sit at
  // <extensionRoot>/skills/. When we run from src/ via tsx (dev), this file
  // is in src/commands/ and skills/ is two levels up. We detect by checking
  // both locations.
  const here = fileURLToPath(import.meta.url)
  // dist/commands/housekeeping.js or src/commands/housekeeping.ts → parent =
  // <dist or src>/commands; sibling = ../../skills (dist) / ../skills (src)
  const parent = here.replace(/\/[^/]+$/, "")
  const candidateA = join(parent, "..", "..", "skills") // dist/commands → ../../skills
  const candidateB = join(parent, "..", "skills") // src/commands → ../skills
  if (existsSync(candidateA)) return parent.replace(/\/(dist\/)?commands$/, "")
  if (existsSync(candidateB)) return parent.replace(/\/commands$/, "")
  return parent.replace(/\/commands$/, "")
}

export function _deployAgentNetworkSkill(): void {
  // Pi SDK spec (core/skills.js): every skill must live at
  //   <skillsRoot>/<skill-name>/SKILL.md
  // The skill `name:` frontmatter must equal the parent directory name. We
  // ship the source pre-arranged that way so deploy is a straight copy into
  // `<state root>/skills/agent-network/SKILL.md`.
  const root = _resolveExtensionDir()
  const src1 = join(root, "skills", "agent-network", "SKILL.md")
  const src2 = join(root, "..", "skills", "agent-network", "SKILL.md")
  const src = existsSync(src1) ? src1 : existsSync(src2) ? src2 : null
  if (!src) return
  const dstDir = join(skillsDir(), "agent-network")
  const dst = join(dstDir, "SKILL.md")
  try {
    mkdirSync(dstDir, { recursive: true })
    copyFileSync(src, dst)
    // Cleanup legacy flat-layout deploy at `<state root>/skills/agent-network.md`
    // (fails the Pi SDK's name-vs-parent-dir validation).
    const legacy = join(skillsDir(), "agent-network.md")
    if (existsSync(legacy)) {
      try {
        unlinkSync(legacy)
      } catch {
        /* ignored */
      }
    }
  } catch {
    /* best-effort */
  }
}

// ── `unbien claude` — launch Claude Code connected to the mesh ─────────────

/**
 * Resolve the packaged agent-network skill path
 * (`<pkgRoot>/skills/agent-network/SKILL.md`). Single source of truth shared
 * by both runtimes: Pi discovers it via `resources_discover`, and the Claude
 * launcher injects it as a system prompt (see `_cmdClaudeCli`). Returns null
 * if the file is missing (e.g. running before `pnpm build`).
 */
function _agentNetworkSkillPath(): string | null {
  const here = fileURLToPath(import.meta.url) // dist/commands/housekeeping.js (or src/ via tsx)
  const pkgRoot = dirname(dirname(dirname(here))) // package root (dist/commands → ../..; src/commands → ../..)
  const skill = join(pkgRoot, "skills", "agent-network", "SKILL.md")
  return existsSync(skill) ? skill : null
}

export async function _cmdClaudeCli(args: string[]): Promise<void> {
  // Contract: `unbien claude [cwd] [claude-flags...]`. The optional cwd is
  // ONLY the leading positional (first token, not a flag); everything after it
  // is forwarded verbatim to the `claude` binary (e.g. `--resume`, `-c`,
  // `-p "prompt"`). Restricting cwd to the leading token avoids mistaking a
  // flag's value (e.g. the id in `--resume <id>`) for the cwd.
  const hasCwdArg = args.length > 0 && !args[0]!.startsWith("-")
  const targetCwd = hasCwdArg ? args[0]! : process.cwd()
  const passthroughArgs = hasCwdArg ? args.slice(1) : args

  // Wizard when no local config exists
  if (!localConfigExists(targetCwd)) {
    const suggested = defaultAgentName(targetCwd)
    process.stdout.write(`\n[un-bien] No config found for ${targetCwd}\n`)
    process.stdout.write("Let's set up this agent.\n\n")

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    const agentName: string = await new Promise((res) =>
      rl.question(`Agent name [${suggested}]: `, (ans) => {
        rl.close()
        res(ans.trim() || suggested)
      }),
    )

    saveLocalConfig(targetCwd, {
      agent_name: agentName,
      auto_start_relay: true,
    })
    process.stdout.write(`[un-bien] Config saved: agent="${agentName}"\n\n`)
  }

  // Resolve mesh server script path (dist/mcp/mesh_server.js)
  const here = fileURLToPath(import.meta.url)
  const distRoot = dirname(here) // dist/commands → mesh server at ../mcp/
  const meshServerPath = resolve(distRoot, "..", "mcp/mesh_server.js")

  if (!existsSync(meshServerPath)) {
    console.log(
      `[un-bien] mesh server not found at ${meshServerPath}. Run pnpm build first.`,
    )
    process.exit(1)
  }

  const absCwd = resolve(targetCwd)
  const SERVER_NAME = "un-bien-mesh"

  // The mesh MCP must be visible ONLY inside a `unbien claude` session — a
  // plain `claude` in the same repo must NOT inherit it (otherwise every
  // ordinary session silently joins the mesh as a stray agent).
  //
  // Older builds registered the server with `claude mcp add -s local`. That
  // scope lives in `~/.claude.json` keyed by the **git repo root** and is
  // inherited by EVERY claude session under that root — which is exactly the
  // leak we're closing. So we no longer write any persistent scope; we load
  // the server through an ephemeral `--mcp-config <tmpfile>` passed on the
  // launch command line (see below). That config is session-only: it is never
  // recorded in any scope `claude mcp list` enumerates, so a normal `claude`
  // sees nothing.
  //
  // Migration: best-effort scrub of the stale `-s local` entry that prior
  // versions left behind (and that is the source of the inherited-mesh bug).
  // Idempotent — a no-op (non-zero, ignored) when the entry is already gone.
  spawnSync("claude", ["mcp", "remove", SERVER_NAME, "-s", "local"], {
    cwd: absCwd,
    stdio: "ignore",
    shell: false,
  })

  // Ephemeral MCP config consumed by `--mcp-config` below. We do NOT bake a
  // `cwd` into it: the server resolves its folder from its own `process.cwd()`,
  // which Claude sets to the directory the session was launched in (verified
  // empirically — NOT the git root, NOT CLAUDE_PROJECT_DIR). We spawn claude
  // with `cwd: absCwd`, the MCP child inherits it, so the server self-identifies
  // as the right agent without leaking that path to any other session.
  // Unique per pid so concurrent `unbien claude` launches don't collide.
  const mcpConfigPath = join(tmpdir(), `un-bien-mesh-mcp-${process.pid}.json`)
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: { command: process.execPath, args: [meshServerPath] },
      },
    }),
  )

  // Inject the agent-network protocol as a system prompt instead of deploying a
  // skill file into ~/.claude. Anyone running `unbien claude` is here to use
  // the mesh, so load the protocol unconditionally — no lazy skill gating, no
  // global skills-dir pollution, and the packaged file is the single source of
  // truth shared with the Pi runtime. Skipped only if the file is missing.
  const skillPath = _agentNetworkSkillPath()

  // Launch flags:
  //   --mcp-config <tmpfile>                       — load the mesh server for
  //       THIS session only (never a persistent scope). We intentionally omit
  //       `--strict-mcp-config` so the user's own persistent MCP servers stay
  //       available alongside the mesh.
  //   --dangerously-load-development-channels TAG  — enable claude/channel push
  //       for our local (non-allowlisted) server, so incoming mesh messages
  //       wake Claude instead of waiting for a get_messages poll. Entries must
  //       be tagged: `server:<name>` for a manually configured MCP server
  //       (`plugin:<name>@<marketplace>` is the plugin form). Shows a one-time
  //       confirmation dialog at startup. Works against the `--mcp-config`
  //       server in current Claude Code; if a build ever fails to match it, the
  //       per-turn `get_messages` poll (mandated by the mesh protocol) still
  //       delivers — we lose the wake, not the messages.
  //   --dangerously-skip-permissions               — auto-approve tool calls
  //   --append-system-prompt-file=<skill>           — load the mesh protocol
  // `--append-system-prompt-file` uses the glued `--flag=value` form (a SINGLE
  // argv token) on purpose: tools that restore a session by capturing and
  // replaying the live process's argv (e.g. cmux) drop the TRAILING token,
  // which here was the skill path — leaving a dangling `--append-system-prompt-file`
  // → `claude` aborts with "argument missing" and the session never comes back.
  // As one token, the worst case is the whole flag being dropped: claude still
  // starts (just without the injected protocol), which is recoverable instead
  // of fatal. (The other flags stay separate pairs — never last, so unaffected,
  // and we don't risk a parser that may not accept `=`.)
  // Any extra args the user passed (e.g. `--resume`, `-c`) are appended last so
  // they reach the claude binary; ours come first as sensible defaults.
  try {
    spawnSync(
      "claude",
      [
        "--mcp-config",
        mcpConfigPath,
        "--dangerously-load-development-channels",
        `server:${SERVER_NAME}`,
        "--dangerously-skip-permissions",
        ...(skillPath ? [`--append-system-prompt-file=${skillPath}`] : []),
        ...passthroughArgs,
      ],
      {
        cwd: absCwd,
        stdio: "inherit",
        shell: false,
      },
    )
  } finally {
    // Session over — drop the ephemeral config so it never lingers as a stray
    // file. spawnSync blocks until claude exits, so claude has long since read
    // it. Best-effort: ignore if already gone.
    try {
      unlinkSync(mcpConfigPath)
    } catch {
      /* already removed */
    }
  }
}
