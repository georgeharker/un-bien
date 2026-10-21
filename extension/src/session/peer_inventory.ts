/**
 * Plan/25 Wave D — pure formatter for the `/unbien peers` output.
 *
 * Lives in its own module so it can be unit-tested without booting the full
 * extension (no keychain access, no relay client, no mocks needed). The
 * extension imports the function and wraps it with the `_sessionPeer`
 * `list_peers` request.
 *
 * Input shape: the broker's `list_peers_reply` body returns peer names as
 * plain strings — local peers without a prefix (`sess-1`, `agent-2`),
 * cross-PC peers with a `<pc_label>:<peer>` prefix (`casa:sess-3`).
 */

export function formatPeerInventory(
  peers: string[],
  selfName?: string,
): string {
  const locals: string[] = []
  const remotes = new Map<string, string[]>()
  for (const p of peers) {
    if (selfName && p === selfName) continue
    const idx = p.indexOf(":")
    if (idx > 0 && idx < p.length - 1) {
      const label = p.slice(0, idx)
      const name = p.slice(idx + 1)
      const bucket = remotes.get(label) ?? []
      bucket.push(name)
      remotes.set(label, bucket)
    } else {
      locals.push(p)
    }
  }
  const lines: string[] = ["  local:"]
  if (locals.length === 0) {
    lines.push("    (none)")
  } else {
    for (const n of locals.sort()) lines.push(`    ${n}`)
  }
  const sortedLabels = [...remotes.keys()].sort()
  for (const label of sortedLabels) {
    lines.push("")
    lines.push(`  remote:${label}`)
    for (const n of (remotes.get(label) ?? []).sort()) lines.push(`    ${n}`)
  }
  return lines.join("\n")
}

/** Structured roster entry — mirrors the broker's `peers_detailed` (plan/38).
 *  `cwd` is empty for peers that registered before (cwd, name) addressing:
 *  they render in their own "not reported" group. */
export interface RosterInfo {
  cwd: string
  name: string
  address: string
}

/** The PC label of a roster address: remote peers are `<pc>:<cwd>@<name>`;
 *  the label is receiver-local and the raw separator is the FIRST `:` (any
 *  `:` bytes inside labels are percent-encoded as `%3A`, never literal). */
function pcLabelOf(address: string): string | null {
  const i = address.indexOf(":")
  return i > 0 && i < address.length - 1 ? address.slice(0, i) : null
}

/**
 * The mesh roster grouped by working directory: one header per (PC, cwd),
 * full addresses VERBATIM under each (they are routing keys — never rebuilt).
 * Groups: local first, then remote PC labels alphabetically; within each,
 * cwds alphabetically with "cwd not reported" (legacy peers) last.
 *
 * `selfAddress` is excluded — the caller is the only peer that can't address
 * itself, so listing it is noise (matches list_peers's filter).
 */
export function formatPeerInventoryDetailed(
  infos: RosterInfo[],
  opts: { selfAddress?: string } = {},
): string {
  const locals = new Map<string, string[]>()
  const remotes = new Map<string, Map<string, string[]>>()
  for (const info of infos) {
    if (opts.selfAddress && info.address === opts.selfAddress) continue
    const pc = pcLabelOf(info.address)
    if (pc === null) {
      const bucket = locals.get(info.cwd) ?? []
      bucket.push(info.address)
      locals.set(info.cwd, bucket)
    } else {
      const byCwd = remotes.get(pc) ?? new Map<string, string[]>()
      const bucket = byCwd.get(info.cwd) ?? []
      bucket.push(info.address)
      byCwd.set(info.cwd, bucket)
      remotes.set(pc, byCwd)
    }
  }

  const cwdGroupOrder = (byCwd: Map<string, string[]>): string[] => {
    const reported = [...byCwd.keys()].filter((c) => c !== "").sort()
    const unreported = byCwd.has("") ? [""] : []
    return [...reported, ...unreported] // legacy "not reported" last
  }

  const lines: string[] = []
  const heading = (cwd: string): string =>
    cwd === "" ? "cwd not reported" : cwd
  for (const cwd of cwdGroupOrder(locals)) {
    lines.push(`  local — ${heading(cwd)}`)
    for (const addr of (locals.get(cwd) ?? []).sort()) {
      lines.push(`    ${addr}`)
    }
  }
  for (const label of [...remotes.keys()].sort()) {
    const byCwd = remotes.get(label)!
    for (const cwd of cwdGroupOrder(byCwd)) {
      lines.push(`  remote:${label} — ${heading(cwd)}`)
      for (const addr of (byCwd.get(cwd) ?? []).sort()) {
        lines.push(`    ${addr}`)
      }
    }
  }
  if (lines.length === 0) return "(no peers)"
  return lines.join("\n")
}
