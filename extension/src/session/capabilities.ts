import {
  effectiveAllowRemoteLaunch,
  effectiveAllowRemoteTerminate,
  loadLocalConfig,
} from "./local_config.js"

// The app gates its controls on these. Passive server->app extras
// (images/panels) are listed so the app can also gate any future *controls* it
// grows for them.
export const BASE_CAPABILITIES = [
  "thinking",
  "models",
  "cancel",
  "queued_messages",
  "images",
  "tool_result_images",
  "panels",
  "rpc_envelope",
] as const

/**
 * The capability set to advertise right now (config-dependent bits included).
 * Advertised in TWO places so the app learns them at the right time:
 *  - the `ub hello` on peer ATTACH (relay_lifecycle) — authoritative, but only
 *    after the app opens/attaches to the room;
 *  - `room_meta.caps` on the room announce (commands/lifecycle) — so the app
 *    learns them on DISCOVERY/reconnect, before attaching (e.g. the Home tile's
 *    End Chat gating, which is evaluated pre-attach). Design 01M1SJDZ.
 */
export function sessionCapabilities(): string[] {
  const caps: string[] = [...BASE_CAPABILITIES]
  // Read the session cwd's config (pi runs in the session cwd); single choke
  // point so the advertised set and honored behavior can't drift.
  const cfg = loadLocalConfig(process.cwd())
  if (effectiveAllowRemoteLaunch(cfg)) caps.push("remote_launch")
  if (effectiveAllowRemoteTerminate(cfg)) caps.push("remote_terminate")
  return caps
}
