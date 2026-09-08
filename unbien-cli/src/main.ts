#!/usr/bin/env node
/** Single front door: `unbien-cli <command>`. */

const COMMANDS = new Map([
  ["connect", () => import("./connect.js")],
  ["replay", () => import("./replay.js")],
])

const [command] = process.argv.slice(2)
const load = command ? COMMANDS.get(command) : undefined

if (!load) {
  console.error(
    "usage: unbien-cli <command> [options]\n\n" +
      "  connect   attach to a live pi session over the relay\n" +
      "  replay    render a captured envelope stream from a file\n\n" +
      "run `unbien-cli <command>` with no arguments for its options.",
  )
  process.exit(command ? 1 : 0)
}

// The subcommands parse `process.argv.slice(2)` themselves, so drop the verb.
process.argv.splice(2, 1)
await load()
