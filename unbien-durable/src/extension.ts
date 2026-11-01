/**
 * The un-bien durable extension: the host installs this into its pi-durable
 * registry alongside CodingTools. It carries the mesh tools (defined ONCE in
 * the harness-neutral core, adapted through DurableToolRegistrar) plus the
 * `launch_pi_task` tool (the launch-wait-quit meeting point).
 *
 * Deliberately NOT here (pi-only by design, flagged not-implemented on the
 * durable v1): slash commands, the ctx.ui/pi-ask bridge, panel mirrors,
 * model-registry rpc verbs. The durable conversation has no ctx.ui surface
 * and its tools ARE the model surface.
 */
import {
  defineExtension,
  section,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import {
  defineMeshTools,
  type HeadlessLaunchPort,
} from "@geohar/un-bien/core"
import type {
  MeshInbox,
  MeshNode,
  RelayClient,
  SessionPeer,
} from "@geohar/un-bien/durable"
import { DurableToolRegistrar } from "./registrar.js"
import { createLaunchWaitQuitTool } from "./launch_wait_quit.js"

export interface UnBienDurableDeps {
  /** The host's mesh node, once joined (null before). */
  getMeshNode(): MeshNode | null
  /** The host's inbound mesh inbox. */
  getInbox(): MeshInbox
  /** Federated peer addresses from the relay cache (discovery surface). */
  getRemoteRelayPeers(): string[]
  /** Federated peer detail (epk → relayName + addresses) for send routing. */
  getRemoteRelayPeersDetail(): Map<
    string,
    { relayName: string; addresses: string[] }
  >
  /** The relay WS (federated pi_envelope routing); null when down. */
  getRelay(): Pick<RelayClient, "send"> | null
  /** The headless pi launch port behind launch_pi_task. */
  launch: HeadlessLaunchPort
  /** The conversations' working directory. */
  cwd: string
}

export function createUnBienDurableExtension(
  deps: UnBienDurableDeps,
): Extension {
  const registrar = new DurableToolRegistrar()
  for (const def of defineMeshTools({
    getSessionPeer: (): SessionPeer | null =>
      deps.getMeshNode()?.peer() ?? null,
    getInbox: deps.getInbox,
    getRemoteRelayPeers: deps.getRemoteRelayPeers,
    getRemoteRelayPeersDetail: deps.getRemoteRelayPeersDetail,
    getRelay: deps.getRelay,
  }))
    registrar.registerTool(def)

  const tools: ToolRegistration[] = [
    ...registrar.registrations,
    createLaunchWaitQuitTool({
      launch: deps.launch,
      getMeshNode: deps.getMeshNode,
      getInbox: deps.getInbox,
    }),
  ]

  return defineExtension({
    name: "un-bien",
    tools,
    sections: [
      // The coding tools carry their own cwd section; this one names the
      // agent-network surface the model should reach for.
      section(
        "un-bien",
        () =>
          "You are on the un-bien agent mesh: agent_send / agent_request talk " +
          "to peer agents (list_peers for the roster), and launch_pi_task " +
          "brings up a short-lived headless pi coding agent for ad-hoc tasks.",
        { tag: true },
      ),
    ],
  })
}