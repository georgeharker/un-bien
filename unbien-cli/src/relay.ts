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
} from "./store.js"

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

  case "list":
  case "peer": {
    const [subVerb, ...peerRest] = rest
    switch (subVerb) {
      case "add": {
        const url = peerRest[0]
        const name = peerRest[1]
        if (!url || !name) {
          console.error("usage: unbien relay peer add <url> <name>")
          process.exit(1)
        }
        addRelayPeer({ url: normalizeUrl(url), name })
        console.error(
          "[relay] peer added: " + name + " -> " + normalizeUrl(url) +
            "\n  Restart the relay to connect.",
        )
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
              "\n  Restart the relay to disconnect.",
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
    const relays = loadRelays()
    if (relays.length === 0) {
      console.error(
        "No remembered relays. Add one:\n" +
          "  unbien relay add <url> [name]\n" +
          "\n" +
          "Peers already carry their own relay URLs (set at pair time); the\n" +
          "registry is the fallback for `unbien pair` without --relay.",
      )
    } else {
      console.error(
        "Relays:\n" + relays.map((r) => `  ${r.name} → ${r.url}`).join("\n"),
      )
    }
    break
  }
}
