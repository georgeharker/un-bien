#!/usr/bin/env node
/** `unbien pair-token` — machine-side pairing invite generator.
 *
 * The OTHER half of pairing: `unbien pair <uri>` consumes an invite from
 * the owner's CLI (pairs it as a phone with a machine). This GENERATES
 * the invite from the machine side, so a headless host — the durable
 * host, a GCE VM, any pi box without a TUI — can start pairing by
 * printing a QR / URI for the app to scan or paste.
 *
 * Uses the MACHINE identity (identity.json in $UNBIEN_STATE_DIR or
 * ~/.local/state/un-bien, via getOrCreateEd25519Keypair) — NOT the
 * CLI's owner identity (proxy-identity.json). The CLI running inside
 * a container must generate the invite for the MACHINE it's on, so
 * the app's pair_request routes to the right room.
 *
 * Usage:
 *   unbien pair-token [--name <session-name>] [--room <room-id>]
 *                    [--state-dir <dir>]
 *
 * Output: QR ASCII to stderr (for a terminal), plain unbien://pair URI
 * to stdout (for copy-paste / piping). The token is rotating (60s TTL
 * per issueToken) — for pair-on-startup, re-run the command when the
 * user is ready to pair; for once-off docker-exec, a single token is
 * fine (scan within 60s, or re-run to re-mint).
 */
import {
  QRSession,
  buildQRUri,
  renderQRAscii,
  getOrCreateEd25519Keypair,
} from "@geohar/un-bien"

const args = process.argv.slice(2)
let sessionName = "durable"
let roomId = "main"
let stateDir = ""

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg === "--name" || arg === "-n") {
    sessionName = args[++i] ?? sessionName
  } else if (arg === "--room" || arg === "-r") {
    roomId = args[++i] ?? roomId
  } else if (arg === "--state-dir" || arg === "-s") {
    stateDir = args[++i] ?? ""
  } else if (arg === "--help" || arg === "-h") {
    console.log(
      "usage: unbien pair-token [--name <session-name>] [--room <room-id>] [--state-dir <dir>]\n" +
        "\n" +
        "  Generates a pairing invite (QR + unbien://pair URI) for THIS machine.\n" +
        "  The app scans the QR or the URI is pasted into the app's pair flow.\n" +
        "\n" +
        "  --name, -n         session name shown in the app's pair preview (default: durable)\n" +
        "  --room, -r         pi room id the pair_request routes to (default: main).\n" +
        "                     MUST match the room the target pi session announces;\n" +
        "                     the app routes pair_request to this room.\n" +
        "  --state-dir, -s    where identity.json lives (default: $UNBIEN_STATE_DIR\n" +
        "                     or ~/.local/state/un-bien).\n" +
        "\n" +
        "  The token rotates (60s TTL). For pair-on-startup, re-run this command\n" +
        "  each time a pair is wanted; the URI is also printed for copy-paste.\n" +
        "  Works for any headless machine, not just the durable host.\n",
    )
    process.exit(0)
  }
}

// The storage module resolves the state dir from the env var at call
// time (verified: _identityFilePath reads UNBIEN_STATE_DIR lazily), so
// set it BEFORE getOrCreateEd25519Keypair(). A --state-dir overrides
// the ambient env for containerized runs (docker -e or the flag).
if (stateDir) {
  process.env.UNBIEN_STATE_DIR = stateDir
}

const kp = await getOrCreateEd25519Keypair()
const qrSession = new QRSession()
const { token } = qrSession.issueToken()
const uri = buildQRUri(token, kp.publicKey, sessionName, roomId)

// QR to stderr (terminal display), URI to stdout (copy-paste / pipe).
process.stderr.write(`\n${renderQRAscii(uri)}\n\nScan with the app, or paste this URI:\n\n`)
console.log(uri)