/**
 * The mesh → inbox feed: inbound mesh envelopes land in the MeshInbox (the
 * model's pull/wait surface behind launch_pi_task / mesh_get_message /
 * mesh_list_messages / mesh_wait_message).
 *
 * The durable analog of the pi extension's `peer.onMessage` →
 * `_deliverMeshMessageToAgent` wiring (extension/src/commands/lifecycle.ts):
 * broker system events (peer_joined / peer_left) and broker control frames
 * are filtered, and every REAL agent-to-agent envelope is stored in the
 * inbox. Replies arrive here already correlation-stamped by the sender
 * (`env.re` = the outbound envelope id), so `launch_pi_task`'s
 * `inbox.wait({ re: ack.id })` resolves the moment the launched peer's reply
 * is delivered.
 *
 * Difference from the pi binding, by design: pi ALSO nudges the model (the
 * drain pushes the message via pi.sendMessage as a custom message). The
 * durable host has no push surface — the conversation is pull/wait only.
 * A message that arrives while the model is between turns sits in the inbox
 * until the model pulls it (mesh_list_messages) or a correlated wait
 * (launch_pi_task, mesh_wait_message) returns it.
 */
import type { MeshInbox, MeshNode } from "@geohar/un-bien/durable"

/**
 * Subscribe `meshNode`'s message delivery into `inbox`. Idempotent per
 * subscription (MeshNode.onMessage returns an unsubscribe the host never
 * needs — the node's close() drops it).
 */
export function wireMeshInbox(meshNode: MeshNode, inbox: MeshInbox): void {
  meshNode.onMessage((env) => {
    const body = env.body as { type?: string } | null
    // Broker system events: the roster self-heals — list_peers (the mesh
    // tool + the host's peer inventory) queries the broker live, so there
    // is no cached count to refresh on the durable host (the pi extension
    // refreshes a session peer-count badge here; we have no badge).
    if (body && (body.type === "peer_joined" || body.type === "peer_left"))
      return
    if (env.from === "broker") return // other broker control messages — ignore

    // Real agent-to-agent message: store for pull/wait. `deliveredAt`
    // stays null — the durable binding has no pi.sendMessage push, so
    // "delivered" means "in the inbox", which `sentAt` already records.
    inbox.add({
      id: env.id,
      from: env.from,
      to: meshNode.address(),
      body: env.body,
      re: env.re,
      sentAt: Date.now(),
      deliveredAt: null,
    })
  })
}