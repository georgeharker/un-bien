import Foundation

/// One inner-channel message on the rpc-envelope (see docs/rpc-envelope.md):
/// a verbatim pi rpc frame and/or an ephemeral forwarded bus event. At least
/// one of `rpc` / `evt` is present.
public struct EnvelopeMessage: Codable, Sendable {
    /// Protocol-namespace discriminator: `"rpc"` / `"evt"` / `"un"` (legacy
    /// `"env"` accepted on read during the transition). Names the payload plane;
    /// direction is carried by the inner frame `.type` + receiver, not here.
    public let type: String?
    /// Epoch ms stamped at send (ordering/debug). Cross-cutting.
    public let ts: Double?
    /// Envelope/pi-rpc protocol version for decode-guarding. Cross-cutting.
    public let protocolVersion: Int?
    public let rpc: JSONValue?
    public let evt: EnvelopeEvt?
    /// un-bien's own protocol plane (`type == "un"`): an inner frame with its own
    /// `.type` (hello / session_sync / session_launch / …). Handshake caps +
    /// sessionId nest inside the `hello` inner frame, NOT at the top level.
    public let un: JSONValue?
    /// Optional bidirectional sidecar carried ALONGSIDE `rpc`/`evt`/`un` (e.g.
    /// pre-rendered Edit-diff `hunks` for a `tool_execution_start` frame).
    /// Absent on most frames — decode must tolerate its absence.
    public let aux: JSONValue?

    public init(type: String? = nil, ts: Double? = nil, protocolVersion: Int? = nil,
                rpc: JSONValue? = nil, evt: EnvelopeEvt? = nil, un: JSONValue? = nil,
                aux: JSONValue? = nil) {
        self.type = type
        self.ts = ts
        self.protocolVersion = protocolVersion
        self.rpc = rpc
        self.evt = evt
        self.un = un
        self.aux = aux
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
