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
}
