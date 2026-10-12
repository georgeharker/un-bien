# Cross-Session Comms (Agent Mesh)

un-bien provides LLM-agnostic cross-session messaging for pi + un-bien.
Any model running in pi can call the mesh tools to send messages to,
list, and wait for replies from other pi sessions on the same machine
(local UDS broker), across machines (via the relay, same-owner
validated), or across relays (via relay federation, same-owner validated).

See [Relay Peering](relay-peering.md) for the federation design +
setup guide.

## Enable / Disable

The mesh tools are **enabled by default**. To disable them (the broker
and relay still work for the paired app; the model just can't call the
mesh tools), set in `~/.config/pi/agent/extensions/un-bien.json`:

```json
{
  "mesh": {
    "tools": false
  }
}
```

Absent or `true` ⇒ tools registered. `false` ⇒ tools not registered.
Restart pi to pick up a flip.

## Tools

| Tool                                                 | Description                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_send({to, body, re?})`                        | Unicast send to a peer (by address from `list_peers`). Returns `{status, ok}` — `received` (delivered), `denied` (peer refused / cross-owner), `unknown_peer` (not on any reachable broker), `timeout` (registered but no ACK), `sent` (broadcast).                                              |
| `list_peers()`                                       | Returns the current peer inventory as addresses `<cwd>@<name>` (cross-PC prefixed `<pc>:`, cross-relay prefixed `<relayName>:`). Includes `self` (your own `whoami`). Excludes self from the `peers` array. Federated peers (on a peer relay) appear via the relay's `federated_peer_list` push. |
| `whoami()`                                           | Returns your mesh identity: `{address, name, broker, socket}`.                                                                                                                                                                                                                                   |
| `mesh_get_message({id})`                             | Fetch one inbound mesh message by id (recover a missed push). Returns `MeshMessage` or `null`.                                                                                                                                                                                                   |
| `mesh_list_messages({from?, re?, sinceMs?, limit?})` | List inbound mesh messages (filtered by sender / correlation id / timestamp).                                                                                                                                                                                                                    |
| `mesh_wait_message({from?, re?, timeout_ms?})`       | Block until a matching message arrives (or timeout). Returns `MeshMessage` or `null`. The `agent_request` replacement: `agent_send` with `re` → `mesh_wait_message` with the same `re`. `timeout_ms: 0` = poll (return immediately if a match is already stored).                                |
| `agent_request({to, body, timeout_ms?})`             | **Deprecated** — prefer `agent_send` + `mesh_wait_message`. Still works (blocking request/reply).                                                                                                                                                                                                |

### MeshMessage type

```ts
{
  id: string // the envelope id the sender assigned
  from: string // sender address
  to: string // recipient (your address, or "broadcast")
  body: unknown // free-form JSON payload
  re: string | null // correlation id (reply to an earlier message)
  sentAt: number // epoch ms when the broker delivered it
  deliveredAt: number | null // epoch ms when pushed via pi.sendMessage
}
```

## Delivery model

- **Push (nudge):** every inbound mesh message is pushed via
  `pi.sendMessage` (a user message in the agent's next turn) AND stored
  in the `MeshInbox`. The push is the "nudge" (a preview + the message
  `id`); the typed record lives in the inbox for pull.
- **Pull (recover):** `mesh_get_message` / `mesh_list_messages` read
  from the `MeshInbox` — a missed push is recoverable. The inbox is
  bounded (1000 messages, oldest dropped).
- **Wait (block):** `mesh_wait_message` blocks until a matching message
  arrives (or timeout). A reply that already arrived is returned
  immediately (not re-awaited).

## Error semantics (`agent_send` status)

| Status         | Meaning                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `received`     | Delivered to the peer; it will process the message in an upcoming turn.                                                   |
| `denied`       | The peer (or the relay for cross-owner) refused the message. `reason: "not_authorized"` = cross-owner.                    |
| `unknown_peer` | The peer is not registered on any reachable broker (local or relay). Fast — no 5s timeout. Check `list_peers` / `whoami`. |
| `timeout`      | The peer is registered but no ACK arrived within 5s (peer offline / transport error).                                     |
| `sent`         | Broadcast/multicast — fire-and-forget (no ACK semantics).                                                                 |

## Events (for other extensions / observers)

un-bien emits on `pi.events`:

| Event                      | Payload                  | When                                                            |
| -------------------------- | ------------------------ | --------------------------------------------------------------- |
| `un-bien:peer_joined`      | `{address}`              | A peer joined the local broker.                                 |
| `un-bien:peer_left`        | `{address}`              | A peer left the local broker.                                   |
| `un-bien:message_received` | `{message: MeshMessage}` | An inbound mesh message arrived (stored in the inbox + pushed). |

## `/name` and `list_peers`

`/name <new>` renames the session live: the relay room meta updates
(app tile) AND the broker mesh name is re-keyed in-place (no
teardown/rejoin, no leader re-election) so `list_peers` reflects the
new name immediately. Other peers' `list_peers` updates too (via
`peer_left`/`peer_joined` broadcast).

No `/reload` needed.

## Broker architecture

- **Local (same machine):** one UDS broker per machine
  (`~/.local/state/un-bien/sessions/local/broker.sock`), keyed by
  `LOCAL_SESSION_NAME = "local"`. All pi sessions on the machine share
  it. Same-machine = same Ed25519 epk = same owner (by construction).
- **Cross-machine (same relay):** the `BrokerRemote` + `PiForwardClient`
  forward via the relay. The relay validates same-owner
  (`is_authorized_canonical`: both peers must be in the same owner's
  `mesh_versions` membership). Cross-owner → `not_authorized` → the
  sender gets `status: "denied"`.
- **Cross-relay (federated):** when the target is on a peer relay, the
  local relay forwards the `pi_envelope` cross-relay via the
  `relay_forward` / `relay_forward_ack` protocol. The `BrokerRemote`
  discovers federated peers via the relay's `federated_peer_list` push
  (Phase 4) + routes to them via `_routeToFederated` (strips the
  `<relayName>:` prefix + sends via `pi_envelope` — the relay does the
  cross-relay hop). See [Relay Peering](relay-peering.md) for
  the full federation design.

## Same-owner validation

- **Cross-machine:** the relay refuses cross-owner sends
  (`transport_error: not_authorized`). Two users on the same machine
  with different keys meet on the relay → same-owner check → refused.
- **Cross-relay:** same check — the sending relay validates same-owner
  before forwarding cross-relay. The receiving relay trusts the sending
  relay's check (federation requires shared-owner verification on
  connect). Cross-owner → `not_authorized` → refused.
- **Local:** same-machine = same epk = same owner (by construction).
  Two users with different HOMEs have different broker sockets → they
  don't share a local broker → they only meet on the relay (where
  same-owner is validated).

## Tool name collision safety

The mesh tools are named to avoid collisions with Claude built-ins
(`WebSearch`, `Read`, `Bash`, …) and pi-subagents (`subagent`,
`get_subagent_result`, `steer_subagent`):

- `agent_send`, `agent_request`, `list_peers` — existing un-bien tools.
- `whoami` — self-introspection (no collision).
- `mesh_get_message`, `mesh_list_messages`, `mesh_wait_message` —
  `mesh_` prefix (no collision with the generic `get_*` / `list_*`).

## App safety

No new app-facing frame types. The mesh tools ride existing
`tool_execution` frames; the inbox push rides `pi.sendMessage`
(message frames). The app already ignores unknown envelope inner types
(`applyEvt` / `applyRpc` `default: break`). **No iOS/macOS app changes
required.**
