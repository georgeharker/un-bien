import type { Broker } from "./broker.js";
import { BrokerRemote } from "./broker_remote.js";
import { PiForwardClient } from "../transport/pi_forward_client.js";
import type { RelayClient } from "../transport/relay_client.js";
import { MeshClient } from "../mesh/client.js";
import { discoverSelfLabel, discoverSiblings, fallbackLabel } from "../mesh/siblings.js";
import { listOwnerPubkeys } from "../pairing/storage.js";
import type { Ed25519Keypair } from "../pairing/crypto.js";

/**
 * Cross-PC mesh bridge composition — the single shared point for "turn a
 * leader Broker + relay into a cross-PC router".
 *
 * Both consumers call this so the wiring lives in one place:
 *   - The Pi extension (`_ensureBrokerRemote`) injects its relay — the SAME
 *     RelayClient it also uses for app↔Pi pairing.
 *   - The MCP `MeshNode` creates its own RelayClient and passes it in.
 *
 * The function does NOT own the relay's lifecycle (the caller created it and
 * tears it down). It only attaches the PiForwardClient + BrokerRemote on top.
 *
 * Sibling discovery is best-effort: on any failure we attach a BrokerRemote
 * with an empty sibling set, and remote `peers_update` pushes fill the cache
 * in later. Discovery warnings are routed to the silent `log` so they never
 * bleed into a Pi TUI chat panel.
 */

export interface AttachBridgeOptions {
  /** The leader's local Broker (from SessionPeer.localBroker()). */
  broker: Broker;
  /** Live relay connection. Caller owns its lifecycle. */
  relay: RelayClient;
  /** Relay URL in http(s):// form — for MeshClient sibling discovery. */
  relayUrl: string;
  /** This host's Ed25519 identity (machine Pi-key). */
  keypair: Ed25519Keypair;
  /** Diagnostic logger. Defaults to a no-op (avoids TUI leaks). */
  log?: (msg: string) => void;
}

export interface CrossPcBridge {
  brokerRemote: BrokerRemote;
  piForward: PiForwardClient;
}

export async function attachCrossPcBridge(opts: AttachBridgeOptions): Promise<CrossPcBridge> {
  const log = opts.log ?? ((): void => {});
  const piForward = new PiForwardClient(opts.relay);

  const selfPubkeyB64 = Buffer.from(opts.keypair.publicKey).toString("base64");
  let selfPcLabel = fallbackLabel(selfPubkeyB64);
  let siblings: { pcLabel: string; pcPubkey: string }[] = [];
  try {
    const meshClient = new MeshClient(opts.relayUrl);
    const owners = await listOwnerPubkeys();
    if (owners.length > 0) {
      // Silent log: per-Owner fetch failures (relay 404 before any Owner
      // published, transient HTTP errors) must not surface in a TUI.
      const silent = { warn: (_m: string): void => { /* silent */ } };
      const [labelRes, sibs] = await Promise.all([
        discoverSelfLabel({ client: meshClient, ownerEpks: owners, myPubkey: opts.keypair.publicKey, log: silent }),
        discoverSiblings({ client: meshClient, ownerEpks: owners, myPubkey: opts.keypair.publicKey, log: silent }),
      ]);
      selfPcLabel = labelRes.selfPcLabel;
      siblings = sibs;
    }
  } catch (err) {
    // Best-effort — siblings populate later via remote peers_update push.
    void err;
  }

  const brokerRemote = new BrokerRemote({
    broker: opts.broker,
    pi: piForward,
    selfPcLabel,
    selfPcPubkey: selfPubkeyB64,
    siblings,
    log,
  });

  return { brokerRemote, piForward };
}
