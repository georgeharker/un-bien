# Machine identity

Every Pi (extension) has one long-term **Ed25519 identity** — a 32-byte seed. Its
**public key (epk)** is what devices pair against and what the relay routes on.
The relay **only ever sees the public key** (routing + a per-connection
challenge signature); the seed never leaves the machine.

Because pairings are keyed on the epk, **pairing durability == seed durability**:
if the seed changes, the epk changes, and every paired device is orphaned. The
resolver's one job is to never let that happen silently.

> This is the **machine** identity (the extension). It is distinct from the phone-side
> **Owner** key, which lives in the iOS data-protection keychain and is unrelated.

## Storage backends

The seed lives in one **selected backend**, configured in `un-bien.json`
(`<PI_CODING_AGENT_DIR>/extensions/un-bien.json`, or `~/.pi/extensions/…`):

```jsonc
{
  "identity": {
    "storage": "keychain",   // "keychain" (default) | "file"
    "path": "~/.local/state/un-bien/identity.json"  // file backend only; this is the default
  }
}
```

| Backend | Where | Notes |
| --- | --- | --- |
| **`keychain`** (default) | OS keyring (`@napi-rs/keyring`: macOS Keychain, Windows Credential Manager, Linux libsecret) | Secure; the seed is not a plain file. Extract it via the OS store, not `cat`. |
| **`file`** | a `0600` seed file at `identity.path` | The **SSH-private-key model** (`~/.ssh/id_ed25519` is exactly this): `cat`-able, portable, works headless. Plaintext on disk — acceptable for a self-hosted dev tool, same posture as an SSH key. |

On a host with no usable keyring (headless Linux, a Bun-built `pi`), the file
backend is used automatically regardless of config.

## Resolution order

1. **`UNBIEN_IDENTITY_SEED`** env override — read-only, always wins.
2. **Selected backend** (keychain retried on a lock; file read strictly).
3. **Migration read-in-place of the other backend** — recovers an existing
   identity (e.g. a keychain key when you switch to the file backend) *without*
   writing it through.
4. **Mint + persist to the selected backend — only on a genuine first run**
   (nothing found in any source).

**Never mint over an existing or unreadable identity.** A locked keychain, an
unreadable/corrupt file, or existing entries in `peers.json` all cause the
resolver to **fail loud** rather than generate a new key:

- `KeyringUnavailableError` — keychain is locked/denied on macOS/Windows. Unlock
  it and retry; your pairing is **not** lost.
- `FileIdentityUnreadableError` — the identity file exists but is corrupt or
  permission-denied. Fix it; never delete-and-regenerate.
- `PairedIdentityMissingError` — no identity resolved but `peers.json` lists
  paired devices (classically a `systemd --user` daemon that can't reach the
  desktop keyring). Give the service keyring access, or supply the seed (below).

## Inspecting: `/unbien identity`

```
/unbien identity          # or: /unbien identity show
```

Reports **non-secret** state only — the active **EPK** (public), the active
**backend**, and which **source** resolved it. Use it to confirm you're on the
expected identity (e.g. after moving machines).

> ⚠️ It **never** prints the seed. Command output is visible to the assistant
> (it lands in the transcript), so the private seed is deliberately never routed
> through the agent. Extract it yourself, out of band (below).

## Extracting the seed

- **File backend:** `cat <identity.path>` (default `~/.local/state/un-bien/identity.json`).
  The file is the `{ "pk": …, "sk": … }` JSON — that *is* the seed material.
- **Keychain backend:** read it from the OS keyring (Keychain Access on macOS,
  etc.). The agent does not extract keychain secrets.

## Supplying / backing up / moving an identity

To make an identity **portable** — e.g. to preserve pairings on a new machine:

1. Put it in a file: set `"identity": { "storage": "file" }` (or it already is).
2. Back it up / move it: copy the `0600` file to the target, or paste its
   contents into `UNBIEN_IDENTITY_SEED` there.

**`UNBIEN_IDENTITY_SEED`** (read-only override) accepts either:

- the identity JSON `{ "pk": …, "sk": … }` (i.e. `cat` of the file), or
- a bare **base64 32-byte seed**.

The agent never writes this variable — **you** populate it, and it wins over
both backends when set.

### Security caveat

A raw seed in an environment variable can leak (via `ps`, `/proc`, shell
history, crash dumps). Prefer a **`0600` file**; the **keychain is the secure
default**. Treat a file-backend seed exactly like an SSH private key.

## Notes

- `UNBIEN_ALLOW_FILE_IDENTITY` is **removed**. To run a file identity on a
  headless host, set `"identity": { "storage": "file" }` instead.
- Switching backends does not automatically move the seed — the other backend is
  only *read* to recover an existing key, never written to. Move it explicitly
  (copy the file / set the env override).
