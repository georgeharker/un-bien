import { Buffer } from "node:buffer";
import { hostname, homedir } from "node:os";
import { RelayClient } from "../transport/relay_client.js";
import { PlainPeerChannel } from "../transport/peer_channel.js";
import { getOrCreateEd25519Keypair } from "../pairing/storage.js";
import { roomIdForControl } from "../rooms.js";
import { _findKnownPeer } from "../pairing/peer_trust.js";
import { _launchSession, _expandTilde } from "../launch.js";
import {
  helloEnvelope,
  isEnvelopeFrame,
  type EnvelopeMessage,
} from "../session/rpc_envelope.js";
import { loadConfig, resolveRelayUrl } from "../config.js";
import {
  loadLocalConfig,
  effectiveAllowRemoteLaunch,
} from "../session/local_config.js";
import { envLog } from "../session/debug_log.js";
import type { ClientMessage, ServerMessage } from "../protocol/types.js";

/**
 * Regime-2 machine-launcher core (pi-INDEPENDENT — no pi SDK). A lightweight
 * mesh peer that lets a paired app reach a machine with NO live pi session:
 * it joins the machine-level control room (roomIdForControl), advertises the
 * `remote_launch` capability, and on a `session_launch` frame spawns a
 * tmux/herdr window via the shared launch module. Owner-auth reuses the extension's
 * exact gate (relay verifies the peer's key; _findKnownPeer checks peers.json).
 *
 * NOT a pi process: no transcript/rpc/panels, no pairing (pairing happens once
 * via any session extension's QR — the launcher only trusts already-paired owners).
 */

const RECONNECT_DELAY_MS = 3_000;

/** Caps the launcher daemon advertises: `remote_launch` gates the app's launch
 *  control; `is_daemon` marks the control room so the app filters it. */
const DAEMON_CAPS = ["remote_launch", "is_daemon"] as const;

export interface LauncherHandle {
  readonly roomId: string;
  readonly epk: string;
  stop(): void;
}

export async function startLauncher(): Promise<LauncherHandle> {
  const kp = await getOrCreateEd25519Keypair();
  const epk = Buffer.from(kp.publicKey).toString("base64url");
  const roomId = roomIdForControl(epk);

  const resolution = resolveRelayUrl();
  if (!resolution.url) {
    throw new Error(
      "un-bien launcher: no relay configured (set UNBIEN_RELAY or the `relay` config key)",
    );
  }
  const relayUrl = resolution.url;

  let stopped = false;
  let relay: RelayClient | null = null;
  const channels = new Map<string, PlainPeerChannel>();

  /** The machine's configured launch backend (rpc is a fast-follow). */
  function configuredBackend(): "tmux" | "herdr" {
    return loadConfig().launch?.backend === "herdr" ? "herdr" : "tmux";
  }

  /** Liveness: answer a stock `ping` with `pong`, mirroring the extension's
   *  transport-control handler (index.ts) so a health check works against an
   *  idle machine too. Distinct from the `presence_status` caps PULL — this is
   *  the plain are-you-there reply, no caps. */
  function handleStockMessage(
    msg: ClientMessage,
    sender: PlainPeerChannel,
  ): void {
    if ((msg as { type?: string }).type === "ping") {
      sender.send({
        type: "pong",
        in_reply_to: (msg as { id?: string }).id,
      } as ServerMessage);
    }
  }

  /** Handle a ub-frame from an attached owner. `presence_status` is the
   *  DAEMON-SPECIFIC caps PULL (design 01M1813Q) — reply with caps + hostname +
   *  backend. `session_launch` mirrors the extension's _routeUnBienPlaneFrom handler:
   *  per-cwd opt-in, machine-config backend, clean exec (no keystrokes). */
  function handleUbFrame(env: EnvelopeMessage, sender: PlainPeerChannel): void {
    if (env.ub === undefined) return;
    const frame = env.ub as Record<string, unknown>;

    if (frame.type === "presence_status") {
      sender.sendEnvelope({
        ub: {
          type: "presence_status",
          caps: [...DAEMON_CAPS],
          hostname: hostname(),
          backend: configuredBackend(),
          ...(typeof frame.id === "string" ? { in_reply_to: frame.id } : {}),
        },
      });
      return;
    }

    if (frame.type !== "session_launch") return;
    const cwd = _expandTilde(
      typeof frame.cwd === "string" && frame.cwd.length > 0
        ? frame.cwd
        : process.cwd(),
    );
    if (!effectiveAllowRemoteLaunch(loadLocalConfig(cwd))) {
      envLog("launcher session_launch: remote launch disabled on this machine");
      return;
    }
    const launchError = _launchSession(
      configuredBackend(),
      cwd,
      typeof frame.name === "string" ? frame.name : undefined,
    );
    if (launchError) envLog(`launcher session_launch error: ${launchError}`);
  }

  async function gateAndAttach(
    r: RelayClient,
    peer: string,
    firstInner: unknown,
  ): Promise<void> {
    const known = await _findKnownPeer(peer);
    if (!known) {
      // Relay-verified but not a paired owner (never paired / revoked). Signal
      // so the app can react, mirroring the extension's unknown-peer reply.
      try {
        const errCt = Buffer.from(
          JSON.stringify({
            type: "error",
            code: "unknown_peer",
            message: "Peer not paired — re-scan QR",
          }),
        ).toString("base64");
        r.send(JSON.stringify({ peer, ct: errCt }));
      } catch {
        /* relay down — nothing to signal */
      }
      return;
    }
    if (channels.has(peer)) return;

    const channel = new PlainPeerChannel(
      r,
      peer,
      roomId,
      (msg) => handleStockMessage(msg, channel), // liveness ping->pong
      () => channels.delete(peer),
      (env) => handleUbFrame(env, channel),
    );
    channels.set(peer, channel);
    // Advertise machine caps up front so the app enables its launch control for
    // this control room. No sessionId — the launcher has no pi session.
    channel.sendEnvelope(helloEnvelope([...DAEMON_CAPS]));
    envLog(
      `launcher: owner ${peer.slice(0, 8)} (${known.name}) attached; caps sent`,
    );
    // The channel didn't see the line that triggered the attach — route it.
    if (isEnvelopeFrame(firstInner as Record<string, unknown>)) {
      handleUbFrame(firstInner as EnvelopeMessage, channel);
    }
  }

  function onMsg(r: RelayClient, line: string): void {
    let outer: { peer?: string; ct?: string };
    try {
      outer = JSON.parse(line) as { peer?: string; ct?: string };
    } catch {
      return;
    }
    if (!outer.peer || !outer.ct) return;
    if (channels.has(outer.peer)) return; // its PlainPeerChannel handles routing

    let inner: unknown;
    try {
      inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"));
    } catch {
      return;
    }
    if (!inner || typeof inner !== "object") return;
    void gateAndAttach(r, outer.peer, inner);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    setTimeout(() => {
      if (stopped) return;
      connectOnce().catch(() => scheduleReconnect());
    }, RECONNECT_DELAY_MS);
  }

  async function connectOnce(): Promise<void> {
    const r = new RelayClient(relayUrl, kp);
    relay = r;
    r.on("message", (line: string) => onMsg(r, line));
    r.on("close", () => {
      channels.clear();
      if (!stopped) scheduleReconnect();
    });
    await r.connect({
      roomId,
      // caps ride room_meta so the app filters the control room from the announce.
      roomMeta: { name: hostname(), cwd: homedir(), caps: [...DAEMON_CAPS] },
    });
    envLog(
      `launcher: connected to control room ${roomId} (epk ${epk.slice(0, 12)}…)`,
    );
  }

  await connectOnce();

  return {
    roomId,
    epk,
    stop() {
      stopped = true;
      for (const ch of channels.values()) {
        try {
          ch.detach();
        } catch {
          /* best-effort */
        }
      }
      channels.clear();
      relay?.close();
    },
  };
}
