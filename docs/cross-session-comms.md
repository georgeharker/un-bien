# Cross-Session Comms (Agent Mesh)

un-bien provides LLM-agnostic cross-session messaging for pi + un-bien.
Any model running in pi can call the mesh tools to send messages to,
list, and wait for replies from other pi sessions on the same machine
(local UDS broker), across machines (via the relay, same-owner
validated), or across relays (via relay federation — explicit pinned
pairing between relays, owner-set-validated sends).

## Setting up federated (cross-relay) peers

Federation lets agents on different machines (each running its own
relay) discover and message each other. Relays federate via **explicit
pairing** (pinned pubkeys) — see [Relay Peering](relay-peering.md) for
the full prerequisites + wire protocol. It is **opt-in**:

1. **Enable the gate on each relay** — the relay refuses the peering
   route entirely unless `federation.enabled` is true in the relay's
   CONFIG (`~/.config/un-bien/relay.json`):

   ```sh
   unbien relay peer federation on
   # federation on|off|status — flips federation.enabled in relay.json
   # (the CLI writes the config file; the relay picks the change up live)
   ```

2. **Set the relay's reachable URL** — in the relay's plist/service env
   (`UNBIEN_RELAY_URL`, e.g. `ws://cascade.tailnet.ts.net:3000` via
   Tailscale). Required for federated relays — a `0.0.0.0` bind makes
   the reachable address underivable, and both the pairing auto-add and
   the `relay_hello` dial-back advertisement use it. The relay's name is
   auto-computed from the hostname.

3. **Restart the relay once** after installing a new build:

   ```sh
   launchctl kickstart -k gui/$(id -u)/com.georgeharker.unbien.relay
   ```

4. **Pair the relays** — from one machine, issue a pairing URL; on the
   other, consume it (stores the pin + secret, auto-enables the gate;
   the issuer auto-adds the consumer back — one pairing action
   configures both directions):

   ```sh
   unbien relay pair                 # on machine A -> prints relay-pair://...
   unbien relay peer add relay-pair://...  # on machine B
   ```

   Dual-direction manual pairing (mint + consume on each side) also
   works — the pairing URL always pins the peer's pubkey. The legacy
   plain form (`unbien relay peer add <url> <name>`) is refused:
   pinned pairing is mandatory.

   No restart needed — the relay watches `relay-peers.json` (fswatch)
   and connects within seconds. (Peers live in the state root's
   `relay-peers.json` — per-machine topology; the config root's
   `relay.json` holds the settings.)

5. **Launch sessions remotely from the CLI** — `unbien create-session
droplet` (or `resume-session`) resolves federated machines from the
   peer list and launches through your local relay.

6. **Verify** — with a pi session running on each machine (its
   `pairing_set` populates the relay's owner registry):

   ```sh
   unbien relay list      # local + remembered + federated peers
   list_peers             # shows remote-machine agents as `<relay>:<cwd>@<name>`
   agent_send             # routes cross-relay transparently
   ```

See [Relay Peering](relay-peering.md) for the full design + wire
protocol.

## Enable / Disable

The mesh tools are **enabled by default**. To disable them (the broker
and relay still work for the paired app; the model just can't call the
mesh tools), set in `~/.config/pi/agent/extensions/un-bien.json`:

```json
{
  "mesh": {
    "tools": false,
    "federation": false
  }
}
```

`tools` — absent or `true` ⇒ mesh tools registered; `false` ⇒ not registered.
`federation` — absent or `true` ⇒ this machine participates in cross-relay
federation (discovery, routing, inbound); `false` ⇒ local/same-relay mesh
only. Distinct from `tools`: you can have tools without federation. The
relay's `federation.enabled` gate (~/.config/un-bien/relay.json) is the
master opt-in;
`mesh.federation` is the per-machine refusal switch. Restart pi on a flip.

## Tools

| Tool                                                 | Description                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_send({to, body, re?})`                        | Unicast send to a peer (by address from `list_peers`). Returns `{status, ok}` — `received` (delivered), `denied` (peer refused / cross-owner), `unknown_peer` (not on any reachable broker), `timeout` (registered but no ACK), `sent` (broadcast).                                                    |
| `list_peers()`                                       | Returns the current peer inventory as addresses `<cwd>@<name>` (remote machines prefixed `<pc>`, cross-relay prefixed `<relayName>:`). Includes `self` (your own `whoami`). Excludes self from the `peers` array. Federated peers (on a peer relay) appear via the relay's `federated_peer_list` push. |
| `whoami()`                                           | Returns your mesh identity: `{address, name, broker, socket}`.                                                                                                                                                                                                                                         |
| `mesh_get_message({id})`                             | Fetch one inbound mesh message by id (recover a missed push). Returns `MeshMessage` or `null`.                                                                                                                                                                                                         |
| `mesh_list_messages({from?, re?, sinceMs?, limit?})` | List inbound mesh messages (filtered by sender / correlation id / timestamp).                                                                                                                                                                                                                          |
| `mesh_wait_message({from?, re?, timeout_ms?})`       | Block until a matching message arrives (or timeout). Returns `MeshMessage` or `null`. The `agent_request` replacement: `agent_send` with `re` → `mesh_wait_message` with the same `re`. `timeout_ms: 0` = poll (return immediately if a match is already stored).                                      |
| `agent_request({to, body, timeout_ms?})`             | **Deprecated** — prefer `agent_send` + `mesh_wait_message`. Still works (blocking request/reply).                                                                                                                                                                                                      |

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
- **Cross-relay:** the sending relay checks at the SOURCE — the
  sender's machine-signed owner set must intersect the target's
  advertised machine-signed owner set (either side unknown => refuse).
  The link itself is explicit pairing (pinned relay pubkeys), not
  shared-owner. Cross-owner → `not_authorized` → refused.
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
