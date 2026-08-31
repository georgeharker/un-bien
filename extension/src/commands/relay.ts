/**
 * `/unbien` relay control commands: set-relay (persist the URL) and the
 * `relay [start|stop|status|url]` verb family (issue #119).
 *
 * The verbs map onto the same primitives the RPC control channel uses, so
 * the slash command and the Cockpit button can't drift. Everything they
 * need from index.ts's module scope comes through `CommandDeps` (see
 * deps.ts). Carved out of index.ts (phase 1 of the index.ts carve-up).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isWebSocketScheme, isValidRelayUrl, saveConfig } from "../config.js"
import type { CommandDeps } from "./deps.js"
import { _cmdStatus } from "./info.js"
import { _cmdStart } from "./lifecycle.js"

export function _cmdSetRelay(
  arg: string,
  ctx: Pick<ExtensionContext, "ui">,
): void {
  const raw = arg.trim()
  if (!raw) {
    ctx.ui.notify(
      "[un-bien] Usage: /unbien set-relay <http:// or https:// url>",
      "warning",
    )
    return
  }
  if (isWebSocketScheme(raw)) {
    ctx.ui.notify(
      `[un-bien] Use http:// or https://. The extension converts to WebSocket automatically.`,
      "error",
    )
    return
  }
  if (!isValidRelayUrl(raw)) {
    ctx.ui.notify(
      `[un-bien] Invalid URL: ${raw}. Must start with http:// or https://`,
      "error",
    )
    return
  }
  saveConfig({ relay: raw })
  ctx.ui.notify(
    `[un-bien] Relay set to ${raw}. Run /unbien relay stop then /unbien relay start to apply.`,
    "info",
  )
}

/**
 * `/unbien relay [start|stop|status|url <url>]` — issue #119.
 *
 * The README has always documented this family (`relay url` to point at a
 * self-hosted relay, `relay stop` + `relay start` to apply the change), but no
 * handler existed: every `relay …` invocation fell through the `else` in the
 * flat dispatcher and silently reprinted the status panel. Users following the
 * README believed they had switched relays and stayed on the community relay —
 * exactly the case where our own docs warn the operator sees routed plaintext.
 *
 * Verbs map onto the same primitives the RPC control channel already uses
 * (`deps.handleControl`), so the slash command and the Cockpit button can't drift:
 * relay-only up (`_cmdStart`) / relay-only down (`deps.goIdle`), never touching
 * local-mesh membership — that stays `/unbien stop`'s job.
 */
export async function _cmdRelay(
  deps: CommandDeps,
  arg: string,
  ctx: ExtensionContext,
): Promise<void> {
  const raw = arg.trim()
  const [verb, ...rest] = raw.split(/\s+/)
  const value = rest.join(" ").trim()

  switch (verb) {
    case "":
    case "toggle":
      await deps.handleControl("relay:toggle")
      ctx.ui.notify(`[un-bien] Relay ${deps.relayStatus()}.`, "info")
      deps.refreshFooter(ctx)
      return
    case "start":
    case "on":
      if (deps.getState() === "idle") await _cmdStart(deps, ctx)
      else
        ctx.ui.notify(`[un-bien] Relay already ${deps.relayStatus()}.`, "info")
      deps.emitRelayState(true)
      return
    case "stop":
    case "off":
      if (deps.getState() === "idle") {
        ctx.ui.notify("[un-bien] Relay already disconnected.", "info")
      } else {
        deps.goIdle()
        ctx.ui.notify(
          "[un-bien] Relay disconnected (local mesh untouched).",
          "info",
        )
      }
      deps.emitRelayState(true)
      deps.refreshFooter(ctx)
      return
    case "status":
      _cmdStatus(deps, ctx)
      deps.emitRelayState(true)
      return
    case "url":
      // Same writer as `set-relay` — one code path, so validation and the
      // "restart to apply" hint can never diverge between the two spellings.
      _cmdSetRelay(value, ctx)
      return
    default:
      ctx.ui.notify(
        "[un-bien] Usage: /unbien relay [start|stop|status|url <http(s) url>]",
        "warning",
      )
      return
  }
}
