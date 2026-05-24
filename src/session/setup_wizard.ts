import type { LocalConfig } from "./local_config.js";

/**
 * Pi SDK UI surface needed by the wizard. Subset of `ExtensionUIContext` —
 * declared inline so tests can mock cleanly without dragging the full
 * ExtensionContext shape.
 */
export interface WizardUI {
  /** Free-text prompt. Returns the entered string, or undefined if cancelled. */
  input?: (title: string, options?: { defaultValue?: string }) => Promise<string | undefined>;
  /** Picker. Returns the picked option, or undefined if cancelled. */
  select: (title: string, options: string[]) => Promise<string | undefined>;
  /** Non-blocking notification. Used for inline validation feedback. */
  notify?: (msg: string, kind: "info" | "warning" | "error") => void;
}

export interface WizardDefaults {
  agent_name: string;
  use_relay: boolean;
  /**
   * Default for the "Enable daemon mode?" prompt. Doesn't persist in
   * `LocalConfig` — daemon enablement is OS-level state (service unit on
   * disk), not config. The wizard surfaces it so first-time users get
   * the option without having to discover `/remote-pi install` later.
   */
  enable_daemon?: boolean;
}

/**
 * Result of `runSetupWizard`. Extends `LocalConfig` with an out-of-band
 * `enable_daemon` flag the caller acts on (by invoking the install
 * command) — NOT a persisted config field.
 */
export interface WizardResult extends LocalConfig {
  enable_daemon: boolean;
}

const YES = "Yes";
const NO = "No";
const CANCEL_TOKEN = "__cancel__";

/**
 * Runs the 3-question setup wizard. Returns the chosen config + a
 * `enable_daemon` flag on confirm, or null when the user cancels any
 * prompt.
 *
 * Prompts:
 *   1. Agent name (default: parent/folder of cwd)
 *   2. Use the relay on this terminal? (yes/no) — gates connection to the
 *      remote mesh (mobile devices + other PCs over the relay). "No" means
 *      local-only: this Pi joins the UDS mesh but doesn't open WSS.
 *   3. Enable daemon mode? (yes/no) — installs the system service so
 *      agents you `/remote-pi create` keep running 24/7 in the background.
 *      Symlinks the `remote-pi` + `pi-supervisord` CLIs into
 *      `~/.local/bin/` so the shell can address daemons by id.
 *   Final: review + confirm "Save and activate?" yes/no
 *
 * The local UDS mesh is always single per machine ("local" session) — no
 * session question. All Pis on the same machine see each other through
 * the same broker.
 */
export async function runSetupWizard(
  ui: WizardUI,
  defaults: WizardDefaults,
): Promise<WizardResult | null> {
  const agent_name = await _askText(
    ui,
    "Agent name:",
    defaults.agent_name,
  );
  if (agent_name === null) return null;

  ui.notify?.(
    "The relay forwards encrypted messages to the Remote Pi mobile app and other PCs in your mesh. Skip this if you only want a local-only mesh on this machine.",
    "info",
  );
  const useRelayChoice = await ui.select(
    "Use the relay on this terminal to connect to the remote mesh (mobile + PCs)?",
    defaults.use_relay ? [YES, NO] : [NO, YES],
  );
  if (!useRelayChoice) return null;
  const auto_start_relay = useRelayChoice === YES;

  ui.notify?.(
    "Daemon mode runs Pi agents 24/7 in the background (systemd on Linux, launchd on macOS) so they can answer your phone or sibling PCs while your terminal is closed. Also adds `remote-pi` and `pi-supervisord` to your $PATH so you can drive them from any shell.",
    "info",
  );
  const enableDaemonDefault = defaults.enable_daemon ?? false;
  const enableDaemonChoice = await ui.select(
    "Enable daemon mode? (run agents 24/7 in background)",
    enableDaemonDefault ? [YES, NO] : [NO, YES],
  );
  if (!enableDaemonChoice) return null;
  const enable_daemon = enableDaemonChoice === YES;

  // Review + confirm
  const summary = [
    `  Agent name:    ${agent_name}`,
    `  Use relay:     ${auto_start_relay ? YES : NO}`,
    `  Daemon mode:   ${enable_daemon ? YES : NO}`,
  ].join("\n");
  ui.notify?.(`Summary:\n${summary}`, "info");

  const confirm = await ui.select("Save and activate?", [YES, NO]);
  if (confirm !== YES) return null;

  return { agent_name, auto_start_relay, enable_daemon };
}

/**
 * Asks the user for free text. The Pi SDK's `ui.input` does not pre-fill the
 * field with `defaultValue` (the SDK ignores that option), so we surface the
 * default in the prompt label and treat an empty submission as "accept the
 * default" — the standard CLI convention. Falls back to `select` when the
 * SDK doesn't expose `input` at all.
 */
async function _askText(
  ui: WizardUI,
  title: string,
  defaultValue: string,
): Promise<string | null> {
  const titleWithHint = `${title} (default: ${defaultValue})`;
  const raw = ui.input
    ? await ui.input(titleWithHint, { defaultValue })
    : await ui.select(titleWithHint, [defaultValue, CANCEL_TOKEN]);
  if (raw === undefined) return null;
  if (raw === CANCEL_TOKEN) return null;
  const trimmed = raw.trim();
  // Empty submission = accept the default. No re-prompt, no warning — the
  // user explicitly asked for the default by hitting enter.
  return trimmed.length > 0 ? trimmed : defaultValue;
}
