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
  addRelayPeer,
  removeRelayPeer,
  relayPubkeyB64,
} from "./store.js"
import { hostname as osHostname } from "node:os"

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
    // Generate a pairing URL for this relay.
    // Usage: unbien relay pair [url] [--name <name>]
    // Defaults: url = UNBIEN_RELAY_URL env, name = system hostname.
    const pairUrl =
      rest.find((a) => !a.startsWith("--")) ??
      process.env.UNBIEN_RELAY_URL ??
      ""
    const nameArg = rest[rest.indexOf("--name") + 1]
    // Default the name to the system hostname (same as the relay does via
    // gethostname). Only override if --name or UNBIEN_RELAY_NAME is set.
    const pairName =
      nameArg ??
      process.env.UNBIEN_RELAY_NAME ??
      osHostname()
    if (!pairUrl) {
      console.error(
        "usage: unbien relay pair [url] [--name <name>]\n" +
          "  The URL defaults to UNBIEN_RELAY_URL env var.\n" +
          "  The name defaults to the system hostname.\n" +
          "  Set UNBIEN_RELAY_URL in the relay plist, or pass it explicitly.",
      )
      process.exit(1)
    }
    const pubkey = relayPubkeyB64()
    const blob = Buffer.from(
      JSON.stringify({ url: normalizeUrl(pairUrl), name: pairName, pubkey }),
    ).toString("base64")
    const pairUrlFull = `relay-pair://${blob}`
    // URL to stdout (pipeable: `unbien relay pair | pbcopy`), instructions to stderr.
    console.log(pairUrlFull)
    console.error(
      "Relay pairing URL (also on stdout — pipe to pbcopy/xclip):\n" +
        `  ${pairUrlFull}\n\n` +
        "Run on the peer relay:\n" +
        `  unbien relay peer add ${pairUrlFull}`,
    )
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
          peers
            .map(
              (p) =>
                `  ${p.name} → ${p.url}` +
                (p.pubkey ? `  (pubkey: ${p.pubkey.slice(0, 12)}...)` : ""),
            )
            .join("\n"),
      )
    } else {
      console.error(
        "No federated peer relays. Add one:\n" +
          "  unbien relay peer add <url> <name>\n" +
          "  unbien relay peer add relay-pair://<base64>",
      )
    }
    break
  }

  case "peer": {
    const [subVerb, ...peerRest] = rest
    switch (subVerb) {
      case "add": {
        const arg = peerRest[0]
        // Accept a pairing URL (relay-pair://base64...) or the legacy
        // <url> <name> form.
        if (arg && arg.startsWith("relay-pair://")) {
          try {
            const blob = arg.slice("relay-pair://".length)
            const parsed = JSON.parse(
              Buffer.from(blob, "base64").toString("utf8"),
            ) as { url: string; name: string; pubkey: string }
            addRelayPeer({
              url: normalizeUrl(parsed.url),
              name: parsed.name,
              pubkey: parsed.pubkey,
            })
            console.error(
              "[relay] peer added: " + parsed.name + " -> " +
                normalizeUrl(parsed.url) + " (pubkey pinned)\n" +
                "  The relay will connect within ~5s (no restart needed).",
            )
          } catch {
            console.error("[relay] invalid pairing URL")
            process.exit(1)
          }
        } else {
          const url = peerRest[0]
          const name = peerRest[1]
          if (!url || !name) {
            console.error(
              "usage: unbien relay peer add <url> <name>\n" +
                "       unbien relay peer add relay-pair://<base64>",
            )
            process.exit(1)
          }
          addRelayPeer({ url: normalizeUrl(url), name })
          console.error(
            "[relay] peer added: " + name + " -> " + normalizeUrl(url) +
              "\n  The relay will connect within ~5s (no restart needed).",
          )
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
      case "list": {
        const peers = loadRelayPeers()
        if (peers.length === 0) {
          console.error(
            "No federated peer relays. Add one:\n" +
              "  unbien relay peer add <url> <name>\n" +
              "\n" +
              "Peer relays federate via shared-owner verification.\n" +
              "See docs/relay-peering-sketch.md.",
          )
        } else {
          console.error(
            "Federated peer relays:\n" +
              peers.map((p) => "  " + p.name + " -> " + p.url).join("\n"),
          )
        }
        break
      }
      default:
        console.error(
          "usage:\n" +
            "  unbien relay peer add <url> <name>\n" +
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
          peers
            .map(
              (p) =>
                `  ${p.name} → ${p.url}` +
                (p.pubkey ? `  (pubkey: ${p.pubkey.slice(0, 12)}...)` : ""),
            )
            .join("\n"),
      )
    }
    break
  }
}
