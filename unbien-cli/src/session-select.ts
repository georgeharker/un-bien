/**
 * Explicit-flag session selection (`--session` / `--session-name`) for the
 * connect flow, with bounded re-gather patience.
 *
 * Extracted from connect.ts (a top-level script that cannot be imported by
 * tests without executing the whole attach flow) so the selection semantics —
 * id prefix match, name ambiguity refusal, the multi-relay name filter, and
 * the bounded poll for mid-propagation rooms — are unit-testable.
 *
 * The poll exists for the `unbien create-session` handoff: it launches a pi on
 * a federated machine and spawns a FRESH `unbien connect <epk> --session <id>`
 * process, but the new room can still be seconds from visibility — the origin
 * relay's relay_peer_update plus this relay's federated_peer_list rebroadcast
 * are both async. The connect process gathers sessions ONCE at startup, so
 * the handoff loses the race without a re-check.
 */
import type { RoomInfo } from "./client.js"

/** A session choice enriched with relay provenance (which relay+peer it
 *  came from) so the unified picker can disambiguate machines on different
 *  relays that happen to share a session name. The chosen room's `relayUrl`
 *  drives the client promotion after selection, so the gather that builds
 *  these must preserve this exact shape. */
export interface SessionChoice extends RoomInfo {
  relayUrl: string
  relayLabel: string
}

/** `--session` selects by IDENTITY: the pi sessionId (prefix ok) or room id. */
export function matchesSessionId(room: RoomInfo, id: string): boolean {
  return room.sessionId?.startsWith(id) === true || room.room_id === id
}

/** Re-gather budget: how many times a miss re-lists before giving up. Each
 *  re-gather waits up to ~3s (the federated push-listen window), so a full
 *  miss costs ≈9s of patience; a genuinely wrong id still fails promptly. */
export const SESSION_WAIT_RETRIES = 3

export interface SessionLookupResult {
  /** The matching room from the latest snapshot, or null after the budget. */
  chosen: SessionChoice | null
  /** Non-null when `--session-name` matched more than one room: the caller
   *  must refuse (list the matches, exit) — ambiguity never resolves to a
   *  pick, no matter how long we wait. */
  ambiguous: SessionChoice[] | null
}

/**
 * Resolve an explicit `--session <id>` or `--session-name <name>` against a
 * session snapshot. On a miss, re-gather (the caller's `regather` re-pulls
 * rooms and re-listens for the federated push) up to SESSION_WAIT_RETRIES
 * times, logging one line per retry, then give up and return null — the
 * caller prints its own not-found message and exits.
 *
 * Name matching keeps the interactive-path semantics exactly: names are
 * user-set and NOT unique, so more than one match refuses, and under
 * multi-relay only rooms on the target relay count (a same-named room on
 * another relay is a different machine's business).
 */
export async function findFlaggedSession(opts: {
  choices: readonly SessionChoice[]
  multiRelay: boolean
  /** The target relay — names only match on it when multiRelay. */
  relayUrl: string
  wantedId?: string
  wantedName?: string
  /** Re-gather the session snapshot (fresh rooms pull + federated listen). */
  regather: () => Promise<SessionChoice[]>
  /** Diagnostics sink; defaults to stderr like the rest of the CLI. */
  log?: (line: string) => void
}): Promise<SessionLookupResult> {
  const { multiRelay, relayUrl, regather } = opts
  const wantedId = opts.wantedId
  const wantedName = opts.wantedName
  const log = opts.log ?? console.error
  let choices = opts.choices
  for (let attempt = 0; ; attempt++) {
    if (wantedId) {
      const found = choices.find((r) => matchesSessionId(r, wantedId))
      if (found) return { chosen: found, ambiguous: null }
    } else if (wantedName) {
      const named = choices.filter(
        (r) => r.name === wantedName && (!multiRelay || r.relayUrl === relayUrl),
      )
      if (named.length > 1) return { chosen: null, ambiguous: named }
      const only = named[0] ?? null
      if (only) return { chosen: only, ambiguous: null }
    } else {
      // No explicit flag — never polled; the caller routes to the picker.
      return { chosen: null, ambiguous: null }
    }
    if (attempt >= SESSION_WAIT_RETRIES) return { chosen: null, ambiguous: null }
    const what = wantedId ? `id "${wantedId}"` : `name "${wantedName}"`
    log(
      `[sessions] ${what} not visible yet — waiting for it to arrive ` +
        `(${attempt + 1}/${SESSION_WAIT_RETRIES})…`,
    )
    choices = await regather()
  }
}