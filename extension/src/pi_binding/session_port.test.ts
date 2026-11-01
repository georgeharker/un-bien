/**
 * PiSessionControl terminate (shutdown) — the F2 regression cover.
 *
 * The merge repointed the app's terminate frame at
 * PiSessionControl.shutdown(), which read abort/shutdown off the FACTORY pi
 * object (ExtensionAPI exposes neither member) — terminate went dark with no
 * error. These tests pin the receiver: the root session_start ctx, never the
 * factory pi. A fake control object with abort/shutdown members stands in for
 * the ctx; a pi stand-in carrying the SAME members proves they're never
 * consulted.
 */
import { describe, expect, it, vi } from "vitest"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { PiSessionControl } from "./session_port.js"

/** The ctx receiver's structural shape shutdown() reads. */
type CtxStub = Pick<ExtensionContext, "abort">

/**
 * A factory-pi stand-in. Deliberately carries abort/shutdown TOO — if the
 * receiver ever regresses back to pi, these spies fire and the tests fail,
 * not silently pass.
 */
function fakePi(): ExtensionAPI {
  return {
    abort: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as ExtensionAPI
}

function ctxStub(members: { abort?: () => void; shutdown?: () => void }): CtxStub {
  return members as unknown as CtxStub
}

describe("PiSessionControl terminate (shutdown)", () => {
  it("aborts then shuts down the BASE CTX — never the factory pi", async () => {
    const piAbort = vi.fn()
    const piShutdown = vi.fn()
    const pi = {
      abort: piAbort,
      shutdown: piShutdown,
    } as unknown as ExtensionAPI
    const order: string[] = []
    const abort = vi.fn(() => order.push("abort"))
    const shutdown = vi.fn(() => order.push("shutdown"))
    const control = new PiSessionControl(() => pi, () =>
      ctxStub({ abort, shutdown }),
    )

    await control.shutdown()

    // The ctx members fired, in the deferred-settle order: abort first.
    expect(abort).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(order).toEqual(["abort", "shutdown"])
    // The factory pi's members were never consulted.
    expect(piAbort).not.toHaveBeenCalled()
    expect(piShutdown).not.toHaveBeenCalled()
  })

  it("with a ctx carrying no members of its own, abort is optional — shutdown alone terminates", async () => {
    const shutdown = vi.fn()
    const control = new PiSessionControl(fakePi, () => ctxStub({ shutdown }))

    await control.shutdown()

    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it("with no live ctx it stays up (refuses a raw exit) instead of throwing", async () => {
    const control = new PiSessionControl(fakePi, () => null)

    await expect(control.shutdown()).resolves.toBeUndefined()
  })
})