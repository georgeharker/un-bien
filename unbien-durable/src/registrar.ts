/**
 * Durable binding's ToolRegistrar: adapts harness-neutral MeshToolDefs to
 * pi-durable `defineTool` registrations (installed into the host's registry
 * inside an extension).
 *
 * Signature mapping: durable's execute is `(args, api, context)`; the neutral
 * def's is `(args, signal)`. Durable's ToolExecutionApi has no AbortSignal
 * surface (v1.4.0), so the wait tools run UNCANCELLABLE here — they stay
 * bounded by their own timeouts. The def's text content blocks and details
 * payload pass through verbatim; `promptSnippet` (pi's system-prompt line)
 * has no durable equivalent and is folded into the description as a trailing
 * usage hint.
 */
import type { JsonValue } from "@earendil-works/chord"
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import type { MeshToolDef } from "@geohar/un-bien/core"

export class DurableToolRegistrar {
  /** Registered so far — the host extension installs these in one bundle. */
  readonly registrations: ToolRegistration[] = []

  registerTool(def: MeshToolDef): void {
    this.registrations.push(
      defineTool({
        name: def.name,
        description: def.promptSnippet
          ? `${def.description}\n\nUsage: ${def.promptSnippet}`
          : def.description,
        parameters: def.parameters,
        // SAFETY: the neutral defs build TypeBox schemas compatible with
        // durable's validation; args arrive already validated, so the
        // `never` parameter is only the generic inference's narrow view.
        execute: async (args: never, _api, _context): Promise<ToolExecutionResult> => {
          const outcome = await def.execute(args, undefined)
          return {
            output: outcome.content,
            ...(outcome.details !== undefined
              ? // SAFETY: the mesh tools' details payloads are all JSON
                // trees (ACK results, MeshMessage records, rosters) — the
                // neutral def types them `unknown` only to stay
                // harness-neutral.
                { details: outcome.details as JsonValue }
              : {}),
          }
        },
      }),
    )
  }
}