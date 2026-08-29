/**
 * Model registry projection + the narrow SDK/ctx views the rpc command
 * dispatch (`index.ts`) uses for `set_model` / `get_available_models` /
 * `compact` / `new_session`.
 *
 * The former stock action handlers (session_compact/new/model_set/thinking_set/
 * list_models) were retired when those app commands migrated to the rpc plane
 * (dispatchRpcCommand). Only the shared model types + `wireFromModel` + the
 * narrow ctx/pi/registry views the rpc handlers still take remain.
 */

import type { WireModel } from "../protocol/types.js";

/**
 * Structural subset of the SDK's `Model<Api>` interface (defined in
 * `@earendil-works/pi-ai`, a transitive dep not re-exported by
 * `@earendil-works/pi-coding-agent`'s main entry). Capturing just the fields we
 * touch keeps this decoupled from the SDK's full Model surface.
 */
export interface SdkModelLike {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow: number;
  /** Plan/30: accepted input modalities. The SDK's `Model.input` is
   *  `("text" | "image")[]`; we read `includes("image")` for the `vision`
   *  flag. Optional here so tests can omit it (treated as text-only). */
  input?: ("text" | "image")[];
}
// `Model` is the alias used throughout the file. Real SDK models structurally
// satisfy this — `pi.setModel(model)` accepts them because TypeScript validates
// structurally at the call site.
type Model<_TApi = unknown> = SdkModelLike;

/**
 * Narrow shape of the `ExtensionAPI` surface the rpc dispatch calls (setModel /
 * setThinkingLevel). Lets the test layer stub just these.
 */
export interface ActionPi {
  setModel(model: Model<any>): Promise<boolean>;
  setThinkingLevel(level: import("../protocol/types.js").ThinkingLevel): void;
}

/**
 * Narrow shape of the per-call context. Drawn from the union of
 * `ExtensionContextActions` (compact, getModel) and
 * `ExtensionCommandContextActions` (newSession). All fields optional so a
 * missing method becomes a typed error instead of a runtime TypeError.
 */
export interface ActionCtx {
  compact?: (options?: Record<string, unknown>) => void;
  /**
   * Starts a new session. `withSession` is the SDK's blessed hook for
   * post-replacement work: it receives a FRESH, command-capable ctx bound to
   * the new session. The SDK marks any ctx captured BEFORE this call stale, so
   * callers must re-capture via `withSession` rather than reuse the old ctx.
   */
  newSession?: (options?: {
    withSession?: (ctx: ActionCtx) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
  getModel?: () => Model<any> | undefined;
  /**
   * Live session registry from Pi's extension ctx. Includes providers/models
   * registered dynamically via `pi.registerProvider(...)`, unlike the fallback
   * disk-backed registry un-bien can build on its own.
   */
  modelRegistry?: ActionModelRegistry;
}

/**
 * Minimal shape of the registry surface. Maps 1:1 onto `ModelRegistry` but lets
 * tests fake catalogs without instantiating the real one.
 */
export interface ActionModelRegistry {
  refresh(): void;
  getAvailable(): Model<any>[];
  find(provider: string, modelId: string): Model<any> | undefined;
}

/** Project a SDK `Model<Api>` onto the wire schema. Shared by the rpc
 *  `get_available_models` / `set_model` dispatch so both stay in lockstep. */
export function wireFromModel(model: Model<any>): WireModel {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    reasoning: model.reasoning,
    context_window: model.contextWindow,
    // Plan/30: vision = model accepts image input. `Model.input` is
    // `("text" | "image")[]` at runtime (confirmed against pi-ai). `?.` guards
    // a fake/partial model in tests → treated as text-only.
    vision: model.input?.includes("image") ?? false,
  };
}
