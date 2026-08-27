import Foundation

/// Mirrors the reference `DecodeError` (codec.ts): a decode either fails
/// because the input isn't a valid tagged message (`invalidMessage`) or names
/// a `type` this side doesn't accept (`unsupportedType`).
public enum DecodeError: Error, Equatable {
    case invalidMessage(String)
    case unsupportedType(String)
}

/// The set of `type` tags accepted by ``decodeServer`` — mirrors `SERVER_TYPES`
/// in codec.ts (the closed set the app is allowed to receive as an application
/// message). Extra Pi→App types present in the protocol but absent from the
/// reference set are included here where the app renders them.
private let serverTypes: Set<String> = [
    "pair_ok", "pair_error", "user_input", "user_message", "queued_message_state",
    "steer_consumed", "agent_chunk", "agent_reasoning", "agent_done",
    "agent_message", "compaction",
    "tool_request", "tool_result", "error", "cancelled", "pong", "bye",
    "session_history", "action_ok", "action_error", "models_list",
    "extension_ui_request", "panel_update",
]

public enum Codec {
    private static let encoder: JSONEncoder = {
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        return enc
    }()
    private static let decoder = JSONDecoder()

    /// Encode a ``ClientMessage`` to a single JSONL line (trailing `\n`),
    /// matching `encodeClient` in codec.ts.
    public static func encodeClient(_ message: ClientMessage) throws -> String {
        let data = try encoder.encode(message)
        guard let json = String(data: data, encoding: .utf8) else {
            throw DecodeError.invalidMessage("encoding failed")
        }
        return json + "\n"
    }

    /// The compact JSON body of a ``ClientMessage`` (no trailing newline) — the
    /// exact bytes placed in a ``RoutedEnvelope`` `ct` (base64 of this).
    public static func encodeClientBody(_ message: ClientMessage) throws -> Data {
        try encoder.encode(message)
    }

    /// Decode one JSONL line into a ``ServerMessage``, mirroring `decodeServer`:
    /// invalid JSON or a missing `type` → `invalidMessage`; an unknown `type`
    /// → `unsupportedType`.
    public static func decodeServer(_ line: String) throws -> ServerMessage {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8) else {
            throw DecodeError.invalidMessage("not UTF-8")
        }
        let tag: String
        do {
            let object = try JSONSerialization.jsonObject(with: data)
            guard let dict = object as? [String: Any] else {
                throw DecodeError.invalidMessage("missing 'type'")
            }
            guard let type = dict["type"] as? String else {
                throw DecodeError.invalidMessage("missing 'type'")
            }
            tag = type
        } catch let error as DecodeError {
            throw error
        } catch {
            throw DecodeError.invalidMessage("not JSON: \(error.localizedDescription)")
        }
        guard serverTypes.contains(tag) else {
            throw DecodeError.unsupportedType("unknown type: \(tag)")
        }
        return try decoder.decode(ServerMessage.self, from: data)
    }
}
