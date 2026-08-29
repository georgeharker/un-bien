import type { ClientMessage, ServerMessage } from "../protocol/types.js";
import {
  ENVELOPE_KIND,
  UN_KIND,
  type EnvelopeMessage,
} from "../session/rpc_envelope.js";
import { envLog } from "../session/debug_log.js";
import type { RelayClient } from "./relay_client.js";

/** Sink for ServerMessage outbound to the remote app. */
export interface PeerChannel {
  send(msg: ServerMessage): void;
}

/**
 * Outer envelope shape forwarded by the relay.
 * { "peer": "<sender_peer_id>", "room"?: "<room_id>", "ct": "<base64 JSON inner>" }
 *
 * Post rollback (plano 06): `ct` is base64(JSON.stringify(inner)) — no cipher,
 * no MAC. Relay continues opaque (never JSON.parses ct).
 *
 * `room` (plano 17): identifies which Pi room sent the envelope. Lets the
 * relay multiplex N peers with the same Ed25519 pubkey but distinct cwds.
 * Optional for backward-compat with single-room relays.
 */
interface OuterEnvelope {
  peer: string;
  room?: string;
  ct: string;
}

/**
 * Plaintext PeerChannel backed by a RelayClient WebSocket.
 *
 * Usage (after pair_request handshake completes):
 *   const channel = new PlainPeerChannel(relay, appPeerId, myRoomId, onMsg)
 *   channel.send(serverMessage)          // base64-encodes JSON, routes via relay
 *   // incoming relay messages destined for appPeerId are auto-decoded
 *   // and delivered via onMessage callback
 *
 * `myRoomId` is the *local* Pi's room id — sent on every outbound envelope
 * so the app can correlate which Pi sent it (multi-pi support, plano 17).
 */
export class PlainPeerChannel implements PeerChannel {
  private readonly _unsubscribe: () => void;

  constructor(
    private readonly relay: RelayClient,
    private readonly remotePeerId: string,
    /**
     * This Pi's room id. Currently NOT injected in the outer envelope
     * (defensive — relay/app not yet ready). Kept in the constructor for
     * forward-compat so callers don't need to change again when we re-enable.
     */
    myRoomId: string | undefined,
    private readonly onMessage: (msg: ClientMessage) => void,
    /** Called when this specific peer connection is considered lost. */
    _onDisconnect?: () => void,
    /** Route an inbound mesh-envelope ({rpc|evt}, docs/rpc-envelope.md) to the
     *  new-protocol dispatcher. Absent → the channel ignores envelope frames. */
    private readonly onRpc?: (
      env: EnvelopeMessage,
      sender: PlainPeerChannel,
    ) => void,
  ) {
    const listener = (line: string) => this._onLine(line);
    relay.on("message", listener);
    this._unsubscribe = () => relay.off("message", listener);
    void _onDisconnect;
    void myRoomId; // intentionally unused — see send() comment
  }

  // ── PeerChannel interface ──────────────────────────────────────────────────

  send(msg: ServerMessage): void {
    const ct = Buffer.from(JSON.stringify(msg)).toString("base64");
    // NOTE: `room` removed from the outer envelope until relay (W1.A) + app
    // (W1.C) accept the field. Multi-Pi multiplexing already works via
    // `room_id`/`room_meta` in the WS-level `hello` — outer routing stays by
    // `peer` alone. Re-add the field once downstream is ready.
    const outer: OuterEnvelope = { peer: this.remotePeerId, ct };
    // Best-effort delivery. The relay WS can be mid-reconnect (idle/NAT drop, or
    // a session_new/session-replacement teardown) when we push a server→app frame
    // — notably the action_ok/action_error ack a handler emits right after
    // newSession. `relay.send` throws "relay: not connected" in that window; since
    // this runs inside an async SDK event callback, letting it propagate becomes an
    // uncaughtException that kills the whole pi process. The relay auto-reconnects
    // and the app re-syncs via session_sync, so a dropped frame is recoverable — a
    // crash is not. Mirrors RelayClient.sendControl's no-op-when-closed policy.
    try {
      this.relay.send(JSON.stringify(outer));
    } catch {
      /* relay down — drop this frame; reconnect + session_sync will recover */
    }
  }

  /**
   * Send an rpc-envelope message (`{ rpc | evt }`, docs/rpc-envelope.md) to the
   * app. Same base64-into-`ct` outer wire as `send` — the relay stays opaque —
   * but the inner payload is an `EnvelopeMessage`, not a `ServerMessage`.
   * Best-effort, mirroring `send`: a relay mid-reconnect must not throw an
   * uncaught exception out of the SDK event callback that drives it.
   */
  sendEnvelope(env: EnvelopeMessage): void {
    // Stamp the wrapper kind + timestamp at the single outbound choke.
    const wire: EnvelopeMessage = {
      ...env,
      // Namespace: un-bien plane -> "un"; rpc/evt still stamp legacy "env" this
      // wave (the explicit rpc/evt split lands later).
      type: env.type ?? (env.un !== undefined ? UN_KIND : ENVELOPE_KIND),
      ts: env.ts ?? Date.now(),
    };
    const ct = Buffer.from(JSON.stringify(wire)).toString("base64");
    const outer: OuterEnvelope = { peer: this.remotePeerId, ct };
    try {
      this.relay.send(JSON.stringify(outer));
    } catch {
      /* relay down — drop this frame; reconnect + session_sync will recover */
    }
  }

  /** Detaches from relay (does not close the relay itself). */
  detach(): void {
    this._unsubscribe();
  }

  // ── Incoming line from relay ────────────────────────────────────────────────

  private _onLine(line: string): void {
    let outer: OuterEnvelope;
    try {
      outer = JSON.parse(line) as OuterEnvelope;
    } catch {
      return; // malformed line
    }

    if (outer.peer !== this.remotePeerId) return;
    if (!outer.ct) return;

    let plaintext: string;
    try {
      plaintext = Buffer.from(outer.ct, "base64").toString("utf8");
    } catch {
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(plaintext);
    } catch {
      return;
    }

    if (!msg || typeof msg !== "object") return;
    const obj = msg as Record<string, unknown>;

    envLog(
      `inbound<-${this.remotePeerId.slice(0, 8)}: type=${String(obj.type)} rpc=${obj.rpc !== undefined} evt=${obj.evt !== undefined}`,
    );

    // New-protocol mesh-envelope inbound: an `env`/`un` wrapper (or a bare
    // rpc/evt/un body, for transition robustness) routes to the envelope
    // dispatcher, NOT the stock ClientMessage switch. The dispatcher branches
    // by plane (rpc vs un) itself.
    if (
      obj.type === ENVELOPE_KIND ||
      obj.type === UN_KIND ||
      obj.rpc !== undefined ||
      obj.evt !== undefined ||
      obj.un !== undefined
    ) {
      this.onRpc?.(obj as EnvelopeMessage, this);
      return;
    }

    if (typeof obj.type !== "string") return;
    this.onMessage(msg as ClientMessage);
  }
}
