import XCTest
@testable import UnBienApp
@testable import UnBienCore

/// The text a failed launch shows, per session_launch_result code: the
/// reason, and pi's output when it exited right after starting (long enough
/// to open as the output sheet).
final class LaunchResultMessageTests: XCTestCase {
    private func result(_ code: String, message: String = "boom", output: String? = nil) -> JSONValue {
        var fields: [String: JSONValue] = [
            "type": .string("session_launch_result"), "in_reply_to": .string("r"),
            "ok": .bool(false), "code": .string(code), "message": .string(message),
        ]
        if let output { fields["output"] = .string(output) }
        return .object(fields)
    }

    func testEachRefusalReadsAsWhatHappened() {
        XCTAssertEqual(AppModel.launchFailureMessage(result("remote_launch_disabled"), machine: "mini"),
                       "Remote launch is turned off on mini.")
        XCTAssertEqual(AppModel.launchFailureMessage(result("permission_denied"), machine: "mini"),
                       "mini doesn't allow launching in that directory.")
        XCTAssertTrue(AppModel.launchFailureMessage(result("unknown_peer"), machine: "mini").contains("Re-pair"))
        XCTAssertEqual(AppModel.launchFailureMessage(result("cwd_missing", message: "Directory does not exist: /x"),
                                                     machine: "mini"),
                       "Couldn't launch on mini: Directory does not exist: /x")
        XCTAssertEqual(AppModel.launchFailureMessage(result("backend_unavailable", message: "no Rex server is running"),
                                                     machine: "mini"),
                       "Couldn't launch on mini: no Rex server is running")
    }

    func testAnEarlyExitCarriesPisOutput() {
        let output = (1...20).map { "line \($0)" }.joined(separator: "\n")
        let text = AppModel.launchFailureMessage(
            result("exited_early", message: "pi exited with status 1 right after starting", output: output),
            machine: "mini")
        XCTAssertTrue(text.hasPrefix("pi exited on mini right after starting: pi exited with status 1"))
        XCTAssertTrue(text.hasSuffix("line 20"))
        XCTAssertGreaterThan(text.split(separator: "\n").count, 8, "long enough for the output sheet")
    }

    func testALegacyErrorFrameReadsTheSameWay() {
        let legacy: JSONValue = .object(["type": .string("error"), "code": .string("permission_denied"),
                                         "message": .string("Remote launch not permitted for this directory")])
        XCTAssertEqual(AppModel.launchFailureMessage(legacy, machine: "mini"),
                       "mini doesn't allow launching in that directory.")
    }
}
