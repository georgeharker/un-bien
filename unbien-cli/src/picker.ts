/**
 * Session picker built on pi's own `SelectList` — arrow-key highlight,
 * type-to-filter, and pi's list theme, rather than "enter a number".
 */
import { getSelectListTheme } from "@earendil-works/pi-coding-agent"
import { SelectList, type SelectItem } from "@earendil-works/pi-tui"
import type { RoomInfo } from "./client.js"

const MAX_VISIBLE = 12

/**
 * `SelectList.setFilter` prefix-matches on `value`, so the value must be what a
 * person would type — the session name, not its routing id. Names are not
 * unique, so collisions get a short session-id suffix to stay addressable.
 */
function buildItems(rooms: readonly RoomInfo[]): {
  items: SelectItem[]
  byValue: Map<string, RoomInfo>
} {
  const seen = new Map<string, number>()
  const items: SelectItem[] = []
  const byValue = new Map<string, RoomInfo>()

  for (const room of rooms) {
    const base = room.name ?? room.sessionId?.slice(0, 8) ?? room.room_id
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    const id = room.sessionId?.slice(0, 8) ?? room.room_id
    const value = count === 1 ? base : `${base} (${id})`
    items.push({
      value,
      label: room.parent ? `${value} (subagent)` : value,
      description: room.cwd ?? "",
    })
    byValue.set(value, room)
  }
  return { items, byValue }
}

/**
 * Renders on stderr in raw mode so stdout stays clean for the transcript.
 * Resolves to the chosen session, or null if cancelled.
 */
export function pickSession(
  rooms: readonly RoomInfo[],
): Promise<RoomInfo | null> {
  const { items, byValue } = buildItems(rooms)
  const list = new SelectList(items, MAX_VISIBLE, getSelectListTheme())

  const input = process.stdin
  const output = process.stderr
  const width = output.columns ?? 100
  let filter = ""
  let lastHeight = 0

  const paint = () => {
    if (lastHeight > 0) output.write(`\u001b[${lastHeight}A`)
    const lines = [
      `  filter: ${filter}\u001b[K`,
      ...list.render(width).map((line) => `${line}\u001b[K`),
    ]
    for (const line of lines) output.write(`${line}\n`)
    lastHeight = lines.length
  }

  return new Promise((resolve) => {
    const finish = (room: RoomInfo | null) => {
      input.off("data", onData)
      if (input.isTTY) input.setRawMode(false)
      // Deliberately NOT paused: the shell takes stdin over next, and a paused
      // stream there is a prompt box that renders but never sees a keystroke.
      output.write("\u001b[?25h")
      resolve(room)
    }

    list.onSelect = (item) => finish(byValue.get(item.value) ?? null)
    list.onCancel = () => finish(null)

    const onData = (chunk: Buffer) => {
      const data = chunk.toString("utf8")
      if (data === "\u0003") {
        finish(null)
        return
      }
      if (data === "\u007f" || data === "\b") {
        filter = filter.slice(0, -1)
        list.setFilter(filter)
      } else if (/^[\x20-\x7e]+$/.test(data)) {
        filter += data
        list.setFilter(filter)
      } else {
        list.handleInput(data)
      }
      paint()
    }

    output.write(
      "Select a session (↑/↓ move · type to filter · enter · esc)\n\n",
    )
    output.write("\u001b[?25l")
    if (input.isTTY) input.setRawMode(true)
    input.resume()
    input.on("data", onData)
    paint()
  })
}
