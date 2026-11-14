import Foundation
import UnBienCore

/// What the app knows about a launch it sent (`launchOnMachine`), kept for
/// a while after sending so a late result (pi exiting right after it
/// started) can still be reported.
struct LaunchRequestState: Sendable {
    let machineName: String
    let peer: String
    /// The launcher confirmed pi started, on this backend.
    var startedOn: String?
    /// A failure for this launch was already shown.
    var reported = false
}

// Launch feedback: the launcher answers each session_launch with
// session_launch_result frames (started, fell back, or why it failed,
// including pi exiting right after it started). Launchers that predate the
// frame answer refusals with an `error` frame carrying no request id, and
// say nothing else; for those, a launch that never comes online is reported
// when its wait expires.
extension AppModel {
    /// How long a launch's state is kept (covers the launcher's early-exit
    /// window and the auto-open wait).
    static let launchRequestRetentionNs: UInt64 = 120_000_000_000

    /// The machine's display name for launch messages.
    func launchMachineName(relayID: UUID, epk: String) -> String {
        if let m = mesh.config.machines.first(where: { $0.epk == epk && $0.relayID == relayID })
            ?? mesh.config.machines.first(where: { $0.epk == epk }) {
            return m.nickname ?? m.hostname ?? "the machine"
        }
        if let f = federatedMachines.first(where: { $0.epk == epk }) { return f.name }
        return "the machine"
    }

    /// Track a launch just sent, and arrange its expiry: when the wait for
    /// the session runs out with nothing reported, say so.
    func trackLaunch(_ rid: String, machineName: String, peer: String) {
        launchRequests[rid] = LaunchRequestState(machineName: machineName, peer: peer)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            self?.launchWaitExpired(rid)
            try? await Task.sleep(nanoseconds: Self.launchRequestRetentionNs - 60_000_000_000)
            self?.launchRequests[rid] = nil
        }
    }

    /// The 60s wait for the launched session ended. Still pending (it never
    /// announced) and nothing shown yet: tell the user rather than nothing.
    func launchWaitExpired(_ rid: String) {
        guard pendingMachineLaunches.removeValue(forKey: rid) != nil,
              var state = launchRequests[rid], !state.reported else { return }
        state.reported = true
        launchRequests[rid] = state
        let message = state.startedOn != nil
            ? "The session on \(state.machineName) started but never came online."
            : "No session appeared from \(state.machineName). Its launcher may not be running, "
                + "or may be too old to report what went wrong."
        pushTransientNotice(message: message, level: "warning")
    }

    /// A `session_launch_result` frame. Returns true when it was one.
    func handleLaunchResult(_ ub: JSONValue) -> Bool {
        guard ub["type"]?.stringValue == "session_launch_result",
              let rid = ub["in_reply_to"]?.stringValue,
              var state = launchRequests[rid] else {
            return ub["type"]?.stringValue == "session_launch_result"
        }
        if ub["ok"]?.boolValue == true {
            let backend = ub["backend"]?.stringValue ?? "its backend"
            state.startedOn = backend
            launchRequests[rid] = state
            if let from = ub["fell_back"]?["from"]?.stringValue {
                let reason = ub["fell_back"]?["reason"]?.stringValue
                pushTransientNotice(
                    message: "\(from) isn't available on \(state.machineName)"
                        + (reason.map { " (\($0))" } ?? "") + ". Starting with \(backend).",
                    level: "info")
            }
            return true
        }
        pendingMachineLaunches[rid] = nil
        guard !state.reported else { return true }
        state.reported = true
        launchRequests[rid] = state
        pushTransientNotice(message: Self.launchFailureMessage(ub, machine: state.machineName), level: "error")
        return true
    }

    /// A refusal from a launcher that predates session_launch_result: an
    /// `error` frame with no request id. Attributed to this peer's launch
    /// still waiting for an answer, if there is one. Returns true when it
    /// was claimed (so it isn't taken as a stored-session list's reply).
    func claimLegacyLaunchError(_ ub: JSONValue, peer: String) -> Bool {
        guard ub["type"]?.stringValue == "error", ub["in_reply_to"]?.stringValue == nil,
              let (rid, state) = launchRequests.first(where: {
                  $0.value.peer == peer && $0.value.startedOn == nil && !$0.value.reported
                      && pendingMachineLaunches[$0.key] != nil
              }) else { return false }
        var reported = state
        reported.reported = true
        launchRequests[rid] = reported
        pendingMachineLaunches[rid] = nil
        pushTransientNotice(message: Self.launchFailureMessage(ub, machine: state.machineName), level: "error")
        return true
    }

    /// The user-facing text for a failed launch: the reason, and pi's own
    /// output when it exited right after starting (a long message opens as
    /// the output sheet).
    nonisolated static func launchFailureMessage(_ ub: JSONValue, machine: String) -> String {
        let message = ub["message"]?.stringValue ?? "the launch failed"
        let text: String
        switch ub["code"]?.stringValue {
        case "remote_launch_disabled":
            text = "Remote launch is turned off on \(machine)."
        case "unknown_peer":
            text = "\(machine) doesn't recognise this device. Re-pair by scanning its QR code."
        case "permission_denied":
            text = "\(machine) doesn't allow launching in that directory."
        case "exited_early":
            text = "pi exited on \(machine) right after starting: \(message)"
        default:
            text = "Couldn't launch on \(machine): \(message)"
        }
        guard let output = ub["output"]?.stringValue, !output.isEmpty else { return text }
        return "\(text)\n\n\(output)"
    }
}
