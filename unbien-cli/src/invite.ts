import { canonicalizeEd25519PublicKey } from "@geohar/un-bien/client"

/** A parsed `unbien://pair?t=…&epk=…&n=…&rm=…` invite from `/unbien pair`. */
export interface PairingInvite {
  /** Single-use pairing token — opaque, echoed verbatim in `pair_request`. */
  token: string
  /** Destination pi's Ed25519 public key; the outer envelope's routing `peer`. */
  epk: string
  sessionName?: string
  roomId: string
}

export function parseInvite(raw: string): PairingInvite {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(`not a pairing URI: ${raw}`)
  }
  if (url.protocol !== "unbien:" || url.host !== "pair") {
    throw new Error(`not a pairing URI: ${raw}`)
  }
  const token = url.searchParams.get("t")
  const epk = url.searchParams.get("epk")
  if (!token) throw new Error("pairing URI has no token (t)")
  if (!epk) throw new Error("pairing URI has no peer key (epk)")

  return {
    token,
    // The QR carries base64url; the relay routes by standard padded base64, so
    // canonicalize or every (peer, room) lookup misses.
    epk: canonicalizeEd25519PublicKey(epk) ?? epk,
    sessionName: url.searchParams.get("n") ?? undefined,
    roomId: url.searchParams.get("rm") ?? "main",
  }
}
