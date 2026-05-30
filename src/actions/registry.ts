/**
 * Plan/28 — ModelRegistry instance shared by the action handlers.
 *
 * pi-extension creates its **own** `ModelRegistry` instance alongside the
 * one `AgentSession` instantiates internally. Both read the same on-disk
 * sources (`~/.pi/auth/*`, `~/.pi/models.json`), so they stay in sync —
 * we just call `refresh()` before each `list_models` request to capture
 * changes the user makes via `/login` or `/scoped-models` in the TUI.
 *
 * Why a fresh instance instead of accessing Pi's: the `ExtensionAPI`
 * surface does not expose `AgentSession`'s registry, and the public
 * factories (`ModelRegistry.create`, `AuthStorage.create`) are the
 * documented way for extensions to read the same catalog. No deep
 * imports, no internal-state coupling — see the probe note in
 * `plan/28-pi-commands.md` Wave 0.
 */

import { ModelRegistry, AuthStorage } from "@mariozechner/pi-coding-agent";

let _registry: ModelRegistry | null = null;

/**
 * Lazily instantiate the shared `ModelRegistry`. Subsequent calls return
 * the same instance — keep it cached so `refresh()` cycles are cheap and
 * the underlying `models.json` parse is amortized across requests.
 */
export function ensureModelRegistry(): ModelRegistry {
  if (!_registry) {
    _registry = ModelRegistry.create(AuthStorage.create());
  }
  return _registry;
}

/** Test seam — drop the cached registry so tests can rebuild with fakes. */
export function _resetModelRegistryForTests(): void {
  _registry = null;
}
