---
name: agent-network
description: Use when the remote-pi mesh tools (`list_peers`, `agent_send`, `get_messages`) are available — you are a Claude agent connected to the remote-pi agent mesh over a local broker. This skill teaches how to discover who's online (`list_peers`), how to send messages with delivery status (`agent_send` + ACK), how incoming messages arrive (`get_messages` at the start of each turn, plus channel push), how to reply (echo `re`), and how cross-PC addressing works (`<pc_label>:<peer>`).
---

# Agent Network (Claude ↔ remote-pi mesh)

You are connected to the **remote-pi agent mesh** through an MCP server.
Other agents — other Claude sessions, Pi coding agents on this machine, and
agents on the Owner's other PCs (via the relay) — can send you messages, and
you can send messages to them.

Read this to the end before acting. The protocol is **event-driven**, not
request/reply. Getting the receive model wrong leaves coordination broken.

You have exactly three tools: `list_peers`, `agent_send`, `get_messages`.

---

## The most important rule: check your inbox every turn

Incoming messages are buffered for you. **At the start of every turn, call
`get_messages`** to drain and read anything other agents sent you:

```
get_messages()
→ "[2026-05-30T12:00:01Z] from=backend re=<your-id>
   id=<msg-id>
   { "shape": { "sub": "string", "exp": "number" } }"
```

- Returns all pending messages and clears the buffer (call once per turn).
- Returns `(no messages)` when nothing is waiting — that's normal, keep working.
- A channel push may also surface a message mid-session (a `📨 Message from …`
  notification). When it does, still call `get_messages` to get the full,
  structured payload (`from`, `id`, `re`, `body`) — the push is just a nudge.

**If a message arrived, someone wanted your attention. Don't ignore it.**
You only ever receive messages addressed to you — the broker filters before
delivery.

---

## First thing in a new session: `list_peers`

Before sending anything, find out who's actually online:

```
list_peers()
→ backend
  frontend
  casa:agent-1
  trab:worker
```

Synchronous (resolves in milliseconds — not another agent's turn). Use it:

- At the start of a session, to see what mesh you're in
- Before any `agent_send` whose target name is uncertain
- After a while, to refresh (peers join/leave over time)

**Entry shape:**
- `backend` → local peer (this machine, same broker)
- `casa:agent-1` → cross-PC peer on the PC labeled `casa` (the Owner's other
  machine, reached through the relay)

You are excluded from the result — no need to filter yourself out.

---

## Anatomy of a message (envelope)

`get_messages` shows you, per message: `from`, `id`, `re`, and `body`.

| Field | Meaning |
|---|---|
| `from` | Who sent it. Use this verbatim as your `to` when replying. |
| `id` | Unique id of this message. Echo it as `re` when you reply. |
| `re` | If set, this message is itself a REPLY to an earlier `id` of yours. |
| `body` | Free-form content — string or JSON, sender's choice. |

---

## Sending: `agent_send` returns an ACK status

`agent_send({ to, body, re? })` is how you talk to peers. Every **unicast**
call returns a status telling you what happened at the recipient. **Always
inspect the status — it dictates what to do next.**

| Status | Means | What you do |
|---|---|---|
| `received` | Peer was idle; broker delivered the envelope; peer will process it on its next turn. | Move on. Any reply arrives later — check `get_messages` on future turns. |
| `busy` | Peer is mid-turn — envelope **dropped**. | Retry 2× with backoff (~2s, ~5s). Still busy → abandon or escalate. You own the retry. |
| `denied` | Peer explicitly refused. | Do NOT retry. Report to the user. |
| `timeout` | No ACK (~5s). Transport error — broker down, or peer vanished. | Treat as transient. Retry once after ~10s, then escalate. |

For `to: "broadcast"`, there's no single ACK — it's fire-and-forget
("Broadcast sent").

**Replies bypass the busy gate.** A message with `re=<some-id>` (an answer to
something the recipient asked) is always delivered — it resolves their pending
state instead of starting a new turn. So if you fan out questions to several
peers, every reply reaches you even while they're busy.

---

## Receiving: replies arrive on a later turn

You **do not block** waiting for a reply. The model is event-driven:

1. You call `agent_send` → status `received`.
2. Your turn continues / ends.
3. **Later** the peer finishes its own work and sends a reply.
4. The reply lands in your inbox. You see it the next time you call
   `get_messages`, with `re` set to the `id` you originally sent.

No wait/sleep/poll-loop. Just call `get_messages` at the start of your turns.

### Walk-through

```
agent_send({ to: "backend", body: { q: "what's the JWT shape?" } })
→ Delivered to backend        # status received; remember the message id
```

Your turn continues. A turn or two later:

```
get_messages()
→ "[…] from=backend re=<your-id>
   id=<new-id>
   { "shape": { "sub": "string", "exp": "number", "roles": ["string"] } }"
```

You correlate by `re` — it matches the send you made. Now you have your answer.

---

## Replying to a message

When you receive (via `get_messages`):

```
from=orchestrator  id=abc-uuid  re=(none)
{ "task": "Implement POST /auth/login" }
```

Reply with `re` set to that `id`, and `to` set to the sender's `from`:

```
agent_send({
  to: "orchestrator",
  body: { status: "done", files_changed: [...] },
  re: "abc-uuid"
})
```

Without `re`, the sender gets your message but can't match it to the
question — coordination drifts. **Always echo `re` on a reply.**

---

## Asking multiple peers at once

Fire multiple `agent_send` in one turn — each returns its own ACK. Replies
arrive on future turns as peers finish.

```
agent_send({ to: "backend",  body: { q: "JWT shape?" } })   // received
agent_send({ to: "frontend", body: { q: "theme tokens?" } }) // received
agent_send({ to: "infra",    body: { q: "ETA for Y?" } })    // busy — retry
```

Track which `id` maps to which question. Don't assume replies arrive in send
order — use `re` to identify what each reply answers.

---

## Cross-PC addressing (`<pc_label>:<peer>`)

When the Owner has paired multiple PCs, remote peers appear with a prefix:

```
list_peers() → backend  frontend  casa:agent-1  trab:worker
```

Send to a remote peer with the prefixed name verbatim:

```
agent_send({ to: "casa:agent-1", body: { ... } })
```

The relay routes it across the mesh; `received | busy | denied | timeout`
semantics are identical to local. When you **reply** to a cross-PC message,
use the sender's `from` verbatim (it already carries the prefix) as your `to`.
You never prefix your own name — the broker handles that.

Cross-PC failure notes:
- `denied` → the remote broker has no peer by that name (left, or stale cache
  → call `list_peers` again).
- `timeout` → the other PC is offline or the relay is unreachable.

---

## Broadcast and multicast

- `to: "broadcast"` → every other peer. Use for announcements
  ("wave 2 started"), never for questions (replies would be uncorrelated).
- Broadcast skips ACK — you don't know who received it. For delivery
  confirmation, use individual unicast sends.

---

## When in doubt

- **Received a task you don't understand** → reply with `body.status:"error"`,
  echoing the original `id` in `re`. Don't go silent.
- **Received a `re` you never sent** → late reply to something already wrapped
  up. Ignore. Don't reply to a reply.
- **No messages ever arrive** → normal. You only receive when addressed. Keep
  working; just keep calling `get_messages` each turn.
- **`timeout` on send** → broker restarting (failover) or peer vanished. Retry
  once after ~10s, then escalate.

---

## Single-page summary

1. **Every turn**: `get_messages()` first — drain your inbox.
2. **Discover**: `list_peers()` → locals + `<pc>:<peer>` cross-PC. Synchronous.
3. **Send**: `agent_send({to, body, re?})` → inspect the status.
4. **Unicast status**: `received | busy | denied | timeout`. Retry on `busy`
   (backoff); abandon on `denied`; investigate on `timeout`.
5. **Broadcast**: fire-and-forget, no ACK.
6. **Reply**: set `re` to their `id`, `to` to their `from` (prefix and all).
7. You never receive your own messages. The broker does not queue — if a peer
   is busy, your message is dropped; you own the retry.

Re-read when in doubt.
