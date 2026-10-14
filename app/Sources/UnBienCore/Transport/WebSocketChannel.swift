import Foundation

/// Minimal text-frame WebSocket abstraction so ``RelayConnection`` can be
/// driven by a real `URLSessionWebSocketTask` in the app and by a fake in
/// tests. One `send`/`receive` maps to one WS text frame (JSONL semantics).
public protocol WebSocketChannel: Sendable {
    func send(_ text: String) async throws
    /// Await the next inbound text frame. Throws on close/error.
    func receive() async throws -> String
    func close()
    /// Liveness probe (URLSessionWebSocketTask.sendPing). Throws promptly on
    /// a dead/failed task — the SILENT socket death after an iOS background
    /// cycle leaves send/receive hanging but ping fails fast, which is what
    /// makes the foreground heal (AppModel+Relays) able to detect it.
    func ping(timeout: TimeInterval) async throws
}

/// `URLSessionWebSocketTask`-backed channel. Works on iOS and macOS.
public final class URLSessionWebSocketChannel: WebSocketChannel, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    /// URLSessionWebSocketTask's DEFAULT maximumMessageSize is 1 MiB — an
    /// inbound frame above it makes `receive()` throw and the receive loop
    /// tears the connection down. Sized to the RELAY's caps (ct ceiling
    /// 16 MiB, WS frame cap 32 MiB): the largest deliverable envelope is
    /// ≈ 16 MiB ct + wrapper, so 32 MiB is 2× headroom. INVARIANT: this cap
    /// stays ≥ (relay ct ceiling × 4/3) — a frame the relay can forward but
    /// the app cannot receive is undeliverable by construction, and a
    /// get_entries walk that produces one can never cross it.
    private static let maximumMessageSizeBytes = 32 * 1024 * 1024

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

    public func ping(timeout: TimeInterval) async throws {
        let task = self.task
        let state = PingRace()
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            // Race the ping against a deadline; the loser's late completion
            // is ignored (one-shot guard under the box's lock).
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                if state.finish() { cont.resume(throwing: TimeoutError.timedOut) }
            }
            task.sendPing { error in
                if state.finish() {
                    if let error { cont.resume(throwing: error) } else { cont.resume() }
                }
            }
        }
    }
}

/// One-shot race flag for the ping deadline (thread-safe: sendPing's
/// completion and the dispatch timer can land from any queue).
private final class PingRace: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    /// Returns true for exactly ONE caller.
    func finish() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

private enum TimeoutError: Error { case timedOut }
