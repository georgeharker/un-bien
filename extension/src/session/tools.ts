import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { TransportErrorReason } from "./envelope.js"
import type { AckResult, SessionPeer } from "./peer.js"
import { LOCAL_SESSION_NAME, sessionSockPath } from "./global_config.js"
import { MeshInbox, type MeshMessage } from "./mesh_inbox.js"

const NOT_IN_SESSION = "Not in a session. Run /unbien join first"
const ACK_TIMEOUT_MS = 5_000
const LEGACY_REQUEST_TIMEOUT_MS = 30_000
const LIST_PEERS_TIMEOUT_MS = 2_000

interface SendInput {
  to: string
  body: unknown
  re?: string
}

interface RequestInput {
  to: string
  body: unknown
  timeout_ms?: number
}

type SendStatus =
  "received" | "busy" | "denied" | "timeout" | "sent" | "refused" | "unknown_peer"

interface SendDetails {
  status: SendStatus
  ok: boolean
  error?: string
  target?: string
  reason?: TransportErrorReason
}

/**
 * Registers the native tools the Pi LLM uses to talk to other agents in the
 * same UDS session (plano 19 transport + plan/25 Wave 0 ACK protocol):
 *
 *   - `agent_send`     — unified delivery with broker-level ACK. Returns
 *                        a status so the LLM can decide whether to retry.
 *                        For unicast targets the broker auto-replies with
 *                        `received | busy | denied`. For broadcast/multicast
 *                        the tool is fire-and-forget (status `sent`).
 *   - `agent_request`  — **deprecated**. Still works (send + block on reply
 *                        via `re` correlation) but the LLM should migrate
 *                        to the event-driven send+inbox pattern. Each call
 *                        emits a one-shot warning to stderr.
 *
 * Reply pattern (new world): when you receive a message you want to answer,
 * send back another envelope with `re=<original-id>`. The original sender
 * sees that reply in its inbox during a future turn.
 *
 * `getSessionPeer` is a getter (not a captured value) so changes to the
 * underlying `_sessionPeer` module variable are observed live.
 */
export function registerAgentTools(
  pi: ExtensionAPI,
  getSessionPeer: () => SessionPeer | null,
  getInbox: () => MeshInbox,
  getRemoteRelayPeers: () => string[] = () => [],
  getRemoteRelayPeersDetail: () => Map<string, { relayName: string; addresses: string[] }> = () => new Map(),
  getRelay: () => { send: (data: string) => void } | null = () => null,
): void {
  const SendParams = Type.Object({
    to: Type.String({
      description:
        "Recipient agent name (e.g. 'backend'), 'broadcast', or array of names. " +
        "Broadcast/multicast are fire-and-forget; unicast returns an ACK status.",
    }),
    body: Type.Unknown({
      description: "Free-form JSON payload. String or object — your choice.",
    }),
    re: Type.Optional(
      Type.String({
        description:
          "Set this to the `id` of an incoming message when you are REPLYING to it. " +
          "The peer correlates your answer with their original send via this field.",
      }),
    ),
  })

  const RequestParams = Type.Object({
    to: Type.String({
      description:
        "Recipient agent name. Must be a single peer (not broadcast).",
    }),
    body: Type.Unknown({ description: "Free-form JSON payload to send." }),
    timeout_ms: Type.Optional(
      Type.Number({
        description:
          "Optional override of the default 30s reply timeout. Per-request.",
      }),
    ),
  })

  pi.registerTool<typeof SendParams, SendDetails>({
    name: "agent_send",
    label: "Agent Send",
    description:
      "Send a message to another Pi agent in the current local session and " +
      "wait for the broker's delivery ACK. Delivery is reliable: a peer that " +
      "is mid-turn still receives the message (its harness enqueues it for " +
      "the next turn), so you never need to retry. Returns one of: `received` " +
      "(delivered; peer will process it in an upcoming turn), `denied` (peer " +
      "refused), `timeout` (no ACK in 5s — peer offline / transport error), " +
      "`sent` (broadcast/multicast — no ACK semantics). Use `re` to mark this " +
      "message as a reply to an incoming envelope's `id` (correlation only).",
    promptSnippet:
      "agent_send({to, body, re?}): unicast → returns {status: received|denied|timeout} (delivery is reliable; no retry-on-busy). Broadcast/multicast → fire-and-forget ({status:'sent'}).",
    parameters: SendParams,
    execute: async (_toolCallId, params) => {
      const peer = getSessionPeer()
      if (!peer) {
        const details: SendDetails = {
          status: "refused",
          ok: false,
          error: NOT_IN_SESSION,
        }
        return {
          content: [{ type: "text", text: NOT_IN_SESSION }],
          details,
        }
      }
      const { to, body, re } = params as SendInput
      if (to === peer.address() || to === peer.name()) {
        const msg = `Refused: cannot agent_send to yourself ("${to}"). Just do the work directly.`
        const details: SendDetails = {
          status: "refused",
          ok: false,
          error: msg,
        }
        return {
          content: [{ type: "text", text: msg }],
          details,
        }
      }

      const isUnicast = to !== "broadcast"

      // Federated peer routing: if the target is on a federated peer relay,
      // send a pi_envelope directly via the relay. The relay handles cross-relay
      // forwarding (Phase 3c). This works with OR without the BrokerRemote
      // (the bridge might not be attached if the topology is empty).
      if (isUnicast) {
        const fedDetail = getRemoteRelayPeersDetail()
        const relay = getRelay()
        if (relay) {
          for (const [epk, info] of fedDetail) {
            if (info.addresses.includes(to)) {
              const envelope = {
                from: peer.address(),
                to,
                body,
                id: crypto.randomUUID(),
                re: re ?? null,
              }
              try {
                relay.send(JSON.stringify({
                  type: "pi_envelope",
                  to_pc: epk,
                  envelope,
                }))
                const details: SendDetails = { status: "sent", ok: true }
                return {
                  content: [{ type: "text", text: `Sent to federated peer (${info.relayName}).` }],
                  details,
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                const details: SendDetails = { status: "timeout", ok: false, error: msg }
                return {
                  content: [{ type: "text", text: `Federated send failed: ${msg}` }],
                  details,
                }
              }
            }
          }
        }
      }

      // Broadcast: fire-and-forget. Broker doesn't ACK multi-target sends.
      if (!isUnicast) {
        try {
          await peer.send(to, body, re ?? null)
          const details: SendDetails = { status: "sent", ok: true }
          return {
            content: [{ type: "text", text: `Broadcast sent.` }],
            details,
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const details: SendDetails = {
            status: "timeout",
            ok: false,
            error: msg,
          }
          return {
            content: [{ type: "text", text: `Broadcast failed: ${msg}` }],
            details,
          }
        }
      }

      // Unicast: wait for broker ACK.
      try {
        const ack = await peer.sendWithAck(to, body, re ?? null, ACK_TIMEOUT_MS)
        const ok = ack.status === "received"
        const details: SendDetails = {
          status: ack.status,
          ok,
          ...(ack.target === undefined ? {} : { target: ack.target }),
          ...(ack.error === undefined ? {} : { error: ack.error }),
          ...(ack.reason === undefined ? {} : { reason: ack.reason }),
        }
        const text = _formatAck(to, ack, re)
        return { content: [{ type: "text", text }], details }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const details: SendDetails = {
          status: "timeout",
          ok: false,
          error: msg,
        }
        return {
          content: [{ type: "text", text: `Failed to send: ${msg}` }],
          details,
        }
      }
    },
  })

  const ListPeersParams = Type.Object({})
  const WhoAmIParams = Type.Object({})
  type WhoAmI = { address: string; name: string; broker: string; socket: string }

  pi.registerTool<typeof ListPeersParams, { peers: string[]; self?: WhoAmI }>({
    name: "list_peers",
    label: "List Peers",
    description:
      "Returns the current peer inventory in this session as ADDRESSES of the " +
      "form `<cwd>@<name>` (cross-PC peers prefixed `<pc>:`). An address is an " +
      "opaque routing key — pass it to `agent_send`/`agent_request` VERBATIM, " +
      "never build one by hand. Use BEFORE sending whenever you're unsure who's " +
      "available, or after a `peer_joined` / `peer_left` notification to refresh " +
      "your mental model. Resolves in milliseconds — a metadata query to the " +
      "broker, not a turn of another agent.",
    promptSnippet:
      "list_peers(): returns {peers: string[]} of addresses `<cwd>@<name>` (`<pc>:` prefix cross-PC). Echo an address verbatim to agent_send; never compose one. Cheap; call freely.",
    parameters: ListPeersParams,
    execute: async (_toolCallId) => {
      const peer = getSessionPeer()
      if (!peer) {
        return {
          content: [{ type: "text", text: NOT_IN_SESSION }],
          details: { peers: [] },
        }
      }
      try {
        // Request the current federated peer list from the relay (refreshes
        // the cache via the listener in index.ts). Best-effort — the cache
        // might update on the NEXT call if the response hasn't arrived yet.
        const relay = getRelay()
        if (relay) {
          try { relay.send(JSON.stringify({ type: "get_federated_peer_list" })) } catch { /* best-effort */ }
        }
        // Internal use of the request/reply primitive is fine — broker
        // replies are synthesised in-process (`_handleBrokerMessage`)
        // without going through `_route`, so they bypass the ACK path.
        const reply = await peer.request(
          "broker",
          { type: "list_peers" },
          LIST_PEERS_TIMEOUT_MS,
        )
        const body = reply.body as { peers?: unknown } | null
        const peers = Array.isArray(body?.peers)
          ? (body!.peers as unknown[]).filter(
              (p): p is string => typeof p === "string",
            )
          : []
        // Drop self from the list — the caller is the only one who can't
        // address itself anyway, so listing it is noise. Peers are ADDRESSES
        // (plan/38), so filter by address.
        const selfAddress = peer.address()
        const combined = [...peers, ...getRemoteRelayPeers()]
        const filtered = combined.filter((p) => p !== selfAddress)
        const text = filtered.length === 0 ? "(no peers)" : filtered.join("\n")
        return {
          content: [{ type: "text", text }],
          details: {
            peers: filtered,
            self: {
              address: peer.address(),
              name: peer.name(),
              broker: LOCAL_SESSION_NAME,
              socket: sessionSockPath(LOCAL_SESSION_NAME),
            },
          },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `list_peers failed: ${msg}` }],
          details: { peers: [] },
        }
      }
    },
  })

  pi.registerTool<typeof WhoAmIParams, WhoAmI>({
    name: "whoami",
    label: "Who Am I (mesh)",
    description:
      "Returns THIS agent's mesh identity: address (<cwd>@<name>), " +
      "broker-assigned name, broker session, and socket path. Use to confirm " +
      "which broker you're on and what address others should send to. Pair " +
      "with list_peers (others).",
    promptSnippet:
      "whoami(): returns {address, name, broker, socket} — your mesh identity. Cheap; call freely.",
    parameters: WhoAmIParams,
    execute: async () => {
      const peer = getSessionPeer()
      const broker = LOCAL_SESSION_NAME
      const socket = sessionSockPath(broker)
      if (!peer) {
        const details: WhoAmI = { address: "", name: "", broker, socket }
        return { content: [{ type: "text", text: NOT_IN_SESSION }], details }
      }
      const details: WhoAmI = {
        address: peer.address(),
        name: peer.name(),
        broker,
        socket,
      }
      return {
        content: [{ type: "text", text: `${details.address} (broker "${broker}")` }],
        details,
      }
    },
  })

  pi.registerTool<typeof RequestParams, unknown>({
    name: "agent_request",
    label: "Agent Request (deprecated)",
    description:
      "DEPRECATED — prefer `agent_send` + observing your inbox for the " +
      "reply (correlated by `re=<your-send-id>`). This tool still works: " +
      "it sends a message and synchronously blocks until the peer replies " +
      "or the timeout fires. Default 30s. Will be removed in a future " +
      "release; migrate to the event-driven pattern in the agent-network skill.",
    promptSnippet:
      "agent_request({to, body, timeout_ms?}): DEPRECATED synchronous request/reply (blocks current turn). Prefer agent_send + inbox observation.",
    parameters: RequestParams,
    execute: async (_toolCallId, params) => {
      const peer = getSessionPeer()
      if (!peer) {
        return {
          content: [{ type: "text", text: NOT_IN_SESSION }],
          details: { error: NOT_IN_SESSION },
        }
      }
      const { to, body, timeout_ms } = params as RequestInput
      if (to === peer.address() || to === peer.name()) {
        const msg = `Refused: cannot agent_request to yourself ("${to}"). Just do the work directly.`
        return {
          content: [{ type: "text", text: msg }],
          details: { error: msg },
        }
      }
      const timeout =
        typeof timeout_ms === "number" && timeout_ms > 0
          ? timeout_ms
          : LEGACY_REQUEST_TIMEOUT_MS
      try {
        const reply = await peer.request(to, body, timeout)
        const text =
          typeof reply.body === "string"
            ? reply.body
            : JSON.stringify(reply.body)
        return {
          content: [{ type: "text", text }],
          details: reply.body,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `Request failed: ${msg}` }],
          details: { error: msg },
        }
      }
    },
  })

  // ── Inbox pull (recover a missed push / wait for a reply) ───────────────
  // The get_subagent_result analog: every inbound mesh message is stored in
  // the MeshInbox (index.ts feeds it on delivery), so a missed push is
  // recoverable, and a reply can be awaited by correlation id (re) — the
  // clean replacement for the deprecated agent_request's blocking semantics.
  const GetMessageParams = Type.Object({
    id: Type.String({ description: "The message id to fetch." }),
  })
  pi.registerTool<typeof GetMessageParams, MeshMessage | null>({
    name: "mesh_get_message",
    label: "Get Mesh Message",
    description:
      "Fetch one inbound mesh message by id (the id the sender assigned, " +
      "shown in the pushed nudge). Returns the full typed payload, or null " +
      "if no such message. Use to recover a message you missed the push for.",
    promptSnippet:
      "mesh_get_message({id}): returns the MeshMessage {id,from,to,body,re,sentAt} or null. Cheap; call freely.",
    parameters: GetMessageParams,
    execute: async (_toolCallId, params) => {
      const { id } = params as { id: string }
      const msg = getInbox().get(id)
      return {
        content: [{ type: "text", text: msg ? JSON.stringify(msg) : "(no such message)" }],
        details: msg,
      }
    },
  })

  const ListMessagesParams = Type.Object({
    from: Type.Optional(Type.String({ description: "Only messages from this sender address." })),
    re: Type.Optional(Type.String({ description: "Only messages with this correlation id (re)." })),
    sinceMs: Type.Optional(Type.Number({ description: "Only messages at-or-after this epoch ms." })),
    limit: Type.Optional(Type.Number({ description: "Max messages to return (newest N)." })),
  })
  pi.registerTool<typeof ListMessagesParams, { messages: MeshMessage[] }>({
    name: "mesh_list_messages",
    label: "List Mesh Messages",
    description:
      "List inbound mesh messages in this inbox (newest-first when limit is " +
      "set), optionally filtered by sender (from) and/or correlation id (re). " +
      "Use to recover messages you missed, or to review recent inbound.",
    promptSnippet:
      "mesh_list_messages({from?, re?, sinceMs?, limit?}): returns {messages: MeshMessage[]}. Cheap; call freely.",
    parameters: ListMessagesParams,
    execute: async (_toolCallId, params) => {
      const { from, re, sinceMs, limit } = params as {
        from?: string; re?: string; sinceMs?: number; limit?: number
      }
      const messages = getInbox().list(
        { from, re, sinceMs },
        typeof limit === "number" && limit > 0 ? limit : undefined,
      )
      const text = messages.length === 0
        ? "(no messages)"
        : messages.map((m) => `${m.id}  from=${m.from}${m.re ? ` re=${m.re}` : ""}`).join("\n")
      return { content: [{ type: "text", text }], details: { messages } }
    },
  })

  const WaitMessageParams = Type.Object({
    from: Type.Optional(Type.String({ description: "Wait for a message from this sender address." })),
    re: Type.Optional(Type.String({ description: "Wait for a message with this correlation id (re) — the reply to your agent_send." })),
    sinceMs: Type.Optional(Type.Number({ description: "Only consider messages at-or-after this epoch ms." })),
    timeout_ms: Type.Optional(Type.Number({ description: "Max ms to wait (default 30000). 0 or non-positive = poll (return immediately if a match is already stored, else null)." })),
  })
  pi.registerTool<typeof WaitMessageParams, MeshMessage | null>({
    name: "mesh_wait_message",
    label: "Wait For Mesh Message",
    description:
      "Block until an inbound mesh message matching the filter arrives, then " +
      "return it; or return immediately if one is already stored. The " +
      "agent_request replacement: agent_send with `re`, then wait_message with " +
      "the same `re`. A reply that arrived before this call is returned at " +
      "once (not re-awaited). Returns null on timeout.",
    promptSnippet:
      "mesh_wait_message({from?, re?, timeout_ms?}): blocks up to timeout (default 30s) for a matching MeshMessage; returns it or null. This is the reply-wait primitive.",
    parameters: WaitMessageParams,
    execute: async (_toolCallId, params) => {
      const { from, re, sinceMs, timeout_ms } = params as {
        from?: string; re?: string; sinceMs?: number; timeout_ms?: number
      }
      const timeout =
        typeof timeout_ms === "number" && timeout_ms > 0 ? timeout_ms : 30_000
      const msg = await getInbox().wait({ from, re, sinceMs }, timeout)
      return {
        content: [{ type: "text", text: msg ? JSON.stringify(msg) : "(no message within timeout)" }],
        details: msg,
      }
    },
  })
}

function _formatAck(
  to: string,
  ack: AckResult,
  re: string | null | undefined,
): string {
  const reSuffix = re ? ` (re=${re})` : ""
  const errorSuffix = ack.error ? ` (${ack.error})` : ""

  switch (ack.status) {
    case "received":
      return `Delivered to "${to}"${reSuffix} — peer will process it in an upcoming turn.`
    case "busy":
      // plan/34 removed busy-drop: the current broker never returns `busy`. If
      // we still see it, an OUT-OF-DATE broker leader dropped the message — so
      // be honest that it was NOT delivered, and point at the fix.
      return (
        `NOT delivered — "${to}"${reSuffix} came back BUSY, which only ` +
        `happens when an out-of-date broker leader dropped the message. ` +
        `Restart the agent leading the local broker (oldest Pi/unbien process) ` +
        `to pick up the new build, then resend.`
      )
    case "denied":
      if (ack.reason === "not_authorized") {
        return (
          `Relay did not authorize delivery to "${to}"${reSuffix}${errorSuffix}. ` +
          `Do not blindly retry; verify authorization first.`
        )
      }
      if (ack.reason === "bad_envelope") {
        return (
          `Relay rejected the envelope for "${to}"${reSuffix}${errorSuffix}. ` +
          `Do not blindly retry; correct the envelope first.`
        )
      }
      return `"${to}" denied the message${reSuffix}. Do not retry; report to user.`
    case "timeout":
      if (ack.reason === "offline") {
        return (
          `Immediate Relay offline transport error for "${to}"${reSuffix}${errorSuffix}; ` +
          `reported as timeout without waiting for the ACK deadline.`
        )
      }
      return `No ACK from "${to}" within ${ACK_TIMEOUT_MS}ms${reSuffix} — transport error. Investigate or retry later.`
    case "unknown_peer":
      return (
        `No peer "${to}" on this broker${reSuffix} — it is not registered ` +
        `here (it may be on a different broker, or offline). Check ` +
        `list_peers / whoami before retrying.`
      )
  }
}
