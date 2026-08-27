import Foundation

/// One inner-channel message on the rpc-envelope (see docs/rpc-envelope.md):
/// a verbatim pi rpc frame and/or an ephemeral forwarded bus event. At least
/// one of `rpc` / `evt` is present.
public struct EnvelopeMessage: Codable, Sendable {
    /// Wrapper-kind discriminator: `"env"` = session {rpc|evt} plane, `"hello"`
    /// = capability handshake. Absent on a stock ServerMessage body.
    public let type: String?
    /// Epoch ms stamped at send (ordering/debug).
    public let ts: Double?
    /// Handshake (`type == "hello"`): the fork's advertised capabilities.
    public let caps: [String]?
    /// Handshake: stable pi session id — disambiguates reused session names.
    public let sessionId: String?
    public let rpc: JSONValue?
    public let evt: EnvelopeEvt?

    public init(type: String? = nil, ts: Double? = nil, caps: [String]? = nil,
                sessionId: String? = nil, rpc: JSONValue? = nil, evt: EnvelopeEvt? = nil) {
        self.type = type
        self.ts = ts
        self.caps = caps
        self.sessionId = sessionId
        self.rpc = rpc
        self.evt = evt
    }
}

/// The `{evt}` plane: an ephemeral, non-persisted in-process bus event
/// (`plan:*` / `subagents:*`) the fork forwards. Never on `pi --mode rpc` stdout.
public struct EnvelopeEvt: Codable, Sendable {
    public let channel: String
    public let data: JSONValue
}

/// Ergonomic accessors for digging into opaque `rpc` frames.
public extension JSONValue {
    var stringValue: String? { if case .string(let s) = self { return s } else { return nil } }
    var doubleValue: Double? { if case .number(let n) = self { return n } else { return nil } }
    var intValue: Int? { doubleValue.map { Int($0) } }
    var boolValue: Bool? { if case .bool(let b) = self { return b } else { return nil } }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a } else { return nil } }
    var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o } else { return nil } }

    /// Object member access; nil when this isn't an object or the key is absent.
    subscript(_ key: String) -> JSONValue? { objectValue?[key] }

    /// Concatenated text of a message `content`: a bare string (custom messages)
    /// or an array of `{type:"text", text}` blocks (assistant/user/toolResult).
    func joinedText() -> String {
        if case .string(let string) = self { return string }
        guard case .array(let blocks) = self else { return "" }
        return blocks.compactMap { block in
            block["type"]?.stringValue == "text" ? block["text"]?.stringValue : nil
        }.joined()
    }
}

public extension String {
    /// Strip CSI SGR color sequences (`ESC[...m`) that extension status/widget/
    /// title text carries.
    func strippingANSI() -> String {
        replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
    }
}
