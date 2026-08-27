import Foundation

/// One inline image attachment on a `user_message` (DESIGN §4).
public struct WireImage: Codable, Equatable, Sendable {
    /// Base64-encoded image bytes.
    public let data: String
    /// MIME type, e.g. `"image/jpeg"`.
    public let mime: String

    public init(data: String, mime: String) {
        self.data = data
        self.mime = mime
    }
}

public struct Usage: Codable, Equatable, Sendable {
    public let inputTokens: Int
    public let outputTokens: Int

    public init(inputTokens: Int, outputTokens: Int) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }

    enum CodingKeys: String, CodingKey {
        case inputTokens = "input_tokens"
        case outputTokens = "output_tokens"
    }
}

/// Mirror of the SDK's `ThinkingLevel` (DESIGN §4, `thinking_set`).
public enum ThinkingLevel: String, Codable, Sendable, CaseIterable {
    case off, minimal, low, medium, high, xhigh
}

/// Stable names for typed app actions (`action_ok`/`action_error`).
public enum ActionName: String, Codable, Sendable {
    case sessionNew = "session_new"
    case sessionCompact = "session_compact"
    case modelSet = "model_set"
    case thinkingSet = "thinking_set"
}

/// One model entry in the app's model picker (`models_list`).
public struct WireModel: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let provider: String
    public let reasoning: Bool
    public let contextWindow: Int
    public let vision: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, provider, reasoning
        case contextWindow = "context_window"
        case vision
    }
}

public enum ByeReason: String, Codable, Sendable {
    case peerStop = "peer_stop"
    case sessionReplaced = "session_replaced"
    case shutdown
}

public enum PairErrorCode: String, Codable, Sendable {
    case tokenExpired = "token_expired"
    case tokenConsumed = "token_consumed"
    case tokenUnknown = "token_unknown"
    case internalError = "internal_error"
}

/// Identifies the host coding agent driving a pi-extension instance (`pair_ok`).
public struct Harness: Codable, Equatable, Sendable {
    public let name: String
    public let version: String
}
