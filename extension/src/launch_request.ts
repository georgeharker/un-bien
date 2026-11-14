import { loadConfig } from "./config.js"
import {
  _expandTilde,
  launchDirAllowed,
  launchSession,
  type LaunchErrorCode,
  type LaunchResult,
} from "./launch.js"
import { effectiveAllowRemoteLaunch, loadLocalConfig } from "./session/local_config.js"
import type { EnvelopeMessage } from "./session/rpc_envelope.js"

/**
 * One `session_launch` request, answered for the app. Shared by the launcher
 * daemon (idle machine) and a live pi (its own room), so both apply the same
 * gates and reply the same way.
 *
 * Every request gets `{ub:{type:"session_launch_result", in_reply_to, ok,
 * backend?, fell_back?, code?, message?, output?}}`: once when the launch
 * starts or is refused, and again with `code:"exited_early"` when pi dies
 * right after starting. Apps that predate the frame ignore it (unknown ub
 * types are dropped); the `error` frames sent before it (unknown_peer,
 * permission_denied) are still sent for them.
 */

export interface LaunchReplyChannel {
  /** A stock frame (the legacy `error` replies). */
  send(frame: Record<string, unknown>): void
  sendEnvelope(env: EnvelopeMessage): void
}

export interface LaunchRequestOptions {
  log: (line: string) => void
  /** The launcher re-checks pairing per request (it has no revoke path); a
   *  live pi is reached over an already-paired room and passes none. */
  isPaired?: () => Promise<boolean>
}

/** The `session_launch_result` frame for a request. Exported for tests. */
export function launchResultEnvelope(requestId: string, result: LaunchResult): EnvelopeMessage {
  return {
    ub: {
      type: "session_launch_result",
      in_reply_to: requestId,
      ok: result.ok,
      ...(result.backend ? { backend: result.backend } : {}),
      ...(result.fell_back ? { fell_back: result.fell_back } : {}),
      ...(result.code ? { code: result.code } : {}),
      ...(result.message ? { message: result.message } : {}),
      ...(result.output ? { output: result.output } : {}),
    },
  }
}

function stringField(frame: Record<string, unknown>, key: string): string | undefined {
  const v = frame[key]
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

export async function handleSessionLaunch(
  frame: Record<string, unknown>,
  sender: LaunchReplyChannel,
  opts: LaunchRequestOptions,
): Promise<LaunchResult> {
  const requestId = stringField(frame, "id") ?? ""
  const reply = (result: LaunchResult) => {
    if (!result.ok) opts.log(`session_launch ${result.code ?? "failed"}: ${result.message ?? ""}`)
    try {
      sender.sendEnvelope(launchResultEnvelope(requestId, result))
    } catch (err) {
      opts.log(`session_launch_result send failed: ${String(err)}`)
    }
    return result
  }
  const refuse = (code: LaunchErrorCode, message: string, legacy: boolean) => {
    // The `error` frame apps before session_launch_result understood.
    if (legacy) sender.send({ type: "error", code, message })
    return reply({ ok: false, code, message })
  }

  const cwd = _expandTilde(stringField(frame, "cwd") ?? process.cwd())
  if (!effectiveAllowRemoteLaunch(loadLocalConfig(cwd))) {
    return refuse("remote_launch_disabled", "Remote launch is turned off on this machine", false)
  }
  // Pairing is re-checked FRESH per launch: a revoked owner stops launching
  // without a daemon restart.
  if (opts.isPaired && !(await opts.isPaired())) {
    return refuse("unknown_peer", "Peer not paired — re-scan QR", true)
  }
  // Directory allow-list, read FRESH each request.
  if (!launchDirAllowed(cwd, loadConfig().launch?.dirs)) {
    return refuse("permission_denied", "Remote launch not permitted for this directory", true)
  }
  const result = await launchSession(
    {
      cwd,
      name: stringField(frame, "name"),
      resume: stringField(frame, "resume"),
      // Launch correlation: pi is spawned with UNBIEN_LAUNCH_REQ=<id> and
      // echoes it in room_meta, so the app can match the announcing room to
      // this request and open the chat.
      launchReq: requestId || undefined,
    },
    reply,
  )
  return reply(result)
}
