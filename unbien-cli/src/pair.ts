#!/usr/bin/env node
/** `unbien pair <invite-uri>` — pair this CLI device with a machine's token.
 *
 * A thin standalone command: connect.ts's inline pairing (inside the full
 * session-attach flow) needs the relay connect + room plumbing; this is JUST
 * the pair-and-remember step, so re-pairing after a revoke (or pairing a
 * second machine) doesn't require a full connect round-trip.
 *
 * Usage:
 *   unbien pair <unbien://pair?t=…&epk=…&rm=…>
 *   unbien pair --name my-laptop <unbien://pair?t=…&epk=…&rm=…>
 */
import { SessionClient } from "./client.js"
import { loadOrCreateIdentity } from "./identity.js"
import { parseInvite } from "./invite.js"
import {
  rememberPeer,
  pickRelayEndpoint,
  recordRelayIdentity,
  relayPinFor,
  loadPeers,
  loadRelays,
} from "./store.js"

const args = process.argv.slice(2)
let name = "unbien-cli"
let relayFlag = ""
const positional: string[] = []

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg === "--name" || arg === "-n") {
    name = args[++i] ?? name
  } else if (arg === "--relay" || arg === "-r") {
    relayFlag = args[++i] ?? ""
  } else if (arg === "--help" || arg === "-h") {
    console.log(
      "usage: unbien pair [--name <device-name>] <unbien://pair?t=…&epk=…&rm=…>\n" +
        "\n" +
        "  --name, -n   device name shown in the machine's /unbien devices list\n" +
        "               (default: unbien-cli)\n",
    )
    process.exit(0)
  } else {
    positional.push(arg)
  }
}

const raw = positional[0]
if (!raw) {
  // No invite given — show remembered machines for context
  const peers = loadPeers()
  if (peers.length > 0) {
    console.error(
      "Already paired with:\n" +
        peers
          .map((p) => `  ${p.name} (${p.epk.slice(0, 8)}…) → ${p.relayUrl}`)
          .join("\n") +
        "\n\nTo pair a new machine (or re-pair after a revoke), run /unbien pair\n" +
        "on the machine and paste the resulting unbien:// URI here.",
    )
  } else {
    console.error(
      "No paired machines yet. Run /unbien pair on the machine you want to\n" +
        "connect to, then: unbien pair <unbien://pair?t=…&epk=…&rm=…>",
    )
  }
  process.exit(1)
}

const invite = parseInvite(raw)
// Relay URL: the URI itself doesn't carry it (rm= is the room, not the relay)
// — same resolution as connect.ts: --relay flag, else UNBIEN_RELAY env.
let relayUrlSeed = relayFlag || process.env["UNBIEN_RELAY"] || ""
let seedName: string | undefined
if (!relayUrlSeed) {
  // FALL BACK to the relay registry: if exactly one relay is remembered,
  // use it; if multiple, list them and ask for --relay.
  const relays = loadRelays()
  if (relays.length === 1) {
    relayUrlSeed = relays[0]!.url
    seedName = relays[0]!.name
    console.error(
      `[pair] using remembered relay: ${seedName} (${relayUrlSeed})`,
    )
  } else if (relays.length > 1) {
    console.error(
      "Multiple relays remembered — pick one:\n" +
        relays.map((r) => `  --relay ${r.url}  (${r.name})`).join("\n"),
    )
    process.exit(1)
  } else {
    console.error(
      "No relay URL. Pass --relay <url>, set UNBIEN_RELAY, or add one:\n" +
        "  unbien relay add <url>",
    )
    process.exit(1)
  }
}

const keypair = loadOrCreateIdentity()
// P6 C: pair over the relay's BEST endpoint (same relay identity = same
// pairing DB, so any verified endpoint works; local preferred on-host).
// P7: verify the relay's identity when this relay is already pinned; record
// it (TOFU) on first success — the pin is written at the moment the user
// has just scanned a fresh invite over this very URL, the deliberate trust act.
const relayUrl = await pickRelayEndpoint(relayUrlSeed)
const relayPin = relayPinFor(relayUrl)
const client = new SessionClient(relayUrl, keypair, invite, {
  expectRelayPubkey: relayPin,
})

try {
  await client.connect()
  // Fire-and-forget here is the field-verified pairing killer: the machine's
  // pair_ok/pair_error reply targets the sender's room and a caller that
  // closes immediately loses it — while the token is consumed regardless and
  // the CLI happily remembered an unpaired machine. Await the verdict.
  const verdict = await client.pairAwaited(name)
  if (!verdict.ok) {
    console.error(`[pair] machine did not accept the pairing: ${verdict.detail}`)
    // The peer was NOT recorded on the machine — don't remember it locally.
    client.close()
    process.exit(1)
  }
  rememberPeer({
    epk: invite.epk,
    relayUrl,
    name,
    pairedAt: new Date().toISOString(),
  })
  // TOFU: record the relay pubkey the FIRST time we pair over this URL (the
  // identity_ack already verified against `relayPin` when one existed — a
  // mismatch exits above via relay_identity_error).
  const ident = client.relayIdentity()
  // TOFU + endpoint bookkeeping: record the identity (with the ack's
  // advertised endpoints) the FIRST time we pair over this relay; with a
  // pin already present this is a pure endpoint merge.
  if (ident) {
    recordRelayIdentity({
      relayPubkey: ident.relayPubkey,
      relayName: ident.relayName || "relay",
      endpoint: relayUrl,
      endpoints: ident.endpoints,
    })
  }
  console.error(
    `[paired] ${name} → machine ${invite.epk.slice(0, 8)}… (relay ${relayUrl})\n` +
      "Attach with: `unbien connect` (default picker, or --session / --session-name).",
  )
  // Drain briefly: the machine may still be pushing its allow-list update.
  client.close()
} catch (err) {
  console.error(
    `[pair] failed: ${err instanceof Error ? err.message : String(err)}`,
  )
  process.exit(1)
}
