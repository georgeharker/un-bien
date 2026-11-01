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
import { PiSessionControl, PiSessionPort } from "./session_port.js"
import { RPC_EVENT_NAMES } from "../session/rpc_envelope.js"

/** The ctx receiver's structural shape shutdown() reads. */
type CtxStub = Pick<ExtensionContext, "abort">

/** The ctx receiver's structural shape PiSessionPort.streaming reads. */
type PortCtxStub = Pick<ExtensionContext, "compact" | "abort" | "ui" | "isIdle">

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

describe("PiSessionPort streaming (receiver pin)", () => {
  /**
   * A factory-pi stand-in carrying an isStreaming member (and isIdle) — if
   * the getter ever regresses back to reading the factory pi, the fake
   * member would win and the tests fail, not silently pass.
   */
  function fakePiWithIsStreaming(): ExtensionAPI {
    return {
      isStreaming: true,
      isIdle: vi.fn(() => false),
    } as unknown as ExtensionAPI
  }

  function portCtxStub(members: {
    isIdle?: () => boolean
  }): PortCtxStub {
    return members as unknown as PortCtxStub
  }

  function streamingPort(
    getBaseCtx: () => PortCtxStub | null,
  ): PiSessionPort {
    return new PiSessionPort({
      getPi: () => fakePiWithIsStreaming(),
      getBaseCtx,
      getSessionManager: () => null,
    })
  }

  it("is true when the base ctx is streaming (isIdle() false)", () => {
    const isIdle = vi.fn(() => false)
    const port = streamingPort(() => portCtxStub({ isIdle }))

    expect(port.streaming).toBe(true)
    expect(isIdle).toHaveBeenCalledTimes(1)
  })

  it("is false when the base ctx is idle (isIdle() true) — the factory pi's isStreaming is never consulted", () => {
    // The fake pi says isStreaming: true; the ctx says idle. Streaming must
    // follow the CTX — the receiver pin.
    const isIdle = vi.fn(() => true)
    const port = streamingPort(() => portCtxStub({ isIdle }))

    expect(port.streaming).toBe(false)
    expect(isIdle).toHaveBeenCalledTimes(1)
  })

  it("is false with no base ctx", () => {
    const port = streamingPort(() => null)

    expect(port.streaming).toBe(false)
  })
})

describe("PiSessionPort.subscribeEvents (dispose gate)", () => {
  /**
   * A fake pi whose `on` registers callbacks the test can fire. It counts
   * every dispatch INTO a registered callback, so the test can prove the
   * gate lives INSIDE the callback (pi keeps dispatching after dispose) —
   * not in pi.on (pi would have to unregister, which it can't).
   */
  function fakeEventPi() {
    const registered = new Map<
      string,
      Array<(payload: unknown) => void>
    >()
    const dispatches: Array<{ event: string; payload: unknown }> = []
    const pi = {
      on(event: string, cb: (payload: unknown) => void) {
        const list = registered.get(event) ?? []
        list.push(cb)
        registered.set(event, list)
      },
      fire(event: string, payload: unknown) {
        for (const cb of registered.get(event) ?? []) {
          dispatches.push({ event, payload })
          cb(payload)
        }
      },
      dispatchCount: () => dispatches.length,
    }
    return pi
  }

  it("the disposer gates INSIDE the registered callback — pi keeps receiving events", () => {
    const pi = fakeEventPi()
    const port = new PiSessionPort({
      getPi: () => pi as unknown as ExtensionAPI,
      getBaseCtx: () => null,
      getSessionManager: () => null,
    })
    const handler = vi.fn()
    const event = RPC_EVENT_NAMES[0]

    const dispose = port.subscribeEvents(handler)

    // Before dispose: the event reaches the handler.
    pi.fire(event, { n: 1 })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(event, { n: 1 })

    const dispatchesBeforeDispose = pi.dispatchCount()
    dispose()

    // After dispose: the handler is gated, but pi STILL dispatches into the
    // registered callback — pi.on has no unregister; the gate is the closure
    // flag inside the callback.
    pi.fire(event, { n: 2 })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(pi.dispatchCount()).toBe(dispatchesBeforeDispose + 1)

    // And a second dispose is harmless.
    expect(() => dispose()).not.toThrow()
  })
})