import XCTest
@testable import UnBienCore

final class RowBoundsStoreTests: XCTestCase {
    func testRecordAndOffsets() {
        var store = RowBoundsStore()
        store.record(id: "a", height: 10)
        store.record(id: "b", height: 20)
        store.record(id: "c", height: 30)
        let order = ["a", "b", "c"]

        XCTAssertEqual(store.count, 3)
        XCTAssertEqual(store.height(id: "b"), 20)
        XCTAssertTrue(store.contains(id: "c"))
        XCTAssertEqual(store.offset(before: "a", order: order), 0)
        XCTAssertEqual(store.offset(before: "c", order: order), 30)   // 10 + 20
        XCTAssertEqual(store.totalHeight(order: order), 60)
    }

    func testOffsetNilWhenPrecedingUnmeasured() {
        var store = RowBoundsStore()
        store.record(id: "c", height: 30)   // "a"/"b" never measured
        let order = ["a", "b", "c"]
        XCTAssertNil(store.offset(before: "c", order: order))   // can't sum unmeasured
        XCTAssertNil(store.totalHeight(order: order))
        XCTAssertNil(store.offset(before: "z", order: order))   // not in order
    }

    func testInvalidateBumpsGenerationAndDropsHeights() {
        var store = RowBoundsStore()
        store.record(id: "a", height: 10)
        XCTAssertEqual(store.generation, 0)

        store.invalidate()                  // width/font/theme change
        XCTAssertEqual(store.generation, 1)
        XCTAssertEqual(store.count, 0)
        XCTAssertNil(store.height(id: "a"))
    }

    func testClearKeepsGeneration() {
        var store = RowBoundsStore()
        store.record(id: "a", height: 10)
        store.invalidate()                  // generation -> 1
        store.record(id: "b", height: 5)
        store.clear()                       // conversation closed / left view
        XCTAssertEqual(store.count, 0)
        XCTAssertEqual(store.generation, 1) // clear doesn't bump generation
    }

    // Geometric window (windowed transcript layout): near = rows intersecting
    // [scrollY − pages·viewport, scrollY + (1+pages)·viewport]; row tops
    // accumulate measured heights + spacing from contentInset. A SMALL fallback
    // underestimates far offsets so the window over-includes — erring toward
    // attached content, never an on-screen placeholder.
    func testWindowRangeGeometric() {
        var store = RowBoundsStore()
        let order = (0..<10).map { "row\($0)" }
        for id in order { store.record(id: id, height: 100) }
        // Stride 100+12; rowTop(i) = 17 + 112·i.
        // scrollY 0, viewport 500, pages 2 → window [-1000, 1500] — all rows.
        XCTAssertEqual(store.windowRange(order: order, scrollY: 0, viewportHeight: 500,
                                         pages: 2, spacing: 12, fallbackHeight: 44), 0..<10)
        // scrollY 1120 → window [120, 2620]: row 0 (top 17, bottom 117) misses
        // windowMin; rows 1…9 intersect.
        XCTAssertEqual(store.windowRange(order: order, scrollY: 1120, viewportHeight: 500,
                                         pages: 2, spacing: 12, fallbackHeight: 44), 1..<10)
        // Far past the end → empty.
        XCTAssertEqual(store.windowRange(order: order, scrollY: 100_000, viewportHeight: 500,
                                         pages: 2, spacing: 12, fallbackHeight: 44), 0..<0)
    }

    func testWindowRangeUnmeasuredFallsBackSmall() {
        var store = RowBoundsStore()
        let order = (0..<50).map { "row\($0)" }
        // NOTHING measured: every row reserves the 44pt fallback — cumulative
        // offsets UNDERestimate (56pt stride vs the true 112), so the window
        // over-includes relative to reality. Safe direction: attached content
        // where a large fallback would have stranded placeholders.
        let fallbackRange = store.windowRange(order: order, scrollY: 0, viewportHeight: 500,
                                              pages: 2, spacing: 12, fallbackHeight: 44)
        XCTAssertGreaterThan(fallbackRange.count, 5, "small fallback must over-include, not under")
        // With all heights measured at 100, the same position covers FEWER rows.
        for id in order { store.record(id: id, height: 100) }
        let measured = store.windowRange(order: order, scrollY: 0, viewportHeight: 500,
                                         pages: 2, spacing: 12, fallbackHeight: 44)
        XCTAssertLessThan(measured.count, fallbackRange.count)
    }

    func testBottomVisibleIndex() {
        var store = RowBoundsStore()
        let order = (0..<10).map { "row\($0)" }
        for id in order { store.record(id: id, height: 100) }
        // rowTop(i) = 17 + 112·i; viewport bottom at scrollY + 500.
        // scrollY 0 → last row with top < 500 is row 4 (top 465).
        XCTAssertEqual(store.bottomVisibleIndex(order: order, scrollY: 0, viewportHeight: 500,
                                                spacing: 12, fallbackHeight: 44), 4)
        // Scrolled so row 9's top (1025) is at the viewport top → row 9 visible.
        XCTAssertEqual(store.bottomVisibleIndex(order: order, scrollY: 1025, viewportHeight: 500,
                                                spacing: 12, fallbackHeight: 44), 9)
        // Content entirely below the viewport (rubber-band above the top): none.
        XCTAssertNil(store.bottomVisibleIndex(order: order, scrollY: -600, viewportHeight: 500,
                                              spacing: 12, fallbackHeight: 44))
    }
}

// MARK: - Height persistence tier (design: transcript row-geometry)

final class RowBoundsStoreSeedTests: XCTestCase {
    func testSeedAndSnapshotRoundtrip() {
        var store = RowBoundsStore()
        store.record(id: "user:abc", height: 120)
        store.record(id: "assistant:def", height: 340)
        store.record(id: "user:ghi", height: 88)

        // Snapshot captures everything retained.
        XCTAssertEqual(store.allHeights.count, 3)
        XCTAssertEqual(store.allHeights["assistant:def"], 340)

        // Seeding a fresh store restores the heights verbatim.
        var fresh = RowBoundsStore()
        fresh.seed(store.allHeights)
        XCTAssertEqual(fresh.height(id: "user:abc"), 120)
        XCTAssertEqual(fresh.height(id: "assistant:def"), 340)
        XCTAssertEqual(fresh.height(id: "user:ghi"), 88)
    }

    func testSeedRejectsNonPositiveHeights() {
        var store = RowBoundsStore()
        store.seed(["user:abc": 100, "stale:zero": 0, "stale:neg": -5])
        XCTAssertEqual(store.height(id: "user:abc"), 100)
        XCTAssertNil(store.height(id: "stale:zero"))
        XCTAssertNil(store.height(id: "stale:neg"))
    }

    func testMeasuredValuesOverwriteSeeds() {
        var store = RowBoundsStore()
        store.seed(["user:abc": 44])   // stale seed (e.g. pre-rotation)
        store.record(id: "user:abc", height: 200)   // re-measured
        XCTAssertEqual(store.height(id: "user:abc"), 200)   // self-healed
    }
}
