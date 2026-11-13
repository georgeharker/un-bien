import SwiftUI
import UnBienCore

struct ToolCardView: View {
    let card: ToolCard
    let theme: AppTheme
    let typography: Typography
    let displayPolicy: ToolDisplayPolicy
    let hideInputRich: Bool
    let store: CardUIState
    let themeID: ThemeID  // diff-cache key discriminator (colors are theme-derived)
    // Expand + Diff⇄Content toggle are LOCAL @State for
    // reactivity, SEEDED from CardUIState in init + written back onChange, so
    // they survive the windowed transcript destroying this view on scroll
    // ("edits disappear") WITHOUT making every card an @EnvironmentObject
    // subscriber (that made scrolling jerkier — design 01M1S9ET append). Local
    // @State keeps a toggle a card-only re-render (TranscriptRow.equatable()
    // intact); the store is touched only on materialize (read) + toggle (write).
    @State private var expanded: Bool
    @State private var showContent: Bool
    /// Showing the short Preview result (ToolCardView+Result: previewParts);
    /// "N more lines" clears it for good.
    @State var previewing: Bool
    // DERIVATION CACHE (typing-during-output fix, 2026-09-10): inputHunks /
    // contentText / args+result pretty-strings used to re-derive in `body` on
    // EVERY re-render — and a RUNNING tool's growing result made
    // `result.prettyString` O(output-so-far) per fold flush (O(n²) over a tool
    // run, on main, while the user types). Cached per card VALUE (Equatable);
    // while `state == .running` the big strings derive from a budget PREFIX
    // only (the display truncates anyway — SHOW ALL mid-run is meaningless),
    // settling to the full derivation once the tool ends.
    private struct CardDerivations {
        let hunks: [JSONValue]?
        let content: (text: String, lang: String?)?
        let argsPretty: String
        let parts: [ToolResultPart]
    }
    /// A REFERENCE box, not a `@State` value. `derived` is read from `body`,
    /// so writing the memo through a value-typed `@State` is "modifying state
    /// during view update" — undefined behaviour, and SwiftUI says so at
    /// runtime. A class lets the memo be filled in place without SwiftUI
    /// treating it as a state change, which is correct here: the cache is a
    /// pure function of `card`, and the view already re-renders when `card`
    /// changes (TranscriptRow is Equatable on it). The box only avoids
    /// re-deriving within a render.
    private final class DerivationBox {
        struct Entry {
            let card: ToolCard
            let running: Bool
            let previewing: Bool
            let derivations: CardDerivations
        }
        var cached: Entry?
    }
    @State private var derivationBox = DerivationBox()

    private var derived: CardDerivations {
        let running = card.state == .running
        if let c = derivationBox.cached, c.card == card, c.running == running,
           c.previewing == previewing {
            return c.derivations
        }
        let d = CardDerivations(
            hunks: inputHunks,
            content: contentText,
            argsPretty: JSONValue.object(card.args).prettyString,
            parts: Self.resultParts(for: card, preview: previewing)
        )
        derivationBox.cached = DerivationBox.Entry(card: card, running: running, previewing: previewing,
                                                   derivations: d)
        return d
    }

    init(card: ToolCard, theme: AppTheme, typography: Typography,
         displayPolicy: ToolDisplayPolicy, hideInputRich: Bool, store: CardUIState, themeID: ThemeID) {
        self.card = card
        self.theme = theme
        self.typography = typography
        self.displayPolicy = displayPolicy
        self.hideInputRich = hideInputRich
        self.store = store
        self.themeID = themeID
        _expanded = State(initialValue: store.expanded(
            card.toolCallID, default: Self.startsExpanded(card, policy: displayPolicy)))
        _showContent = State(initialValue: store.showContent(card.toolCallID))
        _previewing = State(initialValue: Self.startsPreviewing(card, policy: displayPolicy, store: store))
    }

    // MARK: - Shared card derivations (view + prewarm resolver both call these;
    // single source guarantees the warm builds the EXACT producers the card
    // will — identity-keyed slots cannot tolerate mismatches)
    /// The new text an edit/write applies, from persisted args (lang inferred
    /// from the path arg). Nonisolated-safe: pure card data.
    nonisolated static func content(for card: ToolCard) -> (text: String, lang: String?)? {
        // Tool-specific INPUT faces — the call's identity as a snippet,
        // replacing the raw-JSON args face:
        // - codemode (and its earlier name `mcpscript` — older backfilled
        //         transcripts carry that tool name; the JS meta-tool has
        //         been both): the whole call IS a JavaScript snippet
        //         (args.code — args.script as the legacy fallback) —
        //         including its // @options header — rendered as JS.
        // - bash-family: the command as a shell snippet. In BACKFILLED
        //         history this is all a collapsed card could ever hint at,
        //         and raw {"command": …} JSON hid it; live and replay
        //         show the same face.
        let isCodemodeFamily = ToolKinds.isCodemodeFamily(card.tool)
        if isCodemodeFamily,
           let code = stringArg(card.args, ["code", "script"]), !code.isEmpty {
            return (code, "javascript")
        }
        if ToolKinds.isBashFamily(card.tool),
           let command = stringArg(card.args, ["command", "cmd", "script"]),
           !command.isEmpty {
            return (command, "shell")
        }
        // Search tools (pi's grep/find — NOT bash-family: their identity is
        // a pattern, not a command): the search composed as a shell-shaped
        // face so the transcript reads like the bash command face — a grep
        // call rendered as raw args JSON read as "unhighlighted" next to
        // bash's rm/head. Embedded quotes are escaped so the face stays
        // honest shell.
        if card.tool == "grep" || card.tool == "find" {
            let pattern = (stringArg(card.args, ["pattern", "query"]) ?? "")
                .replacingOccurrences(of: "\"", with: "\\\"")
            guard !pattern.isEmpty else { return nil }
            let path = stringArg(card.args, ["path", "glob"]) ?? ""
            let text = "\(card.tool) \"\(pattern)\"\(path.isEmpty ? "" : " \(path)")"
            return (text, "shell")
        }
        for key in ["content", "contents", "text", "new_string", "new_str", "newText"] {
            if let text = card.args[key]?.stringValue, !text.isEmpty {
                return (text, contentLang(for: card))
            }
        }
        let newTexts = editPairs(card.args).compactMap { $0.new }
        if !newTexts.isEmpty {
            return (newTexts.joined(separator: "\n"), contentLang(for: card))
        }
        return nil
    }

    nonisolated static func contentLang(for card: ToolCard) -> String? {
        for key in ["path", "file", "filename", "filepath"] {
            if let path = card.args[key]?.stringValue {
                return ToolKinds.language(forPath: path)
            }
        }
        return nil
    }

    /// The content-face HighlightProducer — EXACTLY as the card builds it
    /// (budget truncation + @source/@source-all identity). nil = no content.
    static func contentProducer(for card: ToolCard, theme: AppTheme,
                                typography: Typography, toolBudget: Int) -> HighlightProducer? {
        guard let content = content(for: card) else { return nil }
        let truncated = content.text.count > toolBudget
        return HighlightProducer(
            code: truncated ? String(content.text.prefix(toolBudget)) : content.text,
            language: content.lang, style: theme.codeHighlightStyle,
            font: typography.monoPlatformFont(),
            identity: "\(card.toolCallID)\u{1}@source" + (truncated ? "" : "-all"))
    }

    /// The hunks the diff face RENDERS: LIVE aux.hunks when present, otherwise
    /// DERIVED from the persisted args. Shared with `inputHunks` so the warm
    /// and the card can't disagree — warming only the live case left replay
    /// sessions (where hunks are always derived) with a cold diff on every
    /// card, which is exactly the cold-scroll case warming exists for.
    nonisolated static func hunks(for card: ToolCard) -> [JSONValue]? {
        // The RECORD first: a settled edit's stored patch (real line numbers;
        // tool faces stage 3). Then the live sidecar, then the stored args.
        if let patch = recordHunks(for: card) { return patch }
        if let hunks = card.hunks, !hunks.isEmpty { return hunks }
        var derived: [JSONValue] = []
        for pair in editPairs(card.args) {
            var lines: [JSONValue] = []
            if let old = pair.old, !old.isEmpty {
                lines += old.split(separator: "\n", omittingEmptySubsequences: false).map {
                    JSONValue.object(["kind": .string("remove"), "text": .string(String($0))])
                }
            }
            if let new = pair.new, !new.isEmpty {
                lines += new.split(separator: "\n", omittingEmptySubsequences: false).map {
                    JSONValue.object(["kind": .string("add"), "text": .string(String($0))])
                }
            }
            if !lines.isEmpty { derived.append(.object(["lines": .array(lines)])) }
        }
        return derived.isEmpty ? nil : derived
    }

    /// A settled edit's hunks from the record's `details.patch`, nil without one.
    nonisolated static func recordHunks(for card: ToolCard) -> [JSONValue]? {
        guard card.state == .ok, case .diff(let hunks?, _) = card.resultView.face,
              !hunks.isEmpty else { return nil }
        return hunks
    }

    /// The DiffProducer face of the input diff: `diff-patch` from the record,
    /// `diff` from the live sidecar or the stored args (different context
    /// lines, so different cache slots).
    nonisolated static func diffFace(for card: ToolCard) -> String {
        recordHunks(for: card) != nil ? "diff-patch" : "diff"
    }


    /// How many 9pt section labels ("DIFF"/"CONTENT"/"input"/"output"/"error")
    /// the expanded body renders — MIRRORS the body's branch structure so the
    /// estimate counts the labels the card draws. Two were invisible to the
    /// estimator before: "DIFF" and "CONTENT" (both short-circuited by the
    /// hunks/content guards), and `hideInputRich` was ignored entirely, so the
    /// "input" label was counted even in the default config that hides it.
    /// Whether the expanded body renders the raw-args "input" section. Shared
    /// so the estimate counts its LINES, not just its label.
    nonisolated static func showsInputSection(for card: ToolCard, hideInputRich: Bool) -> Bool {
        guard hunks(for: card) == nil, content(for: card) == nil,
              !card.args.isEmpty else { return false }
        return !(hideInputRich && card.resultView.isStructured)
    }

    nonisolated static func sectionLabels(for card: ToolCard, hideInputRich: Bool) -> Int {
        let hunks = hunks(for: card)
        let content = content(for: card)
        var n = 0
        if hunks != nil, content != nil {
            n += 1   // switcher renders ONE face; Diff is the default → "DIFF"
        } else {
            if hunks != nil {
                n += 1                       // "DIFF"
            } else if showsInputSection(for: card, hideInputRich: hideInputRich) {
                n += 1                       // "input"
            }
            if content != nil, callFaceLabel(for: card) != nil {
                n += 1                       // "COMMAND" / "SCRIPT"
            } else if hunks == nil, content != nil {
                n += 1                       // "CONTENT"
            }
        }
        // Result rows at the label height: labels, notices, and the "DIFF"
        // label an output diff draws. A preview changes neither (its "more"
        // row counts as a mono line).
        for part in resultParts(for: card) {
            switch part {
            case .label, .notice, .errorNotice, .diff: n += 1
            case .mono, .error, .code, .markdown, .more: break
            }
        }
        return n
    }

    /// The diff-face DiffProducer — live OR derived hunks, same key either way
    /// (`<themeID>\u{1}<toolCallID>\u{1}@diff`).
    static func diffProducer(for card: ToolCard, theme: AppTheme,
                             themeID: ThemeID) -> DiffProducer? {
        guard let hunks = hunks(for: card) else { return nil }
        return DiffProducer(toolCallID: card.toolCallID, themeID: "\(themeID)",
                            face: diffFace(for: card), hunks: hunks,
                            add: theme.success, remove: theme.error, context: theme.secondaryText)
    }

    /// Whether `card` starts open, before any tap: its category's default
    /// (Settings → Tool results; failed calls may always open) is not
    /// Collapsed, AND the card has something to show. Shared by the card, the
    /// height estimator's facts resolver and the tests.
    static func startsExpanded(_ card: ToolCard, policy: ToolDisplayPolicy) -> Bool {
        guard policy.disclosure(for: card) != .collapsed else { return false }
        return isRich(card) || card.result != nil || card.state == .failed
    }

    /// The label of a CALL face — the content face that is the call's own
    /// input (a shell command, a grep/find search, a codemode script) and so
    /// shows WITH the output, not instead of it. nil for an edit/write's new
    /// content, which stands in for a bare success result.
    nonisolated static func callFaceLabel(for card: ToolCard) -> String? {
        if ToolKinds.isCodemodeFamily(card.tool) { return "SCRIPT" }
        if ToolKinds.isBashFamily(card.tool) || card.tool == "grep" || card.tool == "find" {
            return "COMMAND"
        }
        return nil
    }

    /// A card is "rich" when its call has something better than raw JSON to
    /// show: an input diff, a codemode script, a shell-faced command, or new
    /// content from args.
    static func isRich(_ card: ToolCard) -> Bool {
        if let hunks = card.hunks, !hunks.isEmpty { return true }
        // codemode (and legacy mcpscript) is rich BY IDENTITY: its JS snippet
        // is the whole call.
        let isCodemodeFamily = ToolKinds.isCodemodeFamily(card.tool)
        if isCodemodeFamily,
           let code = stringArg(card.args, ["code", "script"]), !code.isEmpty {
            return true
        }
        // So are the shell-faced calls (bash-family commands, grep/find
        // searches): the highlighted command is the call, so "Expand rich
        // tool results" opens them like edits and codemode.
        if content(for: card)?.lang == "shell" { return true }
        for key in ["content", "contents", "text", "new_string", "new_str", "newText"] {
            if let value = card.args[key]?.stringValue, !value.isEmpty { return true }
        }
        // edits[]-shaped edit tools (run 2026-09-18: cards rendered as raw
        // JSON — the new text nests inside edits[].newText, which none of the
        // top-level keys above can see).
        if !editPairs(card.args).isEmpty { return true }
        return false
    }

    /// First non-empty string arg among `keys` (static: shared by isRich and
    /// the instance views).
    nonisolated static func stringArg(_ dict: [String: JSONValue], _ keys: [String]) -> String? {
        for key in keys {
            if let s = dict[key]?.stringValue, !s.isEmpty { return s }
        }
        return nil
    }

    /// The edit args' old/new pairs — BOTH shapes: a single edit at the top
    /// level (camelCase + snake_case variants) and the `edits[]` array of
    /// pairs. Empty when the args aren't edit-shaped.
    /// Nonisolated: pure derivation over card args, so the estimator (which
    /// builds facts outside the main actor) can share the view's exact logic.
    nonisolated static func editPairs(_ args: [String: JSONValue]) -> [(old: String?, new: String?)] {
        var pairs: [(old: String?, new: String?)] = []
        func pair(_ dict: [String: JSONValue]) -> (String?, String?)? {
            let old = stringArg(dict, ["oldText", "old_text", "old_string", "oldString"])
            let new = stringArg(dict, ["newText", "new_text", "new_string", "newString"])
            return (old != nil || new != nil) ? (old, new) : nil
        }
        if case .array(let edits)? = args["edits"] {
            for case .object(let e) in edits {
                if let p = pair(e) { pairs.append(p) }
            }
        } else if let p = pair(args) {
            pairs.append(p)
        }
        return pairs
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 6) {
                    if let hunks = derived.hunks, let content = derived.content {
                        // Both present (live edit): toggle between the diff and
                        // the new text as a code block. Default Diff. A lightweight
                        // SwiftUI toggle, NOT .pickerStyle(.segmented) — a segmented
                        // Picker bridges to a UISegmentedControl, and constructing
                        // that UIKit view on every husk→full attach is what hitched
                        // the scroll-in of edit cards.
                        DiffContentToggle(showContent: $showContent, theme: theme)
                        // Warm the OTHER (hidden) face through the SAME windowed,
                        // appearance-driven path as the visible one (renders
                        // nothing) so switching shows the ready result, not the
                        // plain-then-highlight pop.
                        WarmAttributedText(producer: showContent
                            ? (diffProducer(hunks) as any AttributedTextProducer)
                            : contentProducer(content))
                        if showContent {
                            codeView(content.text, lang: content.lang,
                                     identity: "\(card.toolCallID)\u{1}@source")
                        } else {
                            diffView(hunks, face: Self.diffFace(for: card))
                        }
                    } else {
                        if let hunks = derived.hunks {
                            diffView(hunks, face: Self.diffFace(for: card))
                        } else if Self.showsInputSection(for: card, hideInputRich: hideInputRich) {
                            labeled("input", derived.argsPretty)
                        }
                        if let face = derived.content, let callLabel = Self.callFaceLabel(for: card) {
                            // A call face (shell command, search, codemode
                            // script) is the call's input; its result follows.
                            VStack(alignment: .leading, spacing: 2) {
                                Text(callLabel).font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(theme.secondaryText)
                                codeView(face.text, lang: face.lang)
                            }
                        } else if derived.hunks == nil, let content = derived.content {
                            // A write's new text, from the stored args.
                            VStack(alignment: .leading, spacing: 2) {
                                Text("CONTENT").font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(theme.secondaryText)
                                codeView(content.text, lang: content.lang)
                            }
                        }
                    }
                    // An agent's task (Settings: Show agent prompts), then the
                    // RESULT, resolved from the tool's spec (both shared with
                    // the height estimator).
                    resultView(Self.promptParts(for: card, show: displayPolicy.showAgentPrompts))
                    resultView(derived.parts)
                }
                .font(typography.monoFont(size: typography.codeSize))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: icon).foregroundStyle(color)
                    // Tool-name header row — natural height ≈ TranscriptMetrics
                    // .toolCardHeaderHeight: CHANGE THAT CONSTANT if the callout
                    // font/size changes (ESTIMATE-ONLY — no literal to share).
                    Text(card.tool).font(.callout.weight(.medium)).foregroundStyle(theme.text)
                    // What the call acts on (a read's path:range, an MCP
                    // call's proxied tool), smaller, on the same line (one
                    // line, so the header height is unchanged).
                    if let subtitle = Self.headerSubtitle(for: card) {
                        Text(subtitle.text).font(.caption).foregroundStyle(theme.secondaryText)
                            .lineLimit(1).truncationMode(subtitle.isPath ? .head : .middle)
                    }
                    // How long a settled call ran (pi's "Took …"), same line.
                    if card.state != .running, let took = Self.durationText(card.durationMs) {
                        Spacer(minLength: 4)
                        Text(took).font(.caption2.monospacedDigit()).foregroundStyle(theme.secondaryText)
                            .lineLimit(1).fixedSize()
                    }
                }
            }
            .tint(theme.toolAccent)
            // Tool-emitted images (screenshots/plots) sit below the card, always
            // visible so you don't have to expand to see them.
            ForEach(Array(card.images.enumerated()), id: \.offset) { _, image in
                WireImageView(image: image, theme: theme)
            }
        }
        .padding(10)
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 10))
        // Persist toggles back to the windowing-surviving store (write-only on
        // change — never per-render).
        .onChange(of: expanded) { _, value in
            store.setExpanded(card.toolCallID, value,
                              default: Self.startsExpanded(card, policy: displayPolicy))
        }
        .onChange(of: showContent) { _, value in store.setShowContent(card.toolCallID, value) }
        .onChange(of: previewing) { _, value in if !value { store.setShowsAll(card.toolCallID) } }
        // The default moves when the card settles (a running read has nothing
        // to show yet; a failed call may always open) or Settings change. A
        // card the user hasn't overridden follows it, as the estimator does.
        .onChange(of: Self.startsExpanded(card, policy: displayPolicy)) { _, value in
            if !store.hasExpandedOverride(card.toolCallID) { expanded = value }
        }
        .onChange(of: displayPolicy) { _, policy in
            previewing = Self.startsPreviewing(card, policy: policy, store: store)
        }
    }

    // The content key matches codeView's BudgetedContent truncation, so the warm
    // hits the exact key the toggle will read.
    private func diffProducer(_ hunks: [JSONValue]) -> DiffProducer {
        DiffProducer(toolCallID: card.toolCallID, themeID: "\(themeID)",
                     face: Self.diffFace(for: card), hunks: hunks,
                     add: theme.success, remove: theme.error, context: theme.secondaryText)
    }

    private func contentProducer(_ content: (text: String, lang: String?)) -> HighlightProducer {
        let truncated = content.text.count > toolBudget
        // Warm the INITIALLY-shown key: @source when it'll truncate, else the
        // full @source-all (matches codeView's initial render). The other key
        // materializes on demand if the user hits Show all.
        return HighlightProducer(
            code: truncated ? String(content.text.prefix(toolBudget)) : content.text,
            language: content.lang, style: theme.codeHighlightStyle,
            font: typography.monoPlatformFont(),
            identity: "\(card.toolCallID)\u{1}@source" + (truncated ? "" : "-all"))
    }

    // Input Edit diff: LIVE aux.hunks when present; otherwise DERIVED from
    // the persisted args (replay never carries sidecars — and run 2026-09-18
    // the live wire didn't either). The derivation shows the edit's substance
    // (− old / + new) without the on-disk context lines the extension adds.
    private var inputHunks: [JSONValue]? { Self.hunks(for: card) }

    // The new text an edit/write is applying, from persisted args — the Content
    // view / replay floor. `lang` inferred from the target file path. For
    // edits[]-shaped tools the new texts nest inside the array — join them.
    private var contentText: (text: String, lang: String?)? {
        Self.content(for: card)
    }

    private var contentLang: String? {
        Self.contentLang(for: card)
    }

    // Colored diff via the shared windowed cache (DiffProducer). The card's
    // diff is immutable, so it's produced once (per theme) and reused across
    // materializations — same cache + off-main pull as code blocks; only the
    // production differs (platform-colored lines vs highlight.js).
    func diffView(_ hunks: [JSONValue], face: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("DIFF").font(.system(size: 9, weight: .bold))
                .foregroundStyle(theme.secondaryText)
            AsyncAttributedText(producer: DiffProducer(
                toolCallID: card.toolCallID, themeID: "\(themeID)", face: face, hunks: hunks,
                add: theme.success, remove: theme.error, context: theme.secondaryText))
        }
    }

    private func labeled(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            // Section-label row — natural height ≈ TranscriptMetrics
            // .toolCardSectionLabelHeight: CHANGE THAT CONSTANT if this label
            // style changes (ESTIMATE-ONLY — no literal to share).
            Text(label.uppercased()).font(.system(size: 9, weight: .bold))
                .foregroundStyle(theme.secondaryText)
            BudgetedContent(text: value, budget: toolBudget) { budgeted in
                Text(budgeted).foregroundStyle(theme.text).textSelection(.enabled)
            }
        }
    }


    // Syntax-highlighted code via the shared windowed cache (HighlightProducer,
    // HighlighterSwift/highlight.js). `lang` may be nil → highlight.js
    // auto-detects. Budget applies BEFORE highlighting (toolBudget).
    // Assistant-bubble fences stay sync-on-miss: MarkdownUI's
    // CodeSyntaxHighlighter protocol is synchronous — same cache, cache-covered
    // after first render.
    @ViewBuilder
    func codeView(_ text: String, lang: String?, identity: String? = nil) -> some View {
        let font = typography.monoPlatformFont()
        BudgetedContent(text: text, budget: toolBudget) { budgeted in
            // Two stable id keys: @source (truncated view) vs @source-all (full,
            // after Show all). The full view isn't pre-warmed, so it materializes
            // on demand the first time it's expanded.
            let id = identity.map { budgeted.count >= text.count ? "\($0)-all" : $0 }
            AsyncAttributedText(producer: HighlightProducer(
                code: budgeted, language: lang, style: theme.codeHighlightStyle,
                font: font, identity: id))
        }
    }

    private var icon: String {
        switch card.state {
        case .running: return "gearshape.2"
        case .ok: return "checkmark.circle"
        case .failed: return "xmark.octagon"
        }
    }

    private var color: Color {
        switch card.state {
        case .running: return theme.secondaryText
        case .ok: return theme.success
        case .failed: return theme.error
        }
    }
}
