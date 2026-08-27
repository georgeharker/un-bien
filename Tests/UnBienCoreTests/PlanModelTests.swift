import XCTest
@testable import UnBienCore

final class PlanModelTests: XCTestCase {
    private func item(_ id: String, kind: String = "plan", status: String? = nil,
                      deps: [String] = [], tainted: Bool? = nil) -> PlanItem {
        PlanItem(id: id, kind: kind, name: id, status: status, deps: deps, tainted: tainted)
    }

    func testWavesLayerByUnsatisfiedDeps() {
        let rows = PlanModel.waveOrder([
            item("a"),
            item("b", deps: ["a"]),
            item("c", deps: ["b"]),
        ])
        let waves = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.wave) })
        XCTAssertEqual(waves["a"], 0)
        XCTAssertEqual(waves["b"], 1)
        XCTAssertEqual(waves["c"], 2)
        XCTAssertEqual(rows.first?.id, "a")
        XCTAssertTrue(rows.first { $0.id == "a" }?.actionable ?? false)
    }

    func testDoneDepIsSatisfiedSoDependentIsWaveZero() {
        let rows = PlanModel.waveOrder([
            item("a", status: "done"),
            item("b", deps: ["a"]),
        ])
        XCTAssertEqual(rows.first { $0.id == "b" }?.wave, 0)
        // Done items sink to the end.
        XCTAssertEqual(rows.last?.id, "a")
    }

    func testNoteNeverBlocks_DesignBlocksWhileTainted() {
        let rows = PlanModel.waveOrder([
            item("n", kind: "note"),
            item("d", kind: "design", tainted: true),
            item("x", deps: ["n", "d"]),
        ])
        // note satisfied → doesn't block; tainted design blocks → x behind d.
        XCTAssertEqual(rows.first { $0.id == "x" }?.blockedCount, 1)
        XCTAssertEqual(rows.first { $0.id == "x" }?.wave, 1)
    }

    func testCycleIsCircular() {
        let rows = PlanModel.waveOrder([
            item("a", deps: ["b"]),
            item("b", deps: ["a"]),
        ])
        XCTAssertTrue(rows.allSatisfy { $0.circular })
        XCTAssertNil(rows.first?.wave)
    }

    func testPanelUpdateDecodesAndYieldsItems() throws {
        let line = #"{"type":"panel_update","key":"plan","title":"Plan","icon":"checklist","# +
            #""data":{"items":[{"id":"plan:x","kind":"plan","title":"Do X","status":"ready","deps":[]}]}}"#
        guard case let .panelUpdate(key, title, icon, data) = try Codec.decodeServer(line) else {
            return XCTFail("not a panel_update")
        }
        XCTAssertEqual(key, "plan")
        XCTAssertEqual(title, "Plan")
        XCTAssertEqual(icon, "checklist")
        let items = PlanModel.items(from: data)
        XCTAssertEqual(items.first?.name, "Do X")
        XCTAssertEqual(items.first?.status, "ready")
    }
}
