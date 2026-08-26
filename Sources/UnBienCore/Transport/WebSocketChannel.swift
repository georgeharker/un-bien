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

    public init(url: URL, session: URLSession = .shared) {
        self.task = session.webSocketTask(with: url)
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
