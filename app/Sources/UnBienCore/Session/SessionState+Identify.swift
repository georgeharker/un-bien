import Foundation

// Message-intrinsic identity + content signatures. Pure static helpers (no
// instance state) split into their own file to keep SessionState.swift within
// its size budget.
extension SessionState {
    /// A stable, message-INTRINSIC identity from the pi message's own fields —
    /// identical on the live `message_end` and on an entry replay of the same
    /// message, so re-sync dedups instead of duplicating (pi messages carry no
    /// id; design 01M15FMQ). hash(role|timestamp|contentSignature) — and
    /// DELIBERATELY NOTHING FROM THE VENDOR: `responseId` was trusted here once
    /// and providers reuse ids (one real ollama-cloud session had 426 of 744
    /// responseIds shared across different messages, the worst 8-way) — every
    /// message sharing a rid became "the same message" to the match loop, its
    /// birth eaten by a re-key, invisible forever through healthy
    /// walks/caches/derives (the missing-post-tool-prose mystery, live-caught
    /// and reproduced against the real log). The message's own fields
    /// disambiguate everything the rid ever did: same content at the same
    /// timestamp IS the same message; different content or time is not. The
    /// durable identity is pi's ENTRY id anyway — identify is only the
    /// live-frame-to-entry bridge, trusted once per row.
    static func identify(_ message: JSONValue?) -> String {
        let role = message?["role"]?.stringValue ?? "?"
        let ts = message?["timestamp"]?.intValue ?? 0
        let sig = contentSignature(message?["content"])
        return "m\(stableHash("\(role)|\(ts)|\(sig)"))"
    }

    /// Canonical, order-preserving signature of a message `content` (array or a
    /// bare user string). Includes tool-call ids so tool-only messages don't
    /// collide on empty text. Deterministic across launches (avoids `Hasher`).
    static func contentSignature(_ content: JSONValue?) -> String {
        guard let blocks = content?.arrayValue else { return content?.stringValue ?? "" }
        return blocks.map { block in
            switch block["type"]?.stringValue ?? "" {
            case "text": return "t:" + (block["text"]?.stringValue ?? "")
            case "thinking": return "k:" + (block["thinking"]?.stringValue ?? "")
            case "toolCall": return "c:" + (block["id"]?.stringValue ?? "") + ":" + (block["name"]?.stringValue ?? "")
            case "image": return "i:" + (block["mimeType"]?.stringValue ?? "")
            case let other: return other
            }
        }.joined(separator: "\n")
    }

    /// Deterministic FNV-1a over UTF-8, base-36 — stable across processes so
    /// `identify` matches on a relaunched app's re-sync.
    static func stableHash(_ s: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in s.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 36)
    }

    /// Image blocks (`{type:"image", data, mimeType}`) from a message `content`.
    static func imagesFromContent(_ content: JSONValue?) -> [WireImage] {
        guard let blocks = content?.arrayValue else { return [] }
        return blocks.compactMap { block in
            guard block["type"]?.stringValue == "image",
                  let data = block["data"]?.stringValue,
                  let mime = block["mimeType"]?.stringValue else { return nil }
            return WireImage(data: data, mime: mime)
        }
    }

    /// Images from a `tool_execution_end` result — the live result is a wrapper
    /// `{content:[...], details}`; unwrap `content` first.
    static func imagesFromToolResult(_ value: JSONValue?) -> [WireImage] {
        if value?.arrayValue != nil { return imagesFromContent(value) }
        if let content = value?["content"] { return imagesFromContent(content) }
        return []
    }
}
