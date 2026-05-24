import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import keytar from "keytar";
import { generateEd25519Keypair, type Ed25519Keypair } from "./crypto.js";

const KEYCHAIN_SERVICE = "dev.remotepi.mac";
const PEERS_PATH = join(homedir(), ".pi", "remote", "peers.json");

// ── Keychain ──────────────────────────────────────────────────────────────────

async function loadKeypairFromKeychain(
  account: string,
): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array } | null> {
  const stored = await keytar.getPassword(KEYCHAIN_SERVICE, account);
  if (!stored) return null;
  const parsed = JSON.parse(stored) as { pk: string; sk: string };
  return {
    publicKey: Buffer.from(parsed.pk, "base64"),
    secretKey: Buffer.from(parsed.sk, "base64"),
  };
}

async function saveKeypairToKeychain(
  account: string,
  kp: { publicKey: Uint8Array; secretKey: Uint8Array },
): Promise<void> {
  const data = JSON.stringify({
    pk: Buffer.from(kp.publicKey).toString("base64"),
    sk: Buffer.from(kp.secretKey).toString("base64"),
  });
  await keytar.setPassword(KEYCHAIN_SERVICE, account, data);
}

export async function getOrCreateEd25519Keypair(): Promise<Ed25519Keypair> {
  const existing = await loadKeypairFromKeychain("longterm-ed25519");
  if (existing) return existing;
  const kp = generateEd25519Keypair();
  await saveKeypairToKeychain("longterm-ed25519", kp);
  return kp;
}

// ── peers.json ────────────────────────────────────────────────────────────────

export interface PeerRecord {
  name: string;
  remote_epk: string; // base64 standard, 32B Ed25519
  paired_at: string;  // ISO-8601
}

export async function listPeers(): Promise<PeerRecord[]> {
  try {
    const raw = await readFile(PEERS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { peers: PeerRecord[] };
    return parsed.peers ?? [];
  } catch {
    return [];
  }
}

export async function addPeer(record: PeerRecord): Promise<void> {
  const peers = await listPeers();
  const idx = peers.findIndex((p) => p.remote_epk === record.remote_epk);
  if (idx >= 0) {
    peers[idx] = record; // idempotent re-pair
  } else {
    peers.push(record);
  }
  await mkdir(dirname(PEERS_PATH), { recursive: true });
  await writeFile(PEERS_PATH, JSON.stringify({ peers }, null, 2));
}

/**
 * Returns the set of distinct `remote_epk` values in peers.json.
 *
 * In the current pairing model (plan/23 + plan/24), each `remote_epk` is the
 * Owner's Ed25519 pubkey — and we treat each as a distinct Owner the Pi has
 * been paired with. Used by the mesh self-revoke poller (plan/24 Wave 3) to
 * know which Owners' mesh blobs to fetch.
 */
export async function listOwnerPubkeys(): Promise<string[]> {
  const peers = await listPeers();
  const seen = new Set<string>();
  for (const p of peers) seen.add(p.remote_epk);
  return [...seen];
}

export async function removePeer(remoteEpk: string): Promise<boolean> {
  const peers = await listPeers();
  const filtered = peers.filter((p) => p.remote_epk !== remoteEpk);
  if (filtered.length === peers.length) return false;
  await mkdir(dirname(PEERS_PATH), { recursive: true });
  await writeFile(PEERS_PATH, JSON.stringify({ peers: filtered }, null, 2));
  return true;
}
