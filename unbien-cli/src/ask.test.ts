import { describe, expect, it } from "vitest"
import {
  answerResponse,
  cancelResponse,
  effectiveType,
  routeNotify,
  type AskAnswer,
  type AskPrompt,
} from "./ask.js"
import { reduce, toEnvelope } from "./reduce.js"

const OPEN = "flow-1"
const isOpen = (id: string) => id === OPEN

/**
 * The contract under test is design 01M1CF5FYMWHAGVZX3RDM50E34: a notify is a
 * dismissal signal, not prompt content.
 */
describe("notify routing", () => {
  it("dismisses the open ask it resolves", () => {
    const r = routeNotify(
      { id: OPEN, message: "Clarification resolved." },
      isOpen,
    )
    expect(r).toEqual({ kind: "dismiss", id: OPEN })
  })

  it("drops a resolution ack for a flow we never showed", () => {
    const r = routeNotify({ id: "other", message: "resolved" }, isOpen)
    expect(r.kind).toBe("drop")
  })

  it("surfaces a warning inline and leaves the ask standing", () => {
    const r = routeNotify(
      { id: OPEN, notifyType: "warning", message: "answer rejected" },
      isOpen,
    )
    expect(r).toEqual({
      kind: "notice",
      level: "warning",
      text: "answer rejected",
    })
  })

  it("keeps an id-less notify as an ordinary notice", () => {
    expect(routeNotify({ message: "relay attached" }, isOpen).kind).toBe(
      "notice",
    )
  })
})

describe("the reducer keeps resolution acks out of the transcript", () => {
  const notify = (extra: Record<string, unknown>) =>
    toEnvelope({
      type: "extension_ui_request",
      method: "notify",
      message: "m",
      ...extra,
    })!

  it("renders warnings but not info acks", () => {
    const items = reduce([notify({}), notify({ notifyType: "warning" })])
    expect(items.map((i) => i.kind)).toEqual(["notice"])
  })
})

describe("responses carry the ask envelope", () => {
  const prompt: AskPrompt = {
    id: OPEN,
    method: "select",
    ask: {
      flow_id: OPEN,
      source: "pi-ask",
      questions: [
        {
          id: "q1",
          prompt: "Which?",
          type: "single",
          options: [{ value: "a", label: "A" }],
        },
      ],
    },
  }

  it("answers with structured values and a scalar for strict clients", () => {
    const r = answerResponse(prompt, { q1: { values: ["a"] } })
    expect(r.id).toBe(OPEN)
    expect(r.value).toBe("a")
    expect(r.ask).toMatchObject({ flow_id: OPEN, kind: "answer" })
  })

  it("cancels with the flow id", () => {
    expect(cancelResponse(prompt).ask).toEqual({
      flow_id: OPEN,
      kind: "cancel",
    })
  })

  // pi-ask's own validator (src/remote-ask.ts) rejects an answer that combines
  // a selected value with custom text on a non-multi question, so the freeform
  // path must send customText ALONE.
  it("answers a freeform question with custom text and no values", () => {
    const freeform: AskPrompt = {
      id: OPEN,
      method: "input",
      ask: {
        flow_id: OPEN,
        questions: [
          {
            id: "q1",
            prompt: "Which?",
            type: "single",
            options: [{ value: "freeform", label: "Type answer", freeform: true }],
          },
        ],
      },
    }
    const r = answerResponse(freeform, { q1: { customText: "my own words" } })
    const answer = (r.ask as { answers: Record<string, AskAnswer> }).answers.q1
    expect(answer?.customText).toBe("my own words")
    expect(answer?.values).toBeUndefined()
    expect(r.value).toBe("my own words")
  })

  it("prefers the presented type over the requested one", () => {
    expect(
      effectiveType({
        id: "q",
        prompt: "p",
        type: "multi",
        presentedType: "single",
        options: [],
      }),
    ).toBe("single")
  })
})
