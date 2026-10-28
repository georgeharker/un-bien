/**
 * `launch_pi_task` — the durable binding's launch-wait-quit tool, and the
 * ONE place the two bindings meet at runtime.
 *
 * Contract (documented for the model in the description):
 *   1. fire up a headless pi-coding-agent session in the target cwd (a
 *      full interactive-equivalent pi: coding tools, its own model);
 *   2. it joins the un-bien UDS mesh under a scoped name minted per call;
 *   3. the task body is agent_sent to it as a MESH message — the launched
 *      session's own model handles it in its own turn and replies with
 *      `re=<send id>`;
 *   4. the reply lands in the host's mesh inbox and is returned as the
 *      tool result;
 *   5. the launched session is torn down in a finally — a failed task never
 *      leaks a live pi peer.
 *
 * Why mesh messages and not a direct prompt: the launched session is an
 * independent agent (its own harness, its own model config); the mesh
 * request/reply correlation gives both sides durable delivery semantics and
 * the same observability every other peer sees.
 */
import { Type } from "typebox"
import type { JsonValue } from "@earendil-works/chord"
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import type {
  HeadlessLaunchPort,
} from "@geohar/un-bien/core"
import type { MeshInbox } from "@geohar/un-bien/dist/session/mesh_inbox.js"
import type { MeshNode } from "@geohar/un-bien/dist/session/mesh_node.js"

/** How long to wait for the peer's correlated reply (default 5 min — the
 *  launched agent runs a full multi-turn task with tools). */
const DEFAULT_REPLY_TIMEOUT_MS = 300_000
/** Broker ACK deadline for the task delivery. */
const SEND_ACK_TIMEOUT_MS = 5_000

export interface LaunchWaitQuitDeps {
  /** The headless launch port (HeadlessPiLaunch). */
  launch: HeadlessLaunchPort
  /** The HOST's mesh node — the tool sends from the host's own peer. */
  getMeshNode(): MeshNode | null
  /** The host's inbound mesh inbox (correlated reply waits). */
  getInbox(): MeshInbox
}

export function createLaunchWaitQuitTool(
  deps: LaunchWaitQuitDeps,
): ToolRegistration {
  return defineTool({
    name: "launch_pi_task",
    description:
      "Launch a short-lived headless pi coding-agent session in a directory, " +
      "send it a task over the agent mesh, wait for its reply, then shut it " +
      "down. The launched session is a full pi agent (coding tools, its own " +
      "model) joined to the local UDS mesh under a per-call scoped name — " +
      "use it for ad-hoc coding firepower you don't want in your own " +
      "conversation. The task must be self-contained: the peer has no " +
      "access to this conversation's context. The target directory must " +
      "have un-bien configured (auto-start) and the un-bien extension " +
      "discoverable by pi there; a reply that never comes surfaces as a " +
      "timeout, not a silent success.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "The task to send the launched agent, as a self-contained " +
          "instruction (its reply comes back as this tool's result).",
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Directory to launch in. Default: this host's working directory.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description:
            "Max ms to wait for the reply (default 300000 = 5 minutes).",
        }),
      ),
    }),
    execute: async (args, _api, _context) => {
      const meshNode = deps.getMeshNode()
      if (!meshNode) {
        return {
          output: [
            {
              type: "text",
              text: "Not on the agent mesh — the host must join the mesh before launching pi tasks.",
            },
          ],
          isError: true,
        }
      }
      const cwd = args.cwd ?? process.cwd()
      const replyTimeout =
        typeof args.timeout_ms === "number" && args.timeout_ms > 0
          ? args.timeout_ms
          : DEFAULT_REPLY_TIMEOUT_MS
      // Scoped name: per-call unique, broker-safe (hyphens, no slashes —
      // the broker's name grammar rejects path separators).
      const name = `pi-task-${crypto.randomUUID().slice(0, 8)}`
      const peer = meshNode.peer()
      const session = await deps.launch.launchHeadless({ cwd, name })
      try {
        await session.joinMeshUnderName()
        const { address } = await session.awaitReady()
        const ack = await peer.sendWithAck(
          address,
          { type: "pi_task", task: args.task },
          null,
          SEND_ACK_TIMEOUT_MS,
        )
        if (ack.status !== "received") {
          return {
            output: [
              {
                type: "text",
                text: `Task delivery to "${address}" failed (${ack.status}${
                  ack.error ? `: ${ack.error}` : ""
                }). The session was shut down.`,
              },
            ],
            isError: true,
          }
        }
        const reply = await deps
          .getInbox()
          .wait({ re: ack.id }, replyTimeout, { interruptOnUnmatched: true })
        if (!reply) {
          return {
            output: [
              {
                type: "text",
                text:
                  `No reply within ${replyTimeout}ms (send id ${ack.id}). ` +
                  `The session was shut down; if the reply arrives later it ` +
                  `lands in this host's mesh inbox.`,
              },
            ],
          }
        }
        if (reply.re !== ack.id) {
          // Early interrupt — an uncorrelated message arrived while waiting.
          return {
            output: [
              {
                type: "text",
                text:
                  `Early interrupt while awaiting the task reply: ${reply.from} ` +
                  `sent ${reply.id} (re=${reply.re}). Handle it, then re-issue ` +
                  `launch_pi_task. The launched session was shut down.`,
              },
            ],
          }
        }
        const text =
          typeof reply.body === "string"
            ? reply.body
            : JSON.stringify(reply.body)
        // SAFETY: a mesh reply body is a JSON tree by wire contract (the
        // envelope codec only carries JSON); the inbox types it `unknown`
        // only to stay harness-neutral.
        return {
          output: [{ type: "text", text }],
          details: reply.body as JsonValue,
        }
      } finally {
        await session.tearDown()
      }
    },
  })
}