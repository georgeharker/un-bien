/**
 * Harness-neutral core of un-bien: the port + event seam shared by the
 * pi-coding-agent extension binding and the pi-durable host binding.
 *
 * This module tree imports NO harness package — only typebox (tool schemas)
 * and the extension's own harness-neutral modules. Bindings live elsewhere:
 * pi_binding/ (pi-coding-agent) and the unbien-durable package (pi-durable).
 */

export type {
  AgentConfigPort,
  AgentSessionPort,
  CustomEntryInput,
  EntriesPage,
  EntryRange,
  HeadlessLaunchPort,
  HeadlessLaunchedSession,
  NotifyLevel,
  PortEntry,
  SessionControlPort,
  SubmitBlock,
  SubmitContent,
  SubmitDelivery,
  SubmitOptions,
  SubmitResult,
} from "./port.js"
export type { EventSource } from "./event_source.js"
export type { ThinkingLevel, WireModel } from "../protocol/types.js"
export {
  defineMeshTools,
  type MeshToolDef,
  type MeshToolDeps,
  type MeshToolOutcome,
  type ToolRegistrar,
} from "./tools.js"
