import { _enrichToolArgs } from "@geohar/un-bien/durable"

/**
 * The durable binding's rpc-envelope options: edit calls carry their diff
 * hunks (aux.hunks on tool_execution_start) as in a pi session, built from the
 * args and the file under `cwd`. The start frame can arrive after the edit
 * landed; the old text is then gone from the file and no hunks ride (the app
 * derives the diff from the args until the result's patch arrives).
 */
export function envelopeOptions(cwd: string) {
  return {
    enrichArgs: (tool: string, args: unknown) => {
      const e = _enrichToolArgs(tool, args, cwd) as { hunks?: unknown[] }
      return Array.isArray(e.hunks) ? { hunks: e.hunks } : null
    },
  }
}
