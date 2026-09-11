import XCTest
import SwiftUI
import MarkdownUI
@testable import UnBienApp
@testable import UnBienCore

/// Locks the prewarm primitive's invariants (design 01M24A9NR): the scoped-key
/// format, touch-vs-produce behavior, the in-flight cap throttle, and the
/// single-flight join. The store is a shared singleton — every test mints
/// fresh ids/scopes so the LRU state can't leak between tests. RenderActivity
/// counters are process-global best-effort tallies; tests snapshot before /
/// after and compare deltas.
@MainActor
final class MarkdownEntityStoreTests: XCTestCase {
    private let store = MarkdownEntityStore.shared
    private let style = MarkdownProseStyle(baseSize: 15)

    private func key(scope: String, id: String) -> String {
        MarkdownEntityStore.key(scope: scope, id: id, styleHash: style.hashValue)
    }

    /// The store is a shared singleton: a prior test's prewarm tasks may still
    /// hold cap slots. Drain to quiescence (bounded) before asserting on spawns.
    private func drainPrewarm() async {
        for _ in 0..<300 where store.prewarmInFlight > 0 {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    /// The scoped key is `scope ⧉ id ⧉ styleHash` with an unscoped fallback —
    /// every consumer derives from this one builder, so the format is contract.
    func testScopedKeyFormat() {
        XCTAssertEqual(key(scope: "s1", id: "a-1"), "s1\u{1}a-1\u{1}\(style.hashValue)")
        XCTAssertEqual(MarkdownEntityStore.key(scope: "", id: "a-1", styleHash: 7),
                       "a-1\u{1}7")
    }

    /// prewarm TOUCHES a cached row (no re-parse) and PRODUCES a cold one:
    /// produceStarted moves by exactly 1 for two rows where one is warm.
    func testPrewarmTouchesWarmAndProducesCold() async {
        await drainPrewarm()
        let scope = "t2-\(UUID().uuidString)"
        let warmID = "a-\(UUID().uuidString)", coldID = "a-\(UUID().uuidString)"
        let warmKey = key(scope: scope, id: warmID), coldKey = key(scope: scope, id: coldID)

        _ = await store.produce(warmKey, text: "already warm **row**", style: style)
        XCTAssertNotNil(store.cached(warmKey))

        let started = RenderActivity.produceStarted
        store.prewarm(scope: scope,
                      rows: [(id: warmID, text: "already warm **row**", images: [WireImage]()),
                             (id: coldID, text: "cold **row**", images: [WireImage]())],
                      style: style)
        // The cold row's produce is fire-and-forget — poll for it, bounded.
        for _ in 0..<200 where store.cached(coldKey) == nil {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertNotNil(store.cached(coldKey), "cold row produced by prewarm")
        XCTAssertEqual(RenderActivity.produceStarted - started, 1,
                       "warm row TOUCHED (no spawn); only the cold row produced")
    }

    /// The in-flight cap: twice the cap in cold rows → exactly `cap` spawned and
    /// the rest deferred (the guard counts ALL remaining cold rows, not just the
    /// first). The cap is PINNED here rather than read from the shipping
    /// default, so retuning that default cannot silently retarget this test.
    func testPrewarmCapThrottles() async {
        await drainPrewarm()
        let cap = 3
        let previousCap = MarkdownEntityStore.prewarmMaxInFlight
        MarkdownEntityStore.prewarmMaxInFlight = cap
        defer { MarkdownEntityStore.prewarmMaxInFlight = previousCap }
        let scope = "t3-\(UUID().uuidString)"
        let rows = (0..<(cap * 2)).map { (id: "a-\(UUID().uuidString)-\($0)",
                                 text: "row \($0) **markdown** list", images: [WireImage]()) }
        let started = RenderActivity.prewarmStarted
        let deferred = RenderActivity.prewarmDeferred
        store.prewarm(scope: scope, rows: rows, style: style)
        XCTAssertEqual(RenderActivity.prewarmStarted - started, cap)
        XCTAssertEqual(RenderActivity.prewarmDeferred - deferred, cap)
    }

    /// Single-flight: a produce for a key already parsing is JOINED, not
    /// re-spawned. The big text keeps the first parse in flight across the
    /// second call's cache-miss check.
    func testSingleFlightJoinsRunningParse() async {
        await drainPrewarm()
        let scope = "t4-\(UUID().uuidString)"
        let big = String(repeating: "para with **bold**, `code`, and a [link](x)\n\n", count: 4000)
        let k = key(scope: scope, id: "a-\(UUID().uuidString)")
        let started = RenderActivity.produceStarted
        let joined = RenderActivity.produceJoined

        let firstTask = Task { await store.produce(k, text: big, style: style) }
        try? await Task.sleep(nanoseconds: 5_000_000)   // let the detached parse spin up
        let second = await store.produce(k, text: big, style: style)
        let entities = await firstTask.value

        XCTAssertEqual(second.count, entities.count, "join returns the same parse's result")
        XCTAssertEqual(RenderActivity.produceStarted - started, 1, "exactly ONE parse spawned")
        XCTAssertEqual(RenderActivity.produceJoined - joined, 1, "second call JOINED")
    }
}
