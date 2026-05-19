/** Tool names that execute automatically without prompting the user. */
export const AUTO_APPROVE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
]);

export type ApprovalDecision = "auto" | "ask";

/** Returns 'auto' for read-only tools, 'ask' for everything else. */
export function decide(toolName: string): ApprovalDecision {
  return AUTO_APPROVE_TOOLS.has(toolName) ? "auto" : "ask";
}
