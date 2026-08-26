import Foundation

/// pi-ask's rich clarification-flow schema, carried in the optional `ask`
/// envelope of an `extension_ui_request`/`extension_ui_response` (DESIGN §4).
/// Frame-level keys are snake_case (`flow_id`, `tool_call_id`); the answer keys
/// mirror pi-ask VERBATIM in camelCase (`customText`, `optionNotes`).

public enum AskQuestionType: String, Codable, Sendable {
    case single, multi, preview
}

public struct AskOption: Codable, Equatable, Sendable, Identifiable {
    public let value: String
    public let label: String
    public let description: String?
    /// Preview-pane content (preview questions only).
    public let preview: String?
    /// Option allows freeform custom entry.
    public let freeform: Bool?

    public var id: String { value }
}

public struct AskQuestion: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let prompt: String
    public let type: AskQuestionType
    public let required: Bool
    public let presentedType: AskQuestionType?
    public let requestedType: AskQuestionType?
    public let options: [AskOption]

    /// The type actually presented (post live-toggle/policy), falling back to
    /// the requested type.
    public var effectiveType: AskQuestionType { presentedType ?? type }
}

/// Enrichment on an `extension_ui_request` — the full flow to render.
public struct AskEnrichment: Codable, Equatable, Sendable {
    public let flowID: String
    public let toolCallID: String?
    public let source: String
    public let title: String?
    public let questions: [AskQuestion]

    enum CodingKeys: String, CodingKey {
        case flowID = "flow_id"
        case toolCallID = "tool_call_id"
        case source, title, questions
    }

    /// Decode from the request's opaque `ask` JSON value.
    public static func from(_ json: JSONValue?) -> AskEnrichment? {
        guard let json, let data = try? JSONEncoder().encode(json) else { return nil }
        return try? JSONDecoder().decode(AskEnrichment.self, from: data)
    }
}

/// One question's answer (camelCase keys, VERBATIM pi-ask).
public struct AskAnswer: Codable, Equatable, Sendable {
    public var values: [String]?
    public var customText: String?
    public var note: String?
    public var optionNotes: [String: String]?

    public init(values: [String]? = nil, customText: String? = nil,
                note: String? = nil, optionNotes: [String: String]? = nil) {
        self.values = values
        self.customText = customText
        self.note = note
        self.optionNotes = optionNotes
    }
}

/// Enrichment on an `extension_ui_response` — the structured answer or a cancel.
public struct AskResponseEnrichment: Codable, Equatable, Sendable {
    public let flowID: String
    public let kind: Kind
    public let mode: Mode?
    public let answers: [String: AskAnswer]?

    public enum Kind: String, Codable, Sendable { case answer, cancel }
    public enum Mode: String, Codable, Sendable { case submit, elaborate }

    enum CodingKeys: String, CodingKey {
        case flowID = "flow_id"
        case kind, mode, answers
    }

    public static func answer(flowID: String, answers: [String: AskAnswer],
                              mode: Mode = .submit) -> AskResponseEnrichment {
        AskResponseEnrichment(flowID: flowID, kind: .answer, mode: mode, answers: answers)
    }

    public static func cancel(flowID: String) -> AskResponseEnrichment {
        AskResponseEnrichment(flowID: flowID, kind: .cancel, mode: nil, answers: nil)
    }

    /// Encode to the opaque `ask` JSON value carried on the response.
    public func toJSONValue() -> JSONValue? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }
}
