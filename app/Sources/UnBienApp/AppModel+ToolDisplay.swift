import Foundation
import UnBienCore

// Persistence for the tool-card display defaults (Settings → Tool results).
// The policy is stored as JSON. An install that predates it inherits from the
// former single "Expand rich tool results" toggle: off means every card starts
// closed, failed calls included (as 1.5 behaved); on (or never set) means the
// standard defaults.
extension AppModel {
    // nonisolated: UserDefaults + pure values only, no model state.
    nonisolated static let toolDisplayPolicyKey = "com.georgeharker.un-bien.tool-display-policy"
    /// The former boolean preference, read only to migrate it.
    nonisolated static let legacyExpandRichKey = "com.georgeharker.un-bien.expand-rich-tool-results"

    nonisolated static func loadToolDisplayPolicy(_ defaults: UserDefaults = .standard) -> ToolDisplayPolicy {
        if let data = defaults.data(forKey: toolDisplayPolicyKey),
           let policy = try? JSONDecoder().decode(ToolDisplayPolicy.self, from: data) {
            return policy
        }
        if defaults.object(forKey: legacyExpandRichKey) as? Bool == false {
            var closed = ToolDisplayPolicy.allCollapsed
            closed.expandFailed = false
            return closed
        }
        return .standard
    }

    nonisolated static func saveToolDisplayPolicy(_ policy: ToolDisplayPolicy,
                                                  _ defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(policy) {
            defaults.set(data, forKey: toolDisplayPolicyKey)
        }
    }
}
