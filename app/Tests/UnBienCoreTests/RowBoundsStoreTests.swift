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

// MARK: - Tall-row intersection semantics (run 2026-09-18: whole-row-fits
// dropped tall rows while their bottoms were on screen)

final class WindowRangeTallRowTests: XCTestCase {
    /// A row TALLER than the page budget, directly above the anchor, must
    /// stay near — its bottom is at the viewport's bottom edge (visible).
    func testTallRowAboveAnchorStaysNear() {
        var store = RowBoundsStore()
        let order = (0..<10).map { "r\($0)" }
        for id in order { store.record(id: id, height: 50) }
        store.record(id: "r4", height: 2500)   // 5 viewports tall (vh = 500)

        let range = store.windowRangeAroundIndex(order: order, center: 5,
                                                 viewportHeight: 500, pages: 2,
                                                 spacing: 8, fallbackHeight: 44)
        XCTAssertTrue(range.contains(4),
                      "a tall row above the anchor is visible at its bottom — must stay near")
    }

    /// A tall row STRADDLING the top boundary (top inside, body beyond) is
    /// included; the row fully beyond it is not.
    func testStraddlingRowIncludedFullyBeyondExcluded() {
        var store = RowBoundsStore()
        // 24 spacer rows of 50pt (58 with spacing); tall row at index 2.
        let order = (0..<24).map { "r\($0)" }
        for id in order { store.record(id: id, height: 50) }
        store.record(id: "r2", height: 2500)
        // Anchor at the tail: spacers r23..r3 sum to 21*58 = 1218 > 1000
        // (pages*vheight), so the budget is spent BEFORE r2's top — excluded.
        let range = store.windowRangeAroundIndex(order: order, center: 23,
                                                 viewportHeight: 500, pages: 2,
                                                 spacing: 8, fallbackHeight: 44)
        XCTAssertFalse(range.contains(2), "fully-beyond tall row stays out")
        XCTAssertFalse(range.contains(1))
        // Anchor nearer: r23..r4 = 20*58 = 1160... still spent. Use center 21:
        // r20..r3 = 18*58 = 1044 >= 1000 — spent at r3. center 20: r19..r3 =
        // 17*58 = 986 < 1000 — r2's TOP is inside the band → straddling →
        // INCLUDED even though its body extends 2500pt beyond.
        let nearRange = store.windowRangeAroundIndex(order: order, center: 20,
                                                     viewportHeight: 500, pages: 2,
                                                     spacing: 8, fallbackHeight: 44)
        XCTAssertTrue(nearRange.contains(2), "straddling tall row (top inside band) is included")
        XCTAssertFalse(nearRange.contains(1), "the row above the straddler stays out")
    }

    /// Symmetric downward: a tall row below the anchor whose top is inside
    /// the downward band is included.
    func testTallRowBelowAnchorTopInsideBand() {
        var store = RowBoundsStore()
        let order = (0..<10).map { "r\($0)" }
        for id in order { store.record(id: id, height: 50) }
        store.record(id: "r6", height: 2500)

        let range = store.windowRangeAroundIndex(order: order, center: 5,
                                                 viewportHeight: 500, pages: 2,
                                                 spacing: 8, fallbackHeight: 44)
        XCTAssertTrue(range.contains(6), "tall row with top inside the downward band is included")
        XCTAssertFalse(range.contains(7), "rows beyond the straddler stay out")
    }
}
