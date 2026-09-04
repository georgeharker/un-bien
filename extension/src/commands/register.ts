/**
 * Registration of the whole `/unbien` slash-command surface: the flat
 * `unbien` root command (sub-dispatch + argument completions) and the
 * nested per-action registrations for the SDK's command palette.
 *
 * Moved verbatim from index.ts's extension factory (phase 1 of the
 * index.ts carve-up); the only edits are the `deps.` threading of
 * index.ts module state/helpers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { CommandDeps } from "./deps.js"
import {
  _cmdConfig,
  _cmdIdentity,
  _cmdList,
  _cmdPeers,
  _cmdStatus,
} from "./info.js"
import { _cmdRoot, _cmdSetup, _cmdStart, _cmdStop } from "./lifecycle.js"
import { _cmdBranch, _cmdFork, _cmdNewSession } from "./session_ops.js"
import { _cmdPair, _cmdRevoke, _shortidCompletions } from "./pairing.js"
import { _cmdRelay, _cmdSetRelay } from "./relay.js"
import { _cmdInstall, _cmdUninstall } from "./housekeeping.js"

export function registerUnbienCommands(
  pi: ExtensionAPI,
  deps: CommandDeps,
): void {
  // ── Commands ──────────────────────────────────────────────────────────────
  //
  // Final surface: 8 commands. Pre-2026-05-23 we had 20 commands covering
  // multi-session UDS + granular relay control; in practice every install
  // converged on one session and the relay was always either fully on or
  // fully off. The simplified surface keeps the day-to-day path one-key
  // (`/unbien`) and exposes only the actions that have distinct user
  // intent: setup, status, stop, pair, devices, revoke, set-relay.
  pi.registerCommand("unbien", {
    description:
      "Connect (join local mesh + start relay), or run setup on first use",
    getArgumentCompletions: async (prefix) => {
      if (prefix.startsWith("revoke ") || prefix === "revoke") {
        const shortPrefix =
          prefix === "revoke" ? "" : prefix.slice("revoke ".length)
        return _shortidCompletions(shortPrefix, "revoke ")
      }
      return [
        "setup",
        "status",
        "stop",
        "pair",
        "devices",
        "revoke",
        "rename",
        "set-relay",
        "relay",
        "relay start",
        "relay stop",
        "relay status",
        "relay url",
        "config",
        "identity",
        "identity show",
        "test", // hidden e2e UI harness (dev-only)
        "peers", // plan/25 Wave D — local + cross-PC inventory
        "create",
        "remove",
        "daemons", // daemon registry (plan/26 W1)
        // Fleet ops use the `daemon` prefix so `/unbien stop` keeps
        // meaning "stop this local Pi" — the local UX shipped in plan/25.
        "daemon start",
        "daemon stop",
        "daemon restart",
        "daemon send",
        "daemon status",
        "cron",
        "cron add",
        "cron list",
        "cron remove",
        "cron enable",
        "cron disable",
        "cron run",
        "cron log",
        "install",
        "uninstall", // service install (plan/26 W3)
        // Internal session ops (self-dispatched from the app's structured
        // session_fork / session_navigate / new_session frames).
        "fork",
        "branch",
        "new",
      ]
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({ value: o, label: o }))
    },
    handler: async (args, ctx) => {
      const sub = args.trim()
      if (sub === "") {
        await _cmdRoot(deps, ctx)
      } else if (sub === "setup") {
        await _cmdSetup(ctx)
      } else if (sub === "status") {
        _cmdStatus(deps, ctx)
      } else if (sub === "stop") {
        await _cmdStop(deps, ctx)
      } else if (sub === "pair" || sub.startsWith("pair ")) {
        await _cmdPair(deps, ctx, sub.slice("pair".length).trim())
      } else if (sub === "devices") {
        await _cmdList(deps, ctx)
      } else if (sub.startsWith("revoke")) {
        await _cmdRevoke(deps, sub.slice("revoke".length).trim(), ctx)
      } else if (sub.startsWith("set-relay")) {
        _cmdSetRelay(sub.slice("set-relay".length).trim(), ctx)
      } else if (sub === "relay" || sub.startsWith("relay ")) {
        await _cmdRelay(deps, sub.slice("relay".length).trim(), ctx)
      } else if (sub === "config") {
        _cmdConfig(deps, ctx)
      } else if (sub === "identity" || sub.startsWith("identity ")) {
        await _cmdIdentity(ctx)
      } else if (sub === "test" || sub.startsWith("test ")) {
        // Hidden dev-only e2e UI harness: broadcast canned frames to paired apps.
        deps.safeNotify(
          `[un-bien test] ${deps.runTestScenario(sub.slice("test".length).trim())}`,
          "info",
          ctx,
        )
      } else if (sub === "rename" || sub.startsWith("rename ")) {
        await deps.renameAgent(sub.slice("rename".length).trim())
      } else if (sub === "peers") {
        await _cmdPeers(deps, ctx)
      } else if (sub === "install") {
        _cmdInstall(ctx, { linkCli: true })
      } else if (sub === "uninstall") {
        _cmdUninstall(ctx, { linkCli: true })
      } else if (sub === "fork" || sub.startsWith("fork ")) {
        await _cmdFork(deps, sub.slice("fork".length).trim(), ctx)
      } else if (sub === "branch" || sub.startsWith("branch ")) {
        await _cmdBranch(deps, sub.slice("branch".length).trim(), ctx)
      } else if (sub === "new") {
        await _cmdNewSession(deps, ctx)
      } else {
        await _cmdRoot(deps, ctx)
      }
    },
  })

  // Nested registrations (one entry per public action). The flat handler
  // above already routes `/unbien <sub>` — these exist for the SDK's
  // command palette and slash-autocomplete in some UI modes.
  pi.registerCommand("unbien setup", {
    description: "Run the setup wizard and update local config",
    handler: async (_, ctx) => {
      await _cmdSetup(ctx)
    },
  })
  pi.registerCommand("unbien status", {
    description: "Show local mesh + relay status",
    handler: async (_, ctx) => {
      _cmdStatus(deps, ctx)
    },
  })
  pi.registerCommand("unbien stop", {
    description: "Stop everything (leave local mesh + disconnect relay)",
    handler: async (_, ctx) => {
      await _cmdStop(deps, ctx)
    },
  })
  pi.registerCommand("unbien pair", {
    description:
      "Show a QR code to pair a new mobile device (optional: --ttl <seconds>)",
    handler: async (args, ctx) => {
      await _cmdPair(deps, ctx, args.trim())
    },
  })
  pi.registerCommand("unbien devices", {
    description: "List paired mobile devices",
    handler: async (_, ctx) => {
      await _cmdList(deps, ctx)
    },
  })
  pi.registerCommand("unbien rename", {
    description:
      "Rename this agent in the current session (updates mesh + relay room)",
    handler: async (args) => {
      await deps.renameAgent(args.trim())
    },
  })
  pi.registerCommand("unbien revoke", {
    description: "Revoke a paired device by its shortid",
    getArgumentCompletions: async (prefix) => _shortidCompletions(prefix),
    handler: async (args, ctx) => {
      await _cmdRevoke(deps, args.trim(), ctx)
    },
  })
  pi.registerCommand("unbien set-relay", {
    description: "Persist a new relay URL to user config",
    handler: async (args, ctx) => {
      _cmdSetRelay(args.trim(), ctx)
    },
  })
  pi.registerCommand("unbien config", {
    description: "Show the effective relay URL and where it came from",
    handler: async (_, ctx) => {
      _cmdConfig(deps, ctx)
    },
  })
  pi.registerCommand("unbien identity", {
    description:
      "Show this machine's identity: active EPK (public), backend, and source",
    handler: async (_, ctx) => {
      await _cmdIdentity(ctx)
    },
  })
  pi.registerCommand("unbien identity show", {
    description:
      "Show this machine's identity (EPK/backend/source) — alias of `identity`",
    handler: async (_, ctx) => {
      await _cmdIdentity(ctx)
    },
  })
  pi.registerCommand("unbien relay", {
    description:
      "Relay control: start | stop | status | url <http(s) url> (no arg toggles)",
    handler: async (args, ctx) => {
      await _cmdRelay(deps, args.trim(), ctx)
    },
  })

  // Plan/25 Wave D
  pi.registerCommand("unbien peers", {
    description: "List local + cross-PC mesh peers, grouped by PC label",
    handler: async (_, ctx) => {
      await _cmdPeers(deps, ctx)
    },
  })

  // Internal session ops. The app never surfaces these as slash commands — it
  // sends the structured session_fork / session_navigate / new_session frame
  // and the extension self-dispatches these to reach a command ctx (the only
  // ctx carrying ctx.fork / ctx.navigateTree / ctx.newSession).
  pi.registerCommand("unbien fork", {
    description:
      "Fork a NEW session from a conversation entry (internal: session_fork)",
    handler: async (args, ctx) => {
      await _cmdFork(deps, args.trim(), ctx)
    },
  })
  pi.registerCommand("unbien branch", {
    description:
      "Branch in place from a conversation entry (internal: session_navigate)",
    handler: async (args, ctx) => {
      await _cmdBranch(deps, args.trim(), ctx)
    },
  })
  pi.registerCommand("unbien new", {
    description: "Start a fresh session (internal: new_session)",
    handler: async (_, ctx) => {
      await _cmdNewSession(deps, ctx)
    },
  })

  // Service install / uninstall — the launcher daemon as a system service.
  pi.registerCommand("unbien install", {
    description:
      "Install the un-bien launcher daemon as a system service + link the un-bien CLI (systemd/launchd/Task Scheduler; Windows prompts for admin)",
    handler: async (_, ctx) => {
      _cmdInstall(ctx, { linkCli: true })
    },
  })
  pi.registerCommand("unbien uninstall", {
    description:
      "Remove the un-bien launcher daemon system service + the CLI shims (Windows prompts for admin)",
    handler: async (_, ctx) => {
      _cmdUninstall(ctx, { linkCli: true })
    },
  })
}
