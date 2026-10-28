/**
 * Pi binding's EventSource: wraps the extension API's `on` bus.
 *
 * The receiver is bound at construction — some hosts implement
 * ExtensionAPI as class methods whose `this` carries per-extension state, so
 * a detached `on(...)` is a TypeError there even though pi's own
 * implementation tolerates it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { EventSource } from "../core/event_source.js"

export class PiOnEventSource implements EventSource {
  private readonly bound: (
    event: string,
    handler: (payload: unknown) => void,
  ) => void

  constructor(pi: ExtensionAPI) {
    // SAFETY: pi.on's public typing is a narrower event-name union; the live
    // plane subscribes by string name, which is valid at runtime for every
    // RPC_EVENT_NAMES entry (they are real AgentSessionEvent names).
    this.bound = pi.on.bind(pi) as unknown as (
      event: string,
      handler: (payload: unknown) => void,
    ) => void
  }

  on(event: string, handler: (payload: unknown) => void): void {
    this.bound(event, handler)
  }
}