/**
 * Pi binding's ToolRegistrar: adapts harness-neutral MeshToolDefs to
 * pi-coding-agent's `pi.registerTool`.
 *
 * The pi execute signature is `(toolCallId, params, signal)`; the neutral
 * def's is `(args, signal)` — the registrar drops the call id and passes the
 * cancellation signal through unchanged. Tool surface, schemas, descriptions,
 * and prompt snippets are passed through verbatim, so registration through
 * this registrar is byte-identical to the pre-core inline registrations.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { MeshToolDef, ToolRegistrar } from "../core/tools.js"

export class PiToolRegistrar implements ToolRegistrar {
  constructor(
    private readonly pi: ExtensionAPI,
  ) {}

  registerTool(def: MeshToolDef): void {
    // SAFETY: the neutral def carries the pi-compatible subset of
    // ToolDefinition's fields; registerTool infers its generics from
    // `parameters` (TObject) and the execute return (details: unknown).
    this.pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      ...(def.promptSnippet !== undefined
        ? { promptSnippet: def.promptSnippet }
        : {}),
      parameters: def.parameters,
      execute: async (_toolCallId, params, signal) => {
        const outcome = await def.execute(params, signal)
        // pi's AgentToolResult requires the `details` key (value may be
        // undefined); every mesh tool already returns a details payload.
        return { content: outcome.content, details: outcome.details }
      },
    })
  }
}