import { describe, expect, test } from "vitest";
import { wireFromModel, type SdkModelLike } from "./handlers.js";

// The stock action handlers (session_compact/new/model_set/thinking_set/
// list_models) were retired when those commands migrated to the rpc plane; only
// the shared `wireFromModel` projection remains testable here.

const sampleModel: SdkModelLike = {
  id: "claude-opus-4-7",
  name: "Claude Opus 4.7",
  provider: "anthropic",
  reasoning: true,
  contextWindow: 200_000,
};

describe("wireFromModel", () => {
  test("maps SDK Model fields to wire schema 1:1 (camelCase → snake_case)", () => {
    expect(wireFromModel(sampleModel)).toEqual({
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      provider: "anthropic",
      reasoning: true,
      context_window: 200_000,
      vision: false, // sampleModel has no `input` → text-only
    });
  });

  // Plan/30: `vision` reflects whether the model's `input` includes "image".
  test('vision=true when model.input includes "image"', () => {
    const visionModel: SdkModelLike = {
      ...sampleModel,
      input: ["text", "image"],
    };
    expect(wireFromModel(visionModel).vision).toBe(true);
  });

  test("vision=false when model.input is text-only", () => {
    const textOnly: SdkModelLike = { ...sampleModel, input: ["text"] };
    expect(wireFromModel(textOnly).vision).toBe(false);
  });
});
