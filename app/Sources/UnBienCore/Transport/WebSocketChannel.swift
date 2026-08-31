import Foundation

/// Minimal text-frame WebSocket abstraction so ``RelayConnection`` can be
/// driven by a real `URLSessionWebSocketTask` in the app and by a fake in
/// tests. One `send`/`receive` maps to one WS text frame (JSONL semantics).
public protocol WebSocketChannel: Sendable {
    func send(_ text: String) async throws
    /// Await the next inbound text frame. Throws on close/error.
    func receive() async throws -> String
    func close()
}

/// `URLSessionWebSocketTask`-backed channel. Works on iOS and macOS.
public final class URLSessionWebSocketChannel: WebSocketChannel, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    /// URLSessionWebSocketTask's DEFAULT maximumMessageSize is 1 MiB — an
    /// inbound frame above it makes `receive()` throw and the frame is silently
    /// dropped (this is exactly how a long session's get_entries backfill
    /// vanished; design: get_entries backfill paging). Raise it so single
    /// frames up to the relay's 4 MiB outer-envelope cap land; paged replies
    /// stay far below even the old 1 MiB, so this is headroom, not license.
    private static let maximumMessageSizeBytes = 8 * 1024 * 1024

    public init(url: URL, session: URLSession = .shared) {
        self.task = session.webSocketTask(with: url)
        task.maximumMessageSize = Self.maximumMessageSizeBytes
        task.resume()
    }

    public func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    public func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text):
            return text
        case .data(let data):
            return String(decoding: data, as: UTF8.self)
        @unknown default:
            throw DecodeError.invalidMessage("unknown WS frame")
        }
    }

    public func close() {
        task.cancel(with: .goingAway, reason: nil)
    }
}
