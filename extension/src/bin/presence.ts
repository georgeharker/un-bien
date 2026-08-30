#!/usr/bin/env node
/**
 * `pi-unbien-presence` — the regime-2 machine-presence daemon.
 *
 * A lightweight mesh peer (NOT a pi session) that lets a paired app launch a
 * session on THIS machine even when no pi is running here. Reads the machine's
 * un-bien config for identity + relay + launch backend, joins the machine-level
 * control room, advertises `remote_launch`, and spawns tmux/herdr on request.
 *
 * Run by hand during bring-up:
 *   pnpm build && node dist/bin/presence.js
 * (An OS-service unit for keepalive is a separate install step.)
 */
import { startPresence } from "../presence/presence.js";

async function main(): Promise<void> {
  const handle = await startPresence();
  // eslint-disable-next-line no-console
  console.log(
    `[un-bien presence] listening on control room ${handle.roomId} ` +
      `(epk ${handle.epk.slice(0, 16)}…) — Ctrl-C to stop`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[un-bien presence] ${signal} — shutting down`);
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    `[un-bien presence] fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
