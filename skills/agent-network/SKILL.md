---
name: agent-network
description: Use when you (a Pi agent) are running inside a local agent session — i.e., when the Pi footer shows "📡 <session-name>". This skill teaches how to discover who's online (`list_peers`), how to send messages with delivery status (`agent_send` + ACK), how replies arrive in a future turn, how cross-PC addressing works (`<pc_label>:<peer>`), and the retry matrix for the four ACK statuses.
---

# Agent Network (skill — event-driven message protocol)

You are connected to a **local agent session** over a Unix Domain Socket.
Other Pi agents on the same machine, in the same session, can send you
messages and you can send messages to them.

This skill teaches how to participate in that network reliably. Read it
to the end before acting — the protocol is **event-driven**, not
request/reply, and getting that wrong leaves coordination broken.

---

## The most important rule

**You only receive messages that were explicitly addressed to you.** The
session broker filters before delivery. You will never see messages
intended for other agents or "broadcast with `exclude_self`".

**Practical consequence**: if a message arrived in your inbox, someone
wanted your attention. Don't ignore it.

---

## First thing to do in a new session: `list_peers`

Before you send anything, find out who's actually online. `list_peers` is
a cheap metadata tool that returns the current inventory:

```
list_peers()
→ { peers: ["backend", "frontend", "casa:agent-1", "trab:worker"] }
```

The reply is **synchronous** (broker resolves in milliseconds — this is
not a turn of another agent). Use it freely:

- At the start of a session, to see what mesh you're in
- After receiving `peer_joined` / `peer_left` to refresh
- Before any `agent_send` whose target name is uncertain

**Entry shape:**
- `backend` → local peer (this machine, same UDS broker)
- `casa:agent-1` → cross-PC peer on the Pi labeled `casa` (this Owner's
  other machine, reached through the relay)

You are excluded from the result — no need to filter yourself out.

---

## Anatomy of a message (envelope)

Every message has 5 fields:

```json
{
  "from": "orchestrator",
  "to": "backend",
  "id": "uuid-v7",
  "re": null,
  "body": <message contents>
}
```

| Field | Meaning |
|---|---|
| `from` | Who sent it. Use this to know who to reply to. |
| `to` | You (or "broadcast", or a list of names including yours). |
| `id` | Unique identifier of this specific message. |
| `re` | If this message is a REPLY to another, echoes that one's `id`. Otherwise `null`. |
| `body` | Free-form content. String or JSON object, sender's choice. |

---

## How sending works: `agent_send` returns an ACK status

`agent_send` is the **only** tool you need to talk to peers. Every
unicast call returns a status that tells you what happened at the
recipient. **Always inspect the status — it dictates what to do next.**

| Status | What it means | What you do |
|---|---|---|
| `received` | Peer was idle, broker handed the envelope over, peer will process it in its upcoming turn. | Move on. The reply (if any) arrives later in your inbox as a normal envelope with `re=<your-send-id>`. |
| `busy` | Peer is mid-turn — envelope **dropped**. | Retry 2× with backoff (2s, 5s). If still busy, abandon or escalate to the human. You own the retry. |
| `denied` | Peer explicitly refused the message. | Do NOT retry. Report to the user. |
| `timeout` | No ACK in 5s. Transport error — broker may be down, peer disappeared mid-handshake. | Treat as transient. Retry once after a longer delay (10s+), then escalate. |
| `sent` | You used `to: "broadcast"` or an array. There is no single ACK target. | Move on. Broadcasts are fire-and-forget. |
| `refused` | The tool refused your call locally (e.g., you tried to message yourself, or you're not in a session). | Fix the call. Don't retry the same arguments. |

`busy` is the most common non-trivial answer. Two **new** messages aimed
at the same peer in quick succession will see the second one as `busy`
— the peer can only be processing one turn at a time.

**Replies are exempt from busy gating.** A message with `re=<some-id>`
(an answer to something the recipient asked) is always delivered,
because it resolves pending state at the recipient rather than starting
a new turn for them. So if you fan out questions to several peers in
the same turn, every peer's reply will reach you even when you're still
processing — they all flow into your inbox for the next turn.

---

## How receiving works: replies arrive in a future turn

You **do not block waiting** for a peer's content reply. The model is
push-based:

1. You call `agent_send` → status `received`.
2. Your turn continues. You might do other work, or finish.
3. **Later** — possibly several turns later — the peer finishes its
   own turn, processes your message, and sends a reply.
4. The reply lands in your inbox as a normal envelope. You see it on
   your next turn input, with `re` set to the `id` you sent earlier.

You do not need a wait/poll/sleep. The Pi runtime delivers the reply as
a new turn input the moment it arrives.

### Concrete walk-through

You (name: `orq`) ask `backend` a question:

```
agent_send({ to: "backend", body: { q: "what's the JWT shape?" } })
→ { status: "received", target: "backend" }
```

You finish your current turn (maybe reply to the user, maybe do other
sends). Turn ends.

A few seconds later, the runtime hands you a new turn with this input:

```
[agent-network] message from "backend" (id=<new-id>, re=<your-id>):
{ "shape": { "sub": "string", "exp": "number", "roles": ["string"] } }
(This is a reply to a previous message of yours.)
```

You correlate by looking at `re` — it matches the `id` you got back
when you originally sent. Now you have your answer. Use it.

---

## How to REPLY when you receive a message

You receive:

```json
{
  "from": "orchestrator",
  "to": "backend",
  "id": "abc-uuid",
  "re": null,
  "body": { "task": "Implement POST /auth/login" }
}
```

When you have something to say back (an answer, an error, a status),
you send back another envelope **with `re` set to the original `id`**:

```
agent_send({
  to: "orchestrator",
  body: { status: "done", files_changed: [...] },
  re: "abc-uuid"
})
```

The orchestrator correlates the reply via `re === "abc-uuid"`. Without
`re`, they receive your message but cannot match it against the
question — and the coordination drifts. **Always echo `re` on a reply.**

---

## Asking multiple peers at once

You frequently need info from several agents before you can proceed.
You can fire multiple `agent_send` in the same turn — each returns its
own ACK status. Then your turn ends, and the replies arrive in future
turns as they come in.

```typescript
// In one turn:
agent_send({ to: "backend", body: { q: "JWT shape?" } });   // -> received
agent_send({ to: "frontend", body: { q: "theme tokens?" } }); // -> received
agent_send({ to: "infra",    body: { q: "ETA for Y?" } });    // -> busy — retry next turn
```

In a later turn, you might see two of the three replies; the third
might arrive a turn after that. Track which `id` corresponds to which
question (the ACK return shape includes `id`, store it).

Don't assume replies arrive in send order. Use `re` to identify what
each reply is for.

### When to retry

A `busy` peer might be free in a few seconds. The skill recommends:

- Try once → `busy` → wait ~2s, try again
- Still `busy` → wait ~5s, try again
- Still `busy` → abandon (report to human) or escalate to orchestrator

Retries are **your** responsibility as the sender. The broker does not
queue messages.

---

## Cross-PC addressing (`<pc_label>:<peer>`)

When the Owner has paired multiple Pis (e.g. "casa" and "trab"), peers
on the other machine appear in `list_peers` with a prefix:

```
{ peers: ["backend", "frontend", "casa:agent-1", "trab:worker"] }
```

To send to a remote peer, use the prefixed name verbatim:

```
agent_send({ to: "casa:agent-1", body: { ... } })
```

The transport (relay) routes it across the mesh; the cross-PC peer
receives it as if it were local. Behavior matches single-PC:
`received | busy | denied | timeout` semantics are identical.

When you **reply** to a cross-PC message, use the original sender's
`from` verbatim — it already carries the prefix:

```
Incoming: { from: "casa:sess-3", to: "agent-1", id: "abc", re: null, ... }
Reply:    agent_send({ to: "casa:sess-3", body: {...}, re: "abc" })
```

You do NOT prefix your own outgoing `from` — that rewrite happens at the
broker layer.

**Failure modes specific to cross-PC:**

- `denied`: remote PC's broker has no peer by that local name (peer left
  recently, or your cache is stale → call `list_peers` again)
- `timeout`: the other PC is offline or the relay is unreachable. The
  relay also synthesises a `transport_error` envelope (with `from:
  "_relay"`) for offline/not_authorized/bad_envelope — you'll see it in
  the inbox as a reply with `re=<your-send-id>` and `body.type:
  "transport_error"`. Treat exactly like timeout.

---

## Broadcast and multicast

`to: "broadcast"` delivers to every other peer. `to: ["a", "b"]`
delivers to the listed names.

- ✅ Announcements: "wave 2 started", "I'm taking the lock on /contracts"
- ❌ Questions: nobody knows who's supposed to answer — replies will be
  uncorrelated

Broadcast/multicast skip the ACK protocol entirely — the tool returns
`status: "sent"` immediately. You don't know who received it. If you
need delivery confirmation, use multiple unicast sends.

---

## Staying current: peer_joined / peer_left + `list_peers`

You may receive, at any time, `system` events from the broker:

```json
{ "from": "broker", "to": "backend", "id": "uuid", "re": null,
  "body": { "type": "peer_joined", "name": "frontend" } }
```

```json
{ "from": "broker", "to": "backend", "id": "uuid", "re": null,
  "body": { "type": "peer_left", "name": "frontend" } }
```

Use these to track who's online. Don't ask peers you know are offline.

If you missed events (just woke up, or your view feels stale), call
`list_peers` — it returns the authoritative snapshot in milliseconds.

Do **not** send a `list_peers` envelope to the broker via `agent_send`.
That's the old pre-tool pattern: it worked, but the reply arrived in a
future turn and the ACK status didn't carry the peer list. The dedicated
`list_peers` tool is strictly better — synchronous, typed return.

---

## Situations where you're in doubt

### "I received a task I don't understand"

Reply with `status: "error"` in the body, echoing the original `id` in
`re`. Don't go silent.

### "I received a message with `re` set, but I never sent that question"

Late reply to something that already wrapped up. Ignore. Don't reply
to a reply.

### "I'm in a session but no message ever arrives"

Normal. You only receive when someone addresses you. Keep working on
the current task. Don't poll the broker.

### "I sent something but got `timeout`"

The broker didn't ACK in 5s. Either the broker is restarting (failover)
or the peer disappeared between registration and delivery. Retry once
after ~10s; if still timeout, treat as transport failure and escalate.

### "The leader died (peer_left from `broker` for the leader)"

The transport layer automatically promotes another peer to leader. Your
client reconnects transparently in ~500ms. During that window,
`agent_send` may return `timeout` — retry once after a beat before
giving up.

---

## Legacy: `agent_request` is deprecated

You may see references to a tool called `agent_request` that takes a
target + body and **blocks the entire turn** waiting for the peer's
content reply. It still works, but emits a deprecation warning on use
and will be removed.

**Why deprecated:**

- Blocks your turn while a peer thinks → costs tokens and wall time
- No ACK signal — you can't tell `busy` from `pondering` from `gone`
- Pairs badly with parallel multi-peer questions

**Migration:** every `agent_request` call becomes an `agent_send`. The
reply arrives in a future turn (see the walk-through above). Treat the
inbox as your event loop, not your call stack.

---

## Single-page summary

1. **Discover first**: `list_peers()` returns `{peers: string[]}` —
   locals plus `<pc>:<peer>` cross-PC entries. Synchronous. Self-excluded.
2. **Send tool**: `agent_send({to, body, re?})`. Returns `{status, ...}`
   — always inspect.
3. **Unicast status**: `received | busy | denied | timeout`. Retry on
   `busy` with backoff; abandon on `denied`; investigate on `timeout`.
4. **Broadcast/multicast**: status is `sent`. Fire-and-forget.
5. **Replies**: come back **in a future turn** as a normal inbound
   envelope with `re=<your-send-id>`. Correlate by `re`.
6. When YOU reply to a peer, set `re` to their original `id`, and use
   their `from` verbatim as your `to` (including any `<pc>:` prefix).
7. You never receive your own messages. The broker filters.
8. The broker does not queue. If a peer is busy, your message is
   **dropped** — you own the retry.
9. `agent_request` is deprecated. Migrate to `agent_send` + inbox.

That's the whole protocol. Re-read it when in doubt.

---

## Mini-FAQ

**Q: Can I send a message to myself?**
A: No. `agent_send` refuses early with `status: "refused"` when `to`
matches your assigned name. The broker also drops unicast self-loops
as a second line of defense.

**Q: What if the peer never replies to my message?**
A: Then you never see a reply. There is no implicit timeout — your
own send returned `received` (the broker handed it over), the peer
just chose not to answer. If a reply is important, the agent-network
skill in the peer's process should make them reply. If they're a
non-Pi process that just listens, you live with the silence.

**Q: How many sends can I fire in one turn?**
A: No hard limit. But if you fire 10+ unicasts, question whether
you should be a worker instead of an orchestrator. Workers answer
narrow; orchestrators dispatch wide.

**Q: Is order preserved?**
A: Per-pair, yes — the broker is FIFO. Across pairs, replies arrive
whenever the senders finish. Don't assume reply order matches send
order.

**Q: Can `body` be binary?**
A: Not directly. Use base64 inside a string if you must. JSON is the
intended payload.

**Q: Can I disconnect any time?**
A: Yes. The transport sends `peer_left` automatically when you close.
Other agents see you go.

---

## See also

- [`plan/19-agent-network.md`](../plan/19-agent-network.md) — original protocol design
- [`plan/25-pc-mesh-bootstrap.md`](../plan/25-pc-mesh-bootstrap.md) — ACK protocol motivation + Wave 0 + cross-PC plans
- `~/.pi/remote/sessions/<name>/audit.jsonl` — append-only log of every
  envelope that passed through the broker, with `ack_status` per entry
  for cross-checking what really happened.
