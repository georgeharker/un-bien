import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".pi", "remote");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const kDefaultRelayUrl = "https://relay-rp1.jacobmoura.work";

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
  if (env && env.length > 0) return { url: normalizeRelayUrl(env), source: "env" };
  const cfg = loadConfig();
  if (cfg.relay && cfg.relay.length > 0) return { url: normalizeRelayUrl(cfg.relay), source: "config" };
  return { url: normalizeRelayUrl(kDefaultRelayUrl), source: "default" };
}

/**
 * Accepts ws://, wss://, http://, https://. The http(s) variants are
 * normalized to ws(s) by `normalizeRelayUrl` since WebSocket and HTTP share
 * the same TLS layer and port — many reverse proxies (Coolify, Traefik,
 * Caddy, nginx-proxy) only expose the URL as https:// even though wss://
 * works on the same endpoint via the WebSocket upgrade header.
 */
export function isValidRelayUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (
    !lower.startsWith("ws://") &&
    !lower.startsWith("wss://") &&
    !lower.startsWith("http://") &&
    !lower.startsWith("https://")
  ) return false;
  try { new URL(url); return true; } catch { return false; }
}

/**
 * Rewrites http(s):// → ws(s):// so the user can paste whatever URL their
 * hosting provider gives them. Leaves ws(s):// untouched. Assumes the URL
 * passed `isValidRelayUrl` already.
 */
export function normalizeRelayUrl(url: string): string {
  if (url.toLowerCase().startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (url.toLowerCase().startsWith("http://"))  return "ws://"  + url.slice("http://".length);
  return url;
}
