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
  installService,
  uninstallService,
  linkCliBinaries,
  unlinkCliBinaries,
} from "../daemon/install.js"
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
/** Returns true on success, false when install failed (so the standalone CLI
 *  can exit non-zero — e.g. the Cockpit / CI detect failure by exit code).
 *  We do NOT process.exit here: this also runs inside the Pi TUI, where exiting
 *  would kill the session. */
export function _cmdInstall(
  ctx: Pick<ExtensionContext, "ui">,
  opts: { linkCli?: boolean } = {},
): boolean {
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
    ctx.ui.notify(sections.join("\n"), "info")
    return true
  } catch (err) {
    ctx.ui.notify(`[un-bien] install failed: ${String(err)}`, "error")
    return false
  }
}

export function _cmdUninstall(
  ctx: Pick<ExtensionContext, "ui">,
  opts: { linkCli?: boolean } = {},
): void {
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
    ctx.ui.notify(sections.join("\n"), "info")
  } catch (err) {
    ctx.ui.notify(`[un-bien] uninstall failed: ${String(err)}`, "error")
  }
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
  // ~/.pi/un-bien/skills/agent-network/SKILL.md.
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
    // Cleanup legacy deploy at ~/.pi/un-bien/skills/agent-network.md (flat
    // layout, fails the Pi SDK's name-vs-parent-dir validation).
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
