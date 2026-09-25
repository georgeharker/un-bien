import XCTest
@testable import UnBienCore

/// Conformance-harness runner (design 01M25GXCQ3W7NKB2DJ4RM9T8EHW): replays every
/// scenario under contracts/conformance/scenarios/ through the Swift reducer
/// (EnvelopeReducer → SessionState), projects the interpreted state via
/// `conformanceProjection()`, and deep-equals it against the scenario's
/// committed `expected.json` — the SAME artifact the remote_pi TS runner
/// asserts against. No per-scenario runner code: a new scenario directory is
/// picked up by convention.
///
/// Golden regeneration: set UNBIEN_CONFORMANCE_REGENERATE=1 to write the current
/// projection into each scenario's expected.json (then COMMIT the diff — a
/// golden change is a reviewable behaviour change). CI always asserts.
final class ConformanceHarnessTests: XCTestCase {
    private func scenariosRoot() -> URL {
        // <repo>/app/Tests/UnBienCoreTests/ → <repo>/contracts/conformance/scenarios
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // UnBienCoreTests/
            .deletingLastPathComponent()   // Tests/
            .deletingLastPathComponent()   // app/
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("contracts/conformance/scenarios")
    }

    private func scenarioDirectories() throws -> [URL] {
        let root = scenariosRoot()
        let names = try FileManager.default.contentsOfDirectory(atPath: root.path)
            .filter { $0.hasPrefix(".") == false }
            .sorted()
        return names.map { root.appendingPathComponent($0) }
    }

    /// Frames as delivered app-side: bare rpc objects wrap as {rpc}; lines that
    /// already carry a plane key ({rpc|evt|ub}) decode directly.
    private func loadInput(_ url: URL) throws -> [EnvelopeMessage] {
        let lines = try String(contentsOf: url, encoding: .utf8)
            .split(separator: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return try lines.map { line in
            let value = try JSONDecoder().decode(JSONValue.self, from: Data(line.utf8))
            if case .object(let obj) = value,
               obj["rpc"] != nil || obj["evt"] != nil || obj["ub"] != nil {
                return try JSONDecoder().decode(EnvelopeMessage.self, from: Data(line.utf8))
            }
            return EnvelopeMessage(rpc: value)
        }
    }

    private func replayLive(_ frames: [EnvelopeMessage]) throws -> EnvelopeReducer {
        var reducer = EnvelopeReducer()
        reducer.apply(frames)
        return reducer
    }

    func testScenariosConform() throws {
        let dirs = try scenarioDirectories()
        XCTAssertGreaterThan(dirs.count, 0, "no conformance scenarios found")
        let regenerate = ProcessInfo.processInfo.environment["UNBIEN_CONFORMANCE_REGENERATE"] == "1"
        var ran = 0
        for dir in dirs {
            let name = dir.lastPathComponent
            let frames = try loadInput(dir.appendingPathComponent("input.jsonl"))
            let reducer = try replayLive(frames)
            let projection = reducer.conformanceProjection()

            let expectedURL = dir.appendingPathComponent("expected.json")
            if regenerate {
                let data = try JSONEncoder().encode(projection)
                try data.write(to: expectedURL, options: .atomic)
                print("regenerated \(name)/expected.json")
                continue
            }

            let expectedData = try Data(contentsOf: expectedURL)
            let expected = try JSONDecoder().decode(JSONValue.self, from: expectedData)
            XCTAssertEqual(
                projection, expected,
                "scenario \(name): interpreted state diverged from expected.json — "
                    + "the normalized diff above IS the contract breach")
            ran += 1
        }
        if !regenerate {
            XCTAssertGreaterThan(ran, 0, "no scenarios asserted")
        }
    }

    /// Replays each scenario in BOTH declared modes and asserts the interpreted
    /// state is mode-independent (live pushes vs get_entries replay pages).
    /// Seed scenarios declare only [live]; replay-mode wiring lands with the
    /// get_entries page framing (design build step 3).
    func testScenarioModesDeclared() throws {
        for dir in try scenarioDirectories() {
            let raw = try String(contentsOf: dir.appendingPathComponent("meta.json"), encoding: .utf8)
            let meta = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
            let modes = meta["modes"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            XCTAssertFalse(modes.isEmpty, "\(dir.lastPathComponent): modes must be declared")
        }
    }
}