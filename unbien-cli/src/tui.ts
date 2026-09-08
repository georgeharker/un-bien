/**
 * The interactive shell: pi's TUI main-screen root, its editor for the prompt
 * box, and a footer. Transcript lines are printed into scrollback above the
 * dynamic region, which is how pi's own regular (non-fullscreen) mode works.
 */
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent"
import {
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  type Component,
  type EditorTheme,
  type SelectItem,
} from "@earendil-works/pi-tui"

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme")

/**
 * Holds transcript lines that are ALREADY rendered to width by pi's components.
 * `Text` would word-wrap them again and mangle the ANSI, so emit them verbatim.
 */
class Lines implements Component {
  private lines: string[] = []

  append(lines: readonly string[]): void {
    this.lines.push(...lines)
  }

  reset(lines: readonly string[]): void {
    this.lines = [...lines]
  }

  get length(): number {
    return this.lines.length
  }

  invalidate(): void {
    // Nothing cached: the lines are already final.
  }

  render(): string[] {
    return this.lines
  }
}

/** The active theme instance, which pi shares through a global symbol. */
function activeTheme(): Theme {
  return (globalThis as Record<symbol, Theme>)[THEME_KEY]!
}

function editorTheme(): EditorTheme {
  const theme = activeTheme()
  return {
    borderColor: (s) => theme.fg("border", s),
    selectList: getSelectListTheme(),
  }
}

export interface ShellStatus {
  session: string
  cwd: string
  model?: string
  working?: boolean
  /** What the agent is doing right now, e.g. a running tool's name. */
  activity?: string
}

export class Shell {
  readonly tui = new TuiMainScreen(new ProcessTerminal())
  private readonly editor: Editor
  private readonly footer: Text
  private readonly working: Loader
  private isWorking = false
  private quitting = false
  /** In-flight assistant turn, shown above the editor until it settles. */
  private readonly live = new Lines()
  private readonly transcript = new Lines()
  /** Persistent panel widgets, pinned above the composer like pi's own. */
  private readonly widgets = new Lines()
  /**
   * Command output (/tree, /plan, …) lives BELOW the transcript: `draw()`
   * replaces the transcript wholesale on every frame, which would otherwise
   * erase anything a command had printed.
   */
  private readonly notes = new Lines()
  private status: ShellStatus
  /** A modal chooser owns input while open, so the editor must not also see it. */
  private overlay: SelectList | null = null

  constructor(
    status: ShellStatus,
    onSubmit: (text: string) => void,
    private readonly onQuit: () => void = () => process.exit(0),
  ) {
    this.status = status
    this.editor = new Editor(this.tui, editorTheme(), { paddingX: 1 })
    this.editor.onSubmit = (text) => {
      const trimmed = text.trim()
      this.editor.setText("")
      if (trimmed) onSubmit(trimmed)
    }
    this.footer = new Text(this.renderFooter())
    const theme = activeTheme()
    this.working = new Loader(
      this.tui,
      (s) => theme.fg("accent", s),
      (s) => theme.fg("muted", s),
      "",
    )
    this.tui.addChild(this.transcript)
    this.tui.addChild(this.notes)
    this.tui.addChild(this.live)
    this.tui.addChild(this.widgets)
    this.tui.addChild(this.working)
    this.tui.addChild(this.editor)
    this.tui.addChild(this.footer)
    this.tui.setFocus(this.editor)
  }

  start(): void {
    // The picker hands stdin back paused; the terminal needs it flowing.
    process.stdin.resume()
    this.tui.start()
    // Ctrl-C / Ctrl-D must always exit. The editor consumes ordinary keys, so
    // without this the shell has no way out and the process looks wedged.
    // Match through pi's key parser, NOT raw bytes: ProcessTerminal pushes the
    // Kitty keyboard protocol, so Ctrl-C arrives as CSI-u (`\x1b[99;5u`) and a
    // `data === "\x03"` test silently never fires.
    this.tui.addInputListener((data: string) => {
      const isCancel = matchesKey(data, "ctrl+c")
      if (!isCancel && !matchesKey(data, "ctrl+d")) return undefined
      if (isCancel && this.overlay) return undefined // the list cancels itself
      this.quit()
      return { consume: true }
    })
    process.on("SIGINT", () => this.quit())
  }

  /**
   * Terminal reset is pi's job, not ours: `tui.stop()` → `ProcessTerminal.stop()`
   * disables bracketed paste and the Kitty keyboard protocol, drops its stdin
   * handlers, and restores raw mode to what it WAS — pausing stdin first, which
   * its own comment marks as the fix for a Ctrl-D race that can close the parent
   * shell over SSH. Doing any of that by hand here re-broke that ordering.
   *
   * We add only what pi can't know about: our socket, and a watchdog so a throw
   * in teardown can't leave the process stranded.
   */
  quit(): void {
    if (this.quitting) return
    this.quitting = true
    try {
      this.working.stop()
      this.tui.stop()
    } catch {
      /* fall through to the watchdog rather than stranding the process */
    }
    const watchdog = setTimeout(() => process.exit(130), 250)
    watchdog.unref()
    this.onQuit()
  }

  /**
   * The in-flight turn is REWRITTEN on every delta, so it can't be appended to
   * the transcript. It renders in its own region and is cleared the moment the
   * settled message takes its place — same component, so no visible reflow.
   */
  setLive(lines: readonly string[]): void {
    this.live.reset(lines.length > 0 ? ["", ...lines] : [])
    this.tui.requestRender()
  }

  stop(): void {
    this.working.stop()
    this.tui.stop()
  }

  setStatus(patch: Partial<ShellStatus>): void {
    this.status = { ...this.status, ...patch }
    // The spinner animates only while the agent is working; leaving it running
    // costs a repaint every frame for no information.
    const working = this.status.working === true
    if (working !== this.isWorking) {
      this.isWorking = working
      if (working) {
        this.working.start()
      } else {
        this.working.stop()
      }
    }
    this.working.setMessage(working ? (this.status.activity ?? "working") : "")
    this.footer.setText(this.renderFooter())
    this.tui.requestRender()
  }

  /**
   * Transcript must live INSIDE the TUI: a full repaint emits `\x1b[3J`, which
   * clears the scrollback buffer, so anything written straight to stdout is
   * erased the moment the shell next redraws.
   */
  print(lines: readonly string[]): void {
    if (lines.length === 0) return
    this.notes.append(lines)
    this.tui.requestRender()
  }

  /** Drop command output (it is scratch, not conversation). */
  clearNotes(): void {
    this.notes.reset([])
    this.tui.requestRender()
  }

  /** Replace the pinned panel widgets (plan / subagents). */
  setWidgets(lines: readonly string[]): void {
    this.widgets.reset(lines.length > 0 ? ["", ...lines] : [])
    this.tui.requestRender()
  }

  /** Replace the whole transcript (history replay re-reduces from scratch). */
  setTranscript(lines: readonly string[]): void {
    this.transcript.reset(lines)
    this.tui.requestRender()
  }

  /**
   * A chooser whose rows carry ACTIONS: a single keypress both picks the row
   * and says what to do with it. Filtering is off here on purpose — the letter
   * keys are the shortcuts, and a filter would swallow them.
   */
  chooseAction(
    title: string,
    items: SelectItem[],
    hint: string,
    keys: readonly string[],
  ): Promise<{ item: SelectItem; action: string } | null> {
    if (items.length === 0) return Promise.resolve(null)
    return new Promise((resolve) => {
      const list = new SelectList(items, 12, getSelectListTheme())
      const heading = new Text(`  ${title}\n  ${hint}`)
      const finish = (result: { item: SelectItem; action: string } | null) => {
        this.tui.removeChild(list)
        this.tui.removeChild(heading)
        this.overlay = null
        this.tui.removeInputListener(onKey)
        this.tui.setFocus(this.editor)
        this.tui.requestRender()
        resolve(result)
      }
      const onKey = (data: string) => {
        if (!this.overlay) return undefined
        if (keys.includes(data)) {
          const item = list.getSelectedItem()
          if (item) finish({ item, action: data })
          return { consume: true }
        }
        return undefined
      }
      list.onSelect = (item) => finish({ item, action: keys[0] ?? "" })
      list.onCancel = () => finish(null)
      this.overlay = list
      this.tui.addChild(heading)
      this.tui.addChild(list)
      this.tui.addInputListener(onKey)
      this.tui.setFocus(list)
      this.tui.requestRender()
    })
  }

  /** A highlighted chooser layered over the editor; resolves to the pick. */
  choose(title: string, items: SelectItem[]): Promise<SelectItem | null> {
    if (items.length === 0) return Promise.resolve(null)
    return new Promise((resolve) => {
      const list = new SelectList(items, 12, getSelectListTheme())
      const heading = new Text(`  ${title}`)
      const finish = (picked: SelectItem | null) => {
        this.tui.removeChild(list)
        this.tui.removeChild(heading)
        this.overlay = null
        this.tui.setFocus(this.editor)
        this.tui.requestRender()
        resolve(picked)
      }
      list.onSelect = finish
      list.onCancel = () => finish(null)
      this.overlay = list
      this.tui.addChild(heading)
      this.tui.addChild(list)
      this.tui.setFocus(list)
      this.tui.requestRender()
    })
  }

  get hasOverlay(): boolean {
    return this.overlay !== null
  }

  private renderFooter(): string {
    const theme = activeTheme()
    const parts = [this.status.session, this.status.cwd]
    if (this.status.model) parts.push(this.status.model)
    parts.push(this.status.working ? "working…" : "idle")
    return theme.fg("muted", `  ${parts.join("  ·  ")}`)
  }
}
