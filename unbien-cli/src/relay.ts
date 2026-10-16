#!/usr/bin/env node
/** `unbien relay <subcommand>` — manage remembered relays.
 *
 *   unbien relay add <url> [name]     remember a relay
 *   unbien relay remove <url|name>    forget a relay
 *   unbien relay list                 show remembered relays (default)
 *
 * The relay registry is advisory: peers carry their own relay URLs (set at
 * pair time), and the ambient UNBIEN_RELAY env still works. The registry is
 * what `unbien pair` offers when you haven't specified --relay, and what
 * `unbien connect` falls back to when a peer has no stored URL.
 */
import {
  loadRelays,
  rememberRelay,
  forgetRelay,
  loadRelayPeers,
  loadPendingRelayPairs,
  isPendingLive,
  addRelayPeer,
  addPendingRelayPair,
  removeRelayPeer,
  relayPubkeyB64,
  encodeRelayPairUrl,
  decodeRelayPairUrl,
  isFederationEnabled,
  setFederationEnabled,
} from "./store.js"
import { hostname as osHostname } from "node:os"
import { randomBytes } from "node:crypto"

const [verb, ...rest] = process.argv.slice(2)

function normalizeUrl(raw: string): string {
  let url = raw.trim()
  if (
    !url.startsWith("ws://") &&
    !url.startsWith("wss://") &&
    !url.startsWith("http://") &&
    !url.startsWith("https://")
  ) {
    url = `http://${url}`
  }
  // Accept http(s) for input; the client converts to ws(s) on connect.
  return url.replace(/\/+$/, "")
}

/** Mint a relay pairing URL (federation v2 one-pair): a random 32-byte
 *  single-use secret + our identity, held as a pending entry in
 *  relay-peers.json. The peer relay's `peer add` stores the pin + presents
 *  the secret in its relay_hello — THIS relay auto-adds the peer back, so
 *  one pairing action configures both directions. Used by 'unbien relay
 *  pair' (alias) + 'unbien relay peer pair'. */
function doPair(args: string[]): void {
  // URL priority: explicit arg > UNBIEN_RELAY_URL > UNBIEN_RELAY (convert
  // 0.0.0.0/localhost → hostname, http:// → ws://) > first remembered relay.
  const rawUrl =
    args.find((a) => !a.startsWith("--")) ??
    process.env.UNBIEN_RELAY_URL ??
    process.env.UNBIEN_RELAY ??
    loadRelays()[0]?.url ??
    ""
  // Fix up the URL for external reachability: replace 0.0.0.0/localhost
  // with the system hostname, + convert http(s):// → ws(s)://.
  const pairUrl = rawUrl
    .replace(/0\.0\.0\.0|localhost/g, osHostname())
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://")
  const nameArg = args[args.indexOf("--name") + 1]
  const pairName =
    nameArg ??
    process.env.UNBIEN_RELAY_NAME ??
    osHostname()
  if (!pairUrl) {
    console.error(
      "usage: unbien relay peer pair [url] [--name <name>]\n" +
        "  The URL defaults to UNBIEN_RELAY_URL env var, or the first remembered relay.\n" +
        "  The name defaults to the system hostname.\n" +
        "  Set UNBIEN_RELAY_URL in the relay plist, or pass it explicitly.",
    )
    process.exit(1)
  }
  const url = normalizeUrl(pairUrl)
  const pubkey = relayPubkeyB64()
  const secret = randomBytes(32).toString("base64")
  // Hold the secret as a pending (single-use) entry — the relay consumes it
  // when the peer presents it in relay_hello (auto-add back).
  addPendingRelayPair({
    secret,
    name: pairName,
    url,
    at: new Date().toISOString(),
    at_ms: Date.now(),
  })
  const pairUrlFull = encodeRelayPairUrl({ url, name: pairName, pubkey, secret })
  console.log(pairUrlFull)
  console.error(
    "Relay pairing URL (also on stdout — pipe to pbcopy/xclip):\n" +
      `  ${pairUrlFull}\n\n` +
      "Run on the peer relay:\n" +
      `  unbien relay peer add ${pairUrlFull}\n\n` +
      "The secret is SINGLE-USE: the peer presents it, this relay auto-adds the\n" +
      "peer back (mutually pinned) and consumes the pending entry.",
  )
}

/** One line of `peer list` output: pin status, never the secret. */
function peerLine(p: {
  name: string
  url: string
  pubkey?: string
  pair_secret?: string
}): string {
  const pin = p.pubkey
    ? `pinned ${p.pubkey.slice(0, 12)}…`
    : "NO PIN — will not dial or accept"
  const held = p.pair_secret ? "  [pairing secret held]" : ""
  return `  ${p.name} → ${p.url}  (${pin})${held}`
}

switch (verb) {
  case "add": {
    const url = rest[0]
    if (!url) {
      console.error("usage: unbien relay add <url> [name]")
      process.exit(1)
    }
    const name =
      rest[1] ??
      (() => {
        try {
          return new URL(normalizeUrl(url)).hostname
        } catch {
          return url
        }
      })()
    rememberRelay({
      url: normalizeUrl(url),
      name,
      addedAt: new Date().toISOString(),
    })
    console.error(`[relay] remembered ${name} → ${normalizeUrl(url)}`)
    break
  }

  case "remove": {
    const target = rest[0]
    if (!target) {
      console.error("usage: unbien relay remove <url|name>")
      process.exit(1)
    }
    if (forgetRelay(target)) {
      console.error(`[relay] removed ${target}`)
    } else {
      console.error(`[relay] no match for ${target}`)
      process.exit(1)
    }
    break
  }

  case "pair": {
    // Alias for 'unbien relay peer pair' — keep for convenience.
    doPair(rest)
    break
  }

  case "list": {
    // Show the local relay + remembered relays + federated peers.
    const ownName = process.env.UNBIEN_RELAY_NAME ?? osHostname()
    const ownUrl =
      process.env.UNBIEN_RELAY_URL ??
      `http://localhost:${process.env.UNBIEN_RELAY_PORT ?? 3000}`
    const ownPubkey = relayPubkeyB64()
    const relays = loadRelays()
    const peers = loadRelayPeers()
    console.error(
      "Local relay:\n" +
        `  ${ownName} → ${ownUrl}  (pubkey: ${ownPubkey.slice(0, 12)}...)\n` +
        `  pair: unbien relay pair\n`,
    )
    if (relays.length > 0) {
      console.error(
        "Remembered relays:\n" +
          relays.map((r) => `  ${r.name} → ${r.url}`).join("\n") + "\n",
      )
    }
    if (peers.length > 0) {
      console.error(
        "Federated peer relays:\n" +
          peers.map((p) => peerLine(p)).join("\n"),
      )
    } else {
      console.error(
        "No federated peer relays. Pair one:\n" +
          "  on the PEER relay:  unbien relay pair\n" +
          "  then here:          unbien relay peer add relay-pair://<base64>",
      )
    }
    break
  }

  case "peer": {
    const [subVerb, ...peerRest] = rest
    switch (subVerb) {
      case "add": {
        const arg = peerRest[0]
        // The pairing URL flow is the ONLY form (federation v2: pinned
        // pairing is mandatory — the pin comes from the URL).
        if (arg && arg.startsWith("relay-pair://")) {
          const parsed = decodeRelayPairUrl(arg)
          if (!parsed) {
            console.error("[relay] invalid pairing URL")
            process.exit(1)
          }
          addRelayPeer({
            url: normalizeUrl(parsed.url),
            name: parsed.name,
            pubkey: parsed.pubkey,
            pair_secret: parsed.secret,
          })
          if (!isFederationEnabled()) setFederationEnabled(true)
          console.error(
            "[relay] peer added: " + parsed.name + " -> " +
              normalizeUrl(parsed.url) + " (pubkey pinned" +
              (parsed.secret ? ", pairing secret held" : "") + ")\n" +
              "  The relay will connect within ~5s (no restart needed)." +
              (parsed.secret
                ? "\n  The peer relay will auto-add us back when we present the secret."
                : ""),
          )
        } else {
          // Legacy <url> <name> form: REFUSED — no pin, no pairing.
          console.error(
            "unbien relay peer add now requires a pairing URL — pinned pairing is mandatory.\n" +
              "  Generate one on the PEER relay:   unbien relay pair\n" +
              "  Then here:                        unbien relay peer add relay-pair://<base64>",
          )
          process.exit(1)
        }
        break
      }
      case "remove": {
        const name = peerRest[0]
        if (!name) {
          console.error("usage: unbien relay peer remove <name>")
          process.exit(1)
        }
        if (removeRelayPeer(name)) {
          console.error(
            "[relay] peer removed: " + name +
              "\n  The relay will disconnect within ~5s (no restart needed).",
          )
        } else {
          console.error("[relay] no peer named " + name)
          process.exit(1)
        }
        break
      }
      case "pair": {
        doPair(peerRest)
        break
      }
      case "on":
      case "off":
      case "status":
      case "federation": {
        // unbien relay peer federation <on|off|status> (also the bare
        // `peer federation` shows status)
        if (subVerb === "federation") {
          const action = peerRest[0] ?? "status"
          if (action === "on") setFederationEnabled(true)
          else if (action === "off") setFederationEnabled(false)
          console.error(
            "[relay] federation " + (isFederationEnabled() ? "ENABLED" : "disabled"),
          )
          break
        }
        doPair(peerRest)
        break
      }
      case "list": {
        const peers = loadRelayPeers()
        const pending = loadPendingRelayPairs()
        console.error(
          "[relay] federation " + (isFederationEnabled() ? "ENABLED" : "disabled (unbien relay peer federation on)") + "\n",
        )
        if (peers.length === 0) {
          console.error(
            "No federated peer relays. Pair one:\n" +
              "  on the PEER relay:  unbien relay pair\n" +
              "  then here:          unbien relay peer add relay-pair://<base64>\n" +
              "\n" +
              "Peer relays federate via explicit pairing (pinned pubkeys).\n" +
              "See docs/relay-peering.md (the federation operator doc).",
          )
        } else {
          console.error(
            "Federated peer relays:\n" +
              peers.map((p) => peerLine(p)).join("\n"),
          )
        }
        if (pending.length > 0) {
          console.error(
            `\nPending pairing invitations: ${pending.length} (single-use, 24h; secrets not shown)\n` +
              pending
                .map((p) => {
                  const live = isPendingLive(p)
                  return `  ${p.name} → ${p.url}  (issued ${p.at})` +
                    (live ? "" : "  [EXPIRED — re-mint with `unbien relay pair`]")
                })
                .join("\n"),
          )
        }
        break
      }
      default:
        console.error(
          "usage:\n" +
            "  unbien relay peer pair [url] [--name <name>]\n" +
            "  unbien relay peer add relay-pair://<base64>\n" +
            "  unbien relay peer remove <name>\n" +
            "  unbien relay peer list",
        )
        process.exit(1)
    }
    break
  }

  default: {
    // Same as 'list' — show the local relay + remembered + peers.
    const ownName = process.env.UNBIEN_RELAY_NAME ?? osHostname()
    const ownUrl =
      process.env.UNBIEN_RELAY_URL ??
      `http://localhost:${process.env.UNBIEN_RELAY_PORT ?? 3000}`
    const ownPubkey = relayPubkeyB64()
    const relays = loadRelays()
    const peers = loadRelayPeers()
    console.error(
      "Local relay:\n" +
        `  ${ownName} → ${ownUrl}  (pubkey: ${ownPubkey.slice(0, 12)}...)\n` +
        `  pair: unbien relay pair\n` +
        `  peers: unbien relay peer list\n`,
    )
    if (relays.length > 0) {
      console.error(
        "Remembered relays:\n" +
          relays.map((r) => `  ${r.name} → ${r.url}`).join("\n") + "\n",
      )
    }
    if (peers.length > 0) {
      console.error(
        "Federated peer relays:\n" +
          peers.map((p) => peerLine(p)).join("\n"),
      )
    }
    break
  }
}
