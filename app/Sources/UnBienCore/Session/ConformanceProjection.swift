import Foundation

/// Conformance-corpus normalizer (design 01M25GXCQ3W7NKB2DJ4RM9T8EHW): projects
/// the interpreted state (`SessionState`) into the shared normalized vocabulary
/// (contracts/conformance/vocab.md) that BOTH implementations — this Swift
/// reducer and remote_pi's TS fork interpretation — serialize to and assert
/// against. Deliberately dumb and deterministic: no clocks, no UUIDs, scrubbed
/// in place (readable, 48-char truncate), synthetic ids replaced by
/// kind-sequence placeholders. The projection IS the contract; extend
/// vocab.md first, this type and the TS side in the same commit.
public enum Conformance {
    /// Text scrub limit (chars) — spec vocab.md "Text scrub, in place, readable".
    public static let textLimit = 48

    /// In-place scrub: newlines → `\n` literals, truncate at `textLimit` with
    /// `…`. ANSI and unstable payloads never reach the expected file here —
    /// tool payloads are shape-only (block kinds + counts).
    public static func scrub(_ text: String) -> String {
        var stripped = ""
        var escaped = false
        for ch in text {
            if ch == "\u{1B}" { escaped = true; continue }
            if escaped {
                if ch == "m" { escaped = false }
                continue
            }
            if ch == "\n" { stripped.append("\\n"); continue }
            if ch == "\r" { continue }
            stripped.append(ch)
        }
        if stripped.count <= textLimit { return stripped }
        return String(stripped.prefix(textLimit)) + "…"
    }

    /// Synthetic-id detection: live placeholders mint as `a-`/`u-`/`r-` +
    /// UUID (the dash marks the synthetic id-space; pi entry ids are bare hex).
    static func isSynthetic(_ id: String) -> Bool {
        id.hasPrefix("a-") || id.hasPrefix("u-") || id.hasPrefix("r-")
    }
}

public extension SessionState {
    /// Normalized interpreted state — the artifact both implementations deep-equal
    /// against a scenario's `expected.json` (contracts/conformance/vocab.md v1).
    func conformanceProjection() -> JSONValue {
        var rows: [JSONValue] = []
        var syntheticSeq: [String: Int] = [:]

        // Row-id: entry id when replay-stable (stable hex — identical across
        // live/replay), else a deterministic `<kind>#<seq>` placeholder by
        // order of appearance (synthetic ids are UUIDs across runs).
        func rowID(kind: String, id: String, replayStable: Bool) -> JSONValue {
            if replayStable, !id.isEmpty {
                return .string(Conformance.scrub(id))
            }
            let seq = (syntheticSeq[kind] ?? 0) + 1
            syntheticSeq[kind] = seq
            return .string("\(kind)#\(seq)")
        }

        for item in items {
            switch item {
            case let .user(bubble):
                rows.append(.object([
                    "kind": .string("user"),
                    "row": rowID(kind: "user", id: bubble.id, replayStable: bubble.replayStable),
                    "text": .string(Conformance.scrub(bubble.text)),
                    "images": .number(Double(bubble.images.count)),
                ]))
            case let .assistant(bubble):
                rows.append(.object([
                    "kind": .string("assistant"),
                    "row": rowID(kind: "assistant", id: bubble.id, replayStable: bubble.replayStable),
                    "text": .string(Conformance.scrub(bubble.text)),
                    "streaming": .bool(bubble.streaming),
                    "images": .number(Double(bubble.images.count)),
                ]))
            case let .reasoning(block):
                rows.append(.object([
                    "kind": .string("reasoning"),
                    "row": rowID(kind: "reasoning", id: block.id, replayStable: false),
                    "text": .string(Conformance.scrub(block.text)),
                    "streaming": .bool(block.streaming),
                ]))
            case let .tool(card):
                var blocks: [JSONValue] = []
                if let output = card.output, let arr = output["blocks"]?.arrayValue {
                    for block in arr {
                        blocks.append(.string(block["kind"]?.stringValue ?? "?"))
                    }
                }
                if card.hunks != nil { blocks.append(.string("hunks")) }
                let state: String
                switch card.state {
                case .running: state = "running"
                case .ok: state = "ok"
                case .failed: state = "failed"
                }
                rows.append(.object([
                    "kind": .string("tool"),
                    "row": rowID(kind: "tool", id: card.toolCallID, replayStable: true),
                    "tool": .string(Conformance.scrub(card.tool)),
                    "state": .string(state),
                    "blocks": .array(blocks),
                    "images": .number(Double(card.images.count)),
                ]))
            case let .compaction(marker):
                rows.append(.object([
                    "kind": .string("compaction"),
                    "row": rowID(kind: "compaction", id: marker.id, replayStable: true),
                ]))
            case let .notice(notice):
                rows.append(.object([
                    "kind": .string("notice"),
                    "row": rowID(kind: "notice", id: notice.id, replayStable: true),
                    "code": .string(Conformance.scrub(notice.code)),
                    "text": .string(Conformance.scrub(notice.message)),
                ]))
            }
        }

        let flags: [String: JSONValue] = [
            "streaming": .bool(activeTurnID != nil),
            "ended": .bool(ended),
        ]
        return .object([
            "version": .number(1),
            "items": .array(rows),
            "flags": .object(flags),
        ])
    }
}
public extension EnvelopeReducer {
    /// Reducer-level projection: the session items/flags PLUS the {evt}-plane
    /// and extension_ui side-state (subagents panel, plan snapshot, pending
    /// asks). Scenarios that exercise panels/asks assert against these fields.
    func conformanceProjection() -> JSONValue {
        var base = session.conformanceProjection()
        guard case .object(var obj) = base else { return base }

        var subagents: [JSONValue] = []
        for entry in self.subagents {
            var sub: [String: JSONValue] = [
                "id": .string(Conformance.scrub(entry.id)),
                "status": .string(entry.status),
            ]
            if let type = entry.type { sub["type"] = .string(Conformance.scrub(type)) }
            if let description = entry.description {
                sub["description"] = .string(Conformance.scrub(description))
            }
            if let result = entry.result { sub["result"] = .string(Conformance.scrub(result)) }
            if let error = entry.error { sub["error"] = .string(Conformance.scrub(error)) }
            subagents.append(.object(sub))
        }
        obj["subagents"] = .array(subagents)

        if let plan {
            obj["plan"] = .object([
                "project": plan.project.map { .string(Conformance.scrub($0)) } ?? .null,
                "itemCount": .number(Double(plan.itemCount)),
            ])
        }

        var asks: [JSONValue] = []
        for ask in pendingAsks {
            var askObj: [String: JSONValue] = [
                "id": .string(Conformance.scrub(ask.id)),
                "method": .string(ask.method),
            ]
            if let title = ask.title { askObj["title"] = .string(Conformance.scrub(title)) }
            if let options = ask.options {
                askObj["options"] = .array(options.map { .string(Conformance.scrub($0)) })
            }
            asks.append(.object(askObj))
        }
        if !asks.isEmpty { obj["pendingAsks"] = .array(asks) }

        obj["leafId"] = leafId.map { .string(Conformance.scrub($0)) } ?? .null
        base = .object(obj)
        return base
    }
}
