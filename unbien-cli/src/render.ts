/**
 * Draws transcript items with pi's OWN interactive components, so a remote
 * session looks identical to a local one. Built-in tool definitions are
 * constructed for their renderers only — `execute` is never called, so nothing
 * here touches the filesystem.
 */
import {
  AssistantMessageComponent,
  UserMessageComponent,
  ToolExecutionComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import type { TranscriptItem } from "./reduce.js"

// SAFETY: these components touch exactly one TUI member — `requestRender` — to
// schedule a repaint. A one-shot render has nothing to schedule, so the stub is
// complete for this use; a component reaching further would throw loudly here
// rather than silently mis-render.
const offlineTui = { requestRender: () => {} } as unknown as TUI

function builtinRenderers(cwd: string) {
  return new Map<string, unknown>([
    ["bash", createBashToolDefinition(cwd)],
    ["edit", createEditToolDefinition(cwd)],
    ["find", createFindToolDefinition(cwd)],
    ["grep", createGrepToolDefinition(cwd)],
    ["ls", createLsToolDefinition(cwd)],
    ["read", createReadToolDefinition(cwd)],
    ["write", createWriteToolDefinition(cwd)],
  ])
}

/**
 * Draw an in-flight assistant turn with the SAME component that draws the
 * settled one, so the text doesn't visibly reflow when the message lands — it
 * is simply replaced by its finished self.
 */
/**
 * In-flight reasoning, drawn as a thinking block by the same component that
 * renders it once settled.
 */
export function renderThinking(text: string, width: number): string[] {
  if (!text) return []
  const component = new AssistantMessageComponent(
    undefined,
    false,
    getMarkdownTheme(),
  )
  // A thinking block carries its prose in `thinking`, not `text`.
  component.updateContent(
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: text }],
    } as never,
    true,
  )
  return component.render(width)
}

export function renderStreaming(text: string, width: number): string[] {
  if (!text) return []
  const component = new AssistantMessageComponent(
    { role: "assistant", content: [{ type: "text", text }] } as never,
    false,
    getMarkdownTheme(),
  )
  component.updateContent(
    { role: "assistant", content: [{ type: "text", text }] } as never,
    true,
  )
  return component.render(width)
}

export function renderTranscript(
  items: readonly TranscriptItem[],
  width: number,
  cwd: string,
  hideThinking = false,
): string[] {
  const markdownTheme = getMarkdownTheme()
  const renderers = builtinRenderers(cwd)
  const lines: string[] = []

  for (const item of items) {
    if (item.kind === "notice") {
      lines.push(`  ${item.text}`, "")
      continue
    }

    if (item.kind === "message") {
      const { message } = item
      if (message.role === "user") {
        const text = message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
        lines.push(
          ...new UserMessageComponent(text, markdownTheme).render(width),
          "",
        )
        continue
      }
      const component = new AssistantMessageComponent(
        // The wire message IS pi's own serialization of an AssistantMessage.
        message as never,
        hideThinking,
        markdownTheme,
      )
      lines.push(...component.render(width), "")
      continue
    }

    const card = new ToolExecutionComponent(
      item.toolName,
      item.toolCallId,
      item.args,
      {},
      renderers.get(item.toolName.toLowerCase()) as never,
      offlineTui,
      cwd,
    )
    card.setArgsComplete()
    card.markExecutionStarted()
    if (item.result) {
      card.updateResult({
        content: item.result.content as never,
        details: item.result.details,
        isError: item.result.isError,
      })
    }
    card.setExpanded(true)
    lines.push(...card.render(width), "")
  }

  return lines
}
