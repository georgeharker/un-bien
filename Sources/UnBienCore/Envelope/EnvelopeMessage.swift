import Foundation

/// One inner-channel message on the rpc-envelope (see docs/rpc-envelope.md):
/// a verbatim pi rpc frame and/or an ephemeral forwarded bus event. At least
/// one of `rpc` / `evt` is present.
public struct EnvelopeMessage: Decodable, Sendable {
    public let rpc: JSONValue?
    public let evt: EnvelopeEvt?

    public init(rpc: JSONValue? = nil, evt: EnvelopeEvt? = nil) {
        self.rpc = rpc
        self.evt = evt
    }
}

/// The `{evt}` plane: an ephemeral, non-persisted in-process bus event
/// (`plan:*` / `subagents:*`) the fork forwards. Never on `pi --mode rpc` stdout.
public struct EnvelopeEvt: Decodable, Sendable {
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
}
