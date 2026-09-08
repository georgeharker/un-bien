#!/usr/bin/env node
/**
 * Replays a captured rpc-envelope fixture through the reducer and pi's
 * components — the look-and-feel prototype, with no transport and no session.
 */
import { readFileSync } from "node:fs"
import { reduce, toEnvelope, type EnvelopeMessage } from "./reduce.js"
import { renderTranscript } from "./render.js"
import { applyTheme, availableThemes } from "./theme.js"

function parseArgs(argv: readonly string[]) {
  const positional: string[] = []
  let theme: string | undefined
  let width: number | undefined
  let cwd: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--theme") theme = argv[++i]
    else if (argv[i] === "--width") width = Number(argv[++i])
    else if (argv[i] === "--cwd") cwd = argv[++i]
    else positional.push(argv[i]!)
  }
  return { file: positional[0], theme, width, cwd }
}

const { file, theme, width, cwd } = parseArgs(process.argv.slice(2))

// Listing themes must not require a fixture.
if (theme === "list") {
  console.log((await availableThemes()).join("\n"))
  process.exit(0)
}

if (!file) {
  console.error(
    "usage: unbien-cli replay <fixture.jsonl> [--theme <name>|list] [--width <cols>] [--cwd <path>]",
  )
  process.exit(1)
}

await applyTheme(theme)

const envelopes: EnvelopeMessage[] = []
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    continue
  }
  const env = toEnvelope(parsed)
  if (env) envelopes.push(env)
}

const cols = width ?? process.stdout.columns ?? 100
// Tool cards resolve paths against the SESSION's cwd, which is remote and has
// no relation to wherever this client happens to be running.
console.log(
  renderTranscript(reduce(envelopes), cols, cwd ?? process.cwd()).join("\n"),
)
