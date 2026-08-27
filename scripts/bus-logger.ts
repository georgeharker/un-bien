// Throwaway harness helper: log every subagents:* / plan:* in-process bus event
// to BUS_LOG (default /tmp/bus-events.jsonl), one JSON object per line. Load with
// `-e scripts/bus-logger.ts` to harvest the real bus-event shapes that the fork's
// {evt} plane forwards (these do NOT appear on `pi --mode rpc` stdout).
import { appendFileSync } from "node:fs";

const CHANNELS = [
  "subagents:created",
  "subagents:started",
  "subagents:steered",
  "subagents:compacted",
  "subagents:ready",
  "subagents:completed",
  "subagents:failed",
  "plan:snapshot",
  "plan:update",
];

export default function busLogger(pi: {
  events?: { on?: (ch: string, h: (data: unknown) => void) => unknown };
}): void {
  const out = process.env.BUS_LOG ?? "/tmp/bus-events.jsonl";
  const bus = pi.events;
  if (!bus?.on) return;
  for (const ch of CHANNELS) {
    bus.on(ch, (data: unknown) => {
      appendFileSync(out, JSON.stringify({ ch, t: Date.now(), data }) + "\n");
    });
  }
}
