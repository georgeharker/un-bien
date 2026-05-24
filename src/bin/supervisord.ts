#!/usr/bin/env node
/**
 * `pi-supervisord` — long-running daemon supervisor.
 *
 * Entry point of the `pi-supervisord` binary (plan/26 W2). Run by
 * systemd/launchd in production, or directly during dev:
 *
 *   pnpm build
 *   node dist/bin/supervisord.js
 *
 * Once running, it:
 *   - Reads `~/.pi/remote/daemons.json`
 *   - Spawns `pi --mode rpc -e <remote-pi/dist/index.js>` per entry
 *   - Listens on `~/.pi/remote/supervisor.sock` for CLI control requests
 *   - Restarts crashed children with exponential backoff
 *
 * Exits cleanly on SIGTERM/SIGINT (used by `remote-pi uninstall`).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Supervisor } from "../daemon/supervisor.js";

async function main(): Promise<void> {
  // The supervisor needs to point each spawned Pi at the extension
  // entry it's bundled with. We're at `dist/bin/supervisord.js` after
  // build; the extension is the sibling `dist/index.js`.
  const here = fileURLToPath(import.meta.url);
  const distRoot = dirname(dirname(here));  // dist/bin → dist
  const extensionPath = join(distRoot, "index.js");

  const supervisor = new Supervisor({ extensionPath });
  await supervisor.start();
  process.stderr.write(
    `[pi-supervisord] up — UDS: ~/.pi/remote/supervisor.sock, extension: ${extensionPath}\n`,
  );

  const shutdown = async (signal: string) => {
    process.stderr.write(`[pi-supervisord] received ${signal}, shutting down\n`);
    await supervisor.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`[pi-supervisord] fatal: ${String(err)}\n`);
  process.exit(1);
});
