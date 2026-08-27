import Foundation

/// The outcome of a successful pairing (`pair_ok` fields, DESIGN §4).
public struct PairResult: Equatable, Sendable {
    public let sessionName: String
    public let sessionStartedAt: Int
    public let roomID: String
    public let harness: Harness?
    public let hostname: String?
}

public extension RelayConnection {
    enum PairingError: Error, Equatable {
        case failed(code: PairErrorCode, message: String)
        case unexpected(String)
    }

    /// Run one QR/paste pairing against a peer. Sends `pair_request` routed to
    /// the invite's `epk` on its room, then reads frames until the matching
    /// `pair_ok`/`pair_error` (correlated by `in_reply_to`). Call after
    /// ``authenticate()`` and before ``events()`` (single socket consumer).
    func pair(invite: PairingInvite, deviceName: String,
              requestID: String = UUID().uuidString) async throws -> PairResult {
        let request = ClientMessage.pairRequest(
            id: requestID, token: invite.token, deviceName: deviceName)
        try await send(request, toPeer: invite.epk, room: invite.roomID)

        while true {
            let frame = try await nextFrame()
            guard case let .routed(envelope) = frame else { continue }
            let message = try? envelope.decodeServer()
            switch message {
            case let .pairOk(inReplyTo, sessionName, startedAt, roomID, harness, hostname)
                where inReplyTo == requestID:
                return PairResult(sessionName: sessionName, sessionStartedAt: startedAt,
                                  roomID: roomID, harness: harness, hostname: hostname)
            case let .pairError(inReplyTo, code, message) where inReplyTo == requestID:
                throw PairingError.failed(code: code, message: message)
            default:
                continue
            }
        }
    }
}
