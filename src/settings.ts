import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".pi", "remote", "settings.json");

export const DEFAULT_RELAY_URL = "ws://localhost:3000";

export interface Settings {
  relay_url?: string;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Settings;
  } catch {
    return {};
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/** Returns saved relay URL, env override, or default. */
export async function getRelayUrl(): Promise<string> {
  const settings = await loadSettings();
  if (settings.relay_url) return settings.relay_url;
  const env = process.env["REMOTE_PI_RELAY"];
  if (env) return env;
  return DEFAULT_RELAY_URL;
}

export async function setRelayUrl(url: string): Promise<void> {
  const settings = await loadSettings();
  settings.relay_url = url;
  await saveSettings(settings);
}

export function validateRelayUrl(url: string): { ok: true } | { ok: false; reason: string } {
  if (!url) return { ok: false, reason: "URL is empty" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "malformed URL" };
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return { ok: false, reason: `expected ws:// or wss://, got ${parsed.protocol}` };
  }
  return { ok: true };
}
