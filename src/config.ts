import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".pi", "remote");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const kDefaultRelayUrl = "wss://relay-rp1.jacobmoura.work";

export type RemotePiConfig = { relay?: string };

export function loadConfig(): RemotePiConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as RemotePiConfig;
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<RemotePiConfig>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const current = loadConfig();
  const next = { ...current, ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
}

export type RelayResolution = { url: string; source: "env" | "config" | "default" };

/**
 * Resolves the effective relay URL. Precedence:
 *   1. process.env.REMOTE_PI_RELAY (escape hatch for ops/CI)
 *   2. ~/.pi/remote/config.json `relay` field (set via /remote-pi set-relay)
 *   3. kDefaultRelayUrl (production default)
 */
export function resolveRelayUrl(): RelayResolution {
  const env = process.env["REMOTE_PI_RELAY"];
  if (env && env.length > 0) return { url: env, source: "env" };
  const cfg = loadConfig();
  if (cfg.relay && cfg.relay.length > 0) return { url: cfg.relay, source: "config" };
  return { url: kDefaultRelayUrl, source: "default" };
}

export function isValidRelayUrl(url: string): boolean {
  if (!url || (!url.startsWith("ws://") && !url.startsWith("wss://"))) return false;
  try { new URL(url); return true; } catch { return false; }
}
