import SwiftUI

/// The globally-unique identity of the session whose transcript is rendering
/// (`LiveSession.id` = relayID:peer:sessionID). Set once at the transcript root
/// and read by the PROCESS-WIDE render caches (`MarkdownEntityStore.shared`,
/// `AttributedTextCache.shared`) so their keys carry the session.
///
/// WHY: bubble ids are session-LOCAL seq counters ("a0", "0", "ext0", …) that
/// restart at the same values in every session, and the caches are singletons —
/// so an un-scoped key collides across chats and one session renders another's
/// content (design 01M21JSKJB, a real cross-session bleed). Scoping the key is
/// the bulletproof guarantee at the shared-singleton boundary, independent of
/// whether any given id is globally unique.
private struct SessionScopeKey: EnvironmentKey {
    static let defaultValue = ""
}

extension EnvironmentValues {
    var sessionScope: String {
        get { self[SessionScopeKey.self] }
        set { self[SessionScopeKey.self] = newValue }
    }
}
