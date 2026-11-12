import { _enrichToolArgs } from "@geohar/un-bien/durable"

/**
 * The durable binding's rpc-envelope options: edit calls carry their diff
 * hunks (aux.hunks on tool_execution_start) as in a pi session, built from the
 * args and the file under `cwd`. A start the translator emits from the tool's
 * RESULT (no live slot was seen: `afterExecution`) comes after the edit
 * landed, when the file no longer holds the old text in place; it carries no
 * hunks, and the app shows the args diff until the result's patch, which
 * arrives in the same batch.
 */
export function envelopeOptions(cwd: string) {
  return {
    enrichArgs: (tool: string, args: unknown, payload: Record<string, unknown>) => {
      if (payload.afterExecution === true) return null
      const e = _enrichToolArgs(tool, args, cwd) as { hunks?: unknown[] }
      return Array.isArray(e.hunks) ? { hunks: e.hunks } : null
    },
  }
}
