/**
 * Harness-neutral event subscription seam.
 *
 * The rpc-envelope frame producer (session/rpc_envelope.ts) reconstructs a
 * coding-agent-style event plane from a host's live events and fans each one
 * out as a `{ rpc }` envelope frame. This interface is the ONLY thing that
 * producer needs from its host: a way to register a handler per event NAME.
 *
 * Contract:
 *   - `event` names and `payload` shapes are the AgentSessionEvent plane
 *     (the same names/fields `pi --mode rpc` streams). The producer selects
 *     the rpc-frame fields per event; extension payloads are a superset, so
 *     a host may deliver more fields than a stock frame carries.
 *   - A host MAY deliver events not in RPC_EVENT_NAMES; the producer ignores
 *     unknown names.
 *   - `on` registers additively; there is no unregister — dispose at the
 *     producer's level (its `dispose()` stops acting on events). A binding
 *     whose host supports removal may drop handlers itself once disposed.
 *   - Handlers fire synchronously from the host's event dispatch; a handler
 *     must not throw into it (the producer wraps its work in try/catch).
 *
 * Bindings:
 *   - pi-coding-agent: `PiOnEventSource` (pi_binding/pi_on_event_source.ts)
 *     wraps `pi.on` — the same events the extension factory registers for.
 *   - pi-durable: `WatchEventsSource` (unbien-durable) adapts the durable
 *     `watchEvents()` stream to the same names/payload shapes.
 */

/**
 * A source of named, single-payload agent events.
 * Structurally satisfied by any host bus with an `on(name, handler)` shape.
 */
export interface EventSource {
  /**
   * Register `handler` for every delivery of the event named `event`.
   * The payload is the host's raw event object; the producer interprets it.
   */
  on(event: string, handler: (payload: unknown) => void): void
}