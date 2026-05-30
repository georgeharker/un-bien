import { SessionPeer, type AckResult, type SessionPeerOptions } from "./peer.js";
import type { Envelope } from "./envelope.js";
import type { Broker } from "./broker.js";
import type { BrokerRemote } from "./broker_remote.js";
import type { PiForwardClient } from "../transport/pi_forward_client.js";
import { RelayClient } from "../transport/relay_client.js";
import { attachCrossPcBridge } from "./bridge.js";
import { getOrCreateEd25519Keypair } from "../pairing/storage.js";
import type { Ed25519Keypair } from "./../pairing/crypto.js";
import { roomIdForCwd } from "../rooms.js";
import { toWebSocketUrl } from "../config.js";

/**
 * MeshNode — the single composition point for "join the agent mesh".
 *
 * Wraps the two layers every mesh participant needs, and nothing else
 * (pairing is app↔Pi and stays OUT of here):
 *
 *   1. **Local UDS mesh** — always. A `SessionPeer` joins (or leads) the
 *      broker at `sockPath`: `send` / `sendWithAck` / `request` /
 *      `onMessage`, leader election + failover for free.
 *
 *   2. **Cross-PC relay bridge** — optional, only when the node leads (the
 *      leader hosts the Broker, so it owns the `BrokerRemote`). Two ways to
 *      supply the relay:
 *        - **Self-managed** (MCP): pass `bridge: { relayUrl, cwd }` and the
 *          node creates + owns the RelayClient on connect-if-leader, with
 *          its own machine Pi-key.
 *        - **Injected** (Pi extension): call `attachBridge({ relay, … })`
 *          with the RelayClient the host already owns (and also uses for
 *          app↔Pi pairing). MeshNode never closes an injected relay.
 *
 * Both the Pi extension and the MCP mesh server build on this so the mesh
 * wiring lives in one place. A follower never brings the bridge up —
 * cross-PC routing works transitively through whoever is leader (a Pi, the
 * daemon, or another MeshNode). On UDS failover that promotes this node to
 * leader, the bridge re-attaches automatically against the fresh broker.
 */

/** Self-managed-relay bridge config (MCP path). */
export interface MeshSelfRelayBridge {
  /** Relay URL in http(s):// form (converted to ws(s):// internally). */
  relayUrl: string;
  /** cwd — derives the relay room id and the room_meta. */
  cwd: string;
  /** Display name for room_meta. Defaults to the assigned mesh name. */
  sessionName?: string;
}

export interface MeshNodeOptions {
  /** UDS broker socket path (e.g. ~/.pi/remote/sessions/local/broker.sock). */
  sockPath: string;
  /** Requested mesh name (broker may add a #N collision suffix). */
  name: string;
  /** Optional audit log path passed through to SessionPeer. */
  auditPath?: string;
  /** Self-managed relay bridge — brought up if this node leads. */
  bridge?: MeshSelfRelayBridge;
  /** Diagnostic logger. Defaults to a no-op (avoids leaking into TUIs). */
  log?: (msg: string) => void;
}

export type { AckResult } from "./peer.js";

/** Internal: resolved bridge parameters (self-managed OR injected). */
interface BridgeParams {
  relayUrl: string;
  keypair?: Ed25519Keypair;
  /** Self-managed: create our own relay from these. */
  cwd?: string;
  sessionName?: string;
  /** Injected: use this relay (host owns its lifecycle). */
  injectedRelay?: RelayClient;
}

interface SiblingInfo {
  pcLabel: string;
  pcPubkey: string;
}

export class MeshNode {
  private readonly peer_: SessionPeer;
  private readonly log: (msg: string) => void;

  private relay: RelayClient | null = null;
  private relayOwned = false;
  private brokerRemote: BrokerRemote | null = null;
  private piForward: PiForwardClient | null = null;
  private keypair: Ed25519Keypair | null = null;
  private bridgeParams: BridgeParams | null = null;
  private reconnectWired = false;

  constructor(opts: MeshNodeOptions) {
    this.log = opts.log ?? ((): void => {});
    const peerOpts: SessionPeerOptions = { sockPath: opts.sockPath, name: opts.name };
    if (opts.auditPath !== undefined) peerOpts.auditPath = opts.auditPath;
    this.peer_ = new SessionPeer(peerOpts);
    if (opts.bridge) {
      const p: BridgeParams = { relayUrl: opts.bridge.relayUrl, cwd: opts.bridge.cwd };
      if (opts.bridge.sessionName !== undefined) p.sessionName = opts.bridge.sessionName;
      this.bridgeParams = p;
    }
  }

  /** Join (or lead) the mesh. Resolves with the assigned name. */
  async connect(): Promise<string> {
    const name = await this.peer_.start();
    this._wireReconnect();
    if (this.bridgeParams) await this._maybeBridge();
    return name;
  }

  /**
   * Attach a cross-PC bridge on top of an EXTERNALLY-owned relay (Pi path).
   * Idempotent; only attaches when this node is the leader. Remembers the
   * params so the bridge re-attaches after a UDS failover. Call again with a
   * fresh relay after a relay reconnect.
   */
  async attachBridge(opts: { relay: RelayClient; relayUrl: string; keypair?: Ed25519Keypair }): Promise<void> {
    const p: BridgeParams = { relayUrl: opts.relayUrl, injectedRelay: opts.relay };
    if (opts.keypair !== undefined) p.keypair = opts.keypair;
    this.bridgeParams = p;
    this._wireReconnect();
    await this._maybeBridge();
  }

  /**
   * Tear down the bridge AND forget its params (no auto re-attach until the
   * next `attachBridge`/`connect`). Closes the relay only if MeshNode created
   * it — an injected relay belongs to the host. Use on stop / relay drop.
   */
  detachBridge(): void {
    this._detachBridgeKeepingParams();
    this.bridgeParams = null;
  }

  // ── Bridge internals ────────────────────────────────────────────────────────

  private _wireReconnect(): void {
    if (this.reconnectWired) return;
    this.reconnectWired = true;
    // SessionPeer.onReconnect fires only after a UDS re-election (failover),
    // not on relay events. On failover the broker reference changes, so drop
    // the stale bridge and re-attach against the fresh localBroker().
    this.peer_.onReconnect(() => { void this._onReconnect(); });
  }

  private async _onReconnect(): Promise<void> {
    if (!this.bridgeParams) return;
    this._detachBridgeKeepingParams();
    await this._maybeBridge();
  }

  private async _maybeBridge(): Promise<void> {
    if (this.brokerRemote) return;
    if (this.peer_.currentRole() !== "leader") return;
    const broker: Broker | null = this.peer_.localBroker();
    if (!broker) return;
    const params = this.bridgeParams;
    if (!params) return;

    let relay: RelayClient;
    if (params.injectedRelay) {
      relay = params.injectedRelay;
      this.relayOwned = false;
    } else {
      if (!this.keypair) this.keypair = params.keypair ?? (await getOrCreateEd25519Keypair());
      const roomId = roomIdForCwd(params.cwd!);
      const roomMeta = { name: params.sessionName ?? this.peer_.name(), cwd: params.cwd! };
      const r = new RelayClient(toWebSocketUrl(params.relayUrl), this.keypair);
      try {
        await r.connect({ roomId, roomMeta });
      } catch (err) {
        // UDS mesh still works; cross-PC stays unavailable until a leader
        // with a healthy relay appears.
        this.log(`mesh bridge: relay connect failed: ${String(err)}`);
        return;
      }
      relay = r;
      this.relayOwned = true;
    }
    this.relay = relay;

    if (!this.keypair) this.keypair = params.keypair ?? (await getOrCreateEd25519Keypair());

    const { brokerRemote, piForward } = await attachCrossPcBridge({
      broker,
      relay,
      relayUrl: params.relayUrl,
      keypair: this.keypair,
      log: this.log,
    });
    this.brokerRemote = brokerRemote;
    this.piForward = piForward;
  }

  private _detachBridgeKeepingParams(): void {
    this.brokerRemote?.detach();
    this.brokerRemote = null;
    this.piForward?.detach();
    this.piForward = null;
    if (this.relayOwned) this.relay?.close();
    this.relay = null;
    this.relayOwned = false;
  }

  // ── Bridge passthroughs (no-op when no bridge / follower) ───────────────────

  /** Keep the cross-PC sibling set in sync (Pi SelfRevoke onMembersChanged). */
  setSiblings(siblings: SiblingInfo[]): void {
    this.brokerRemote?.setSiblings(siblings);
  }

  /** Announce the local peer set to siblings (Pi broker peer_joined/left). */
  onLocalPeersChanged(local: string[]): void {
    this.brokerRemote?.onLocalPeersChanged(local);
  }

  /** True when the cross-PC relay bridge is active (this node is leader). */
  hasBridge(): boolean {
    return this.brokerRemote !== null;
  }

  // ── Mesh API (delegates to SessionPeer) ─────────────────────────────────────

  /** The underlying SessionPeer — for consumers that need it directly (tools). */
  peer(): SessionPeer {
    return this.peer_;
  }

  /** Fire-and-forget send. `to` may be a name, `<pc>:<name>`, or "broadcast". */
  async send(to: string | string[], body: unknown, re: string | null = null): Promise<void> {
    return this.peer_.send(to, body, re);
  }

  /** Unicast send + await broker ACK (received/busy/denied/timeout). */
  async sendWithAck(to: string, body: unknown, re: string | null = null, timeoutMs?: number): Promise<AckResult> {
    return timeoutMs === undefined
      ? this.peer_.sendWithAck(to, body, re)
      : this.peer_.sendWithAck(to, body, re, timeoutMs);
  }

  /** Send + await the first reply whose `re` matches the outbound id. */
  async request(to: string, body: unknown, timeoutMs?: number): Promise<Envelope> {
    return timeoutMs === undefined
      ? this.peer_.request(to, body)
      : this.peer_.request(to, body, timeoutMs);
  }

  /** Subscribe to inbound envelopes. Returns an unsubscribe fn. */
  onMessage(handler: (env: Envelope) => void): () => void {
    return this.peer_.onMessage(handler);
  }

  /** Subscribe to post-failover reconnects. Returns an unsubscribe fn. */
  onReconnect(handler: () => void): () => void {
    return this.peer_.onReconnect(handler);
  }

  /** Assigned mesh name (after any #N collision suffix). */
  name(): string {
    return this.peer_.name();
  }

  /** "leader" | "follower". */
  currentRole(): "leader" | "follower" {
    return this.peer_.currentRole();
  }

  /** The locally-hosted Broker when leader, else null. */
  localBroker(): Broker | null {
    return this.peer_.localBroker();
  }

  /**
   * Aggregated mesh roster (local UDS peers + cross-PC `<pc>:<peer>`),
   * excluding self. Asks the broker, which merges its remote router cache.
   */
  async listPeers(timeoutMs = 2_000): Promise<string[]> {
    const reply = await this.peer_.request("broker", { type: "list_peers" }, timeoutMs);
    const body = reply.body as { peers?: string[] } | null;
    return (body?.peers ?? []).filter((p) => p !== this.peer_.name());
  }

  /** Tear down the bridge (if any) and leave the mesh. */
  async close(): Promise<void> {
    this.detachBridge();
    await this.peer_.leave();
  }
}
