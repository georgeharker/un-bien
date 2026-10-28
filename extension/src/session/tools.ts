/**
 * Mesh tool registration for the pi binding.
 *
 * The seven tool DEFINITIONS live once in core/tools.ts (harness-neutral);
 * this module registers them on a pi session through PiToolRegistrar. The
 * pi-facing surface (names, schemas, descriptions, prompt snippets, ACK
 * semantics, outcome text) is byte-identical to the pre-core inline
 * registrations.
 *
 *   - `agent_send`     — unified delivery with broker-level ACK. Returns
 *                        a status so the LLM can decide whether to retry.
 *                        For unicast targets the broker auto-replies with
 *                        `received | busy | denied`. For broadcast/multicast
 *                        the tool is fire-and-forget (status `sent`).
 *   - `agent_request`  — send + block until the correlated reply lands in
 *                        the inbox. Reliability comes from the inbox, not
 *                        from `SessionPeer.request`: denial is reported
 *                        before blocking, a late reply is kept (not
 *                        dropped), the user can cancel mid-wait, and a
 *                        peer's fresh request early-interrupts the wait
 *                        (mutual-wait deadlock break).
 *   - `list_peers` / `whoami` — roster + self-identity queries.
 *   - `mesh_get_message` / `mesh_list_messages` / `mesh_wait_message` —
 *                        the inbound inbox pull/wait surface.
 *
 * `getSessionPeer` and friends are getters (not captured values) so changes
 * to the host's mesh state are observed live at each tool call.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { defineMeshTools } from "../core/tools.js"
import { PiToolRegistrar } from "../pi_binding/tool_registrar.js"
import type { SessionPeer } from "./peer.js"
import type { MeshInbox } from "./mesh_inbox.js"

export function registerAgentTools(
  pi: ExtensionAPI,
  getSessionPeer: () => SessionPeer | null,
  getInbox: () => MeshInbox,
  getRemoteRelayPeers: () => string[] = () => [],
  getRemoteRelayPeersDetail: () => Map<
    string,
    { relayName: string; addresses: string[] }
  > = () => new Map(),
  getRelay: () => { send: (data: string) => void } | null = () => null,
): void {
  const defs = defineMeshTools({
    getSessionPeer,
    getInbox,
    getRemoteRelayPeers,
    getRemoteRelayPeersDetail,
    getRelay,
  })
  const registrar = new PiToolRegistrar(pi)
  for (const def of defs) registrar.registerTool(def)
}