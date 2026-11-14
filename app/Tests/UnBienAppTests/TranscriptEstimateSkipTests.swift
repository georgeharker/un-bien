import XCTest
@testable import UnBienApp
@testable import UnBienCore

/// A row only gets an estimate when one would be kept: it has no height, or
/// only one of our own estimates. Measured heights and heights restored from
/// the persisted cache always win (seedEstimate), so the transcript must not
/// split a tool card's text to estimate such a row: that was the idle-CPU
/// burn (every update estimated every tool card, and threw nearly all of it
/// away).
@MainActor
final class TranscriptEstimateSkipTests: XCTestCase {
    func testOnlyRowsWithoutAKeptHeightNeedAnEstimate() {
        let driver = TranscriptWindowDriver()
        XCTAssertTrue(driver.needsEstimate(rowID: "new"), "no height yet")

        driver.record(id: "measured", height: 120)
        XCTAssertFalse(driver.needsEstimate(rowID: "measured"), "a rendered row's height is truth")

        driver.seedHeights(["restored": 80])
        XCTAssertFalse(driver.needsEstimate(rowID: "restored"), "restored from the height cache")

        driver.seedEstimate(rowID: "estimated", estimate: 64)
        XCTAssertTrue(driver.needsEstimate(rowID: "estimated"), "our own estimate may be refined")
        driver.record(id: "estimated", height: 70)
        XCTAssertFalse(driver.needsEstimate(rowID: "estimated"), "measured over the estimate")
    }

    func testAMeasureEqualToTheEstimateStillCountsAsMeasured() {
        let driver = TranscriptWindowDriver()
        driver.seedEstimate(rowID: "exact", estimate: 92)
        driver.record(id: "exact", height: 92)
        XCTAssertFalse(driver.needsEstimate(rowID: "exact"),
                       "an exact estimate must not leave the row re-estimated on every rebuild")
    }

    func testAnEstimateNeverReplacesAMeasuredOrRestoredHeight() {
        let driver = TranscriptWindowDriver()
        driver.record(id: "measured", height: 120)
        driver.seedHeights(["restored": 80])
        driver.seedEstimate(rowID: "measured", estimate: 10)
        driver.seedEstimate(rowID: "restored", estimate: 10)
        XCTAssertFalse(driver.needsEstimate(rowID: "measured"))
        XCTAssertFalse(driver.needsEstimate(rowID: "restored"))
        XCTAssertEqual(driver.heightSnapshot()["measured"], 120)
        XCTAssertEqual(driver.heightSnapshot()["restored"], 80)
    }

    func testALargeViewportChangeMakesRowsNeedEstimatesAgain() {
        let driver = TranscriptWindowDriver()
        driver.update(viewportHeight: 800)
        driver.record(id: "measured", height: 120)
        XCTAssertFalse(driver.needsEstimate(rowID: "measured"))
        // Rotation / a big window resize drops the retained heights.
        driver.update(viewportHeight: 400)
        XCTAssertTrue(driver.needsEstimate(rowID: "measured"))
    }

    func testTheCapturedHeightsLeaveOutEstimates() {
        let driver = TranscriptWindowDriver()
        driver.record(id: "measured", height: 120)
        driver.seedEstimate(rowID: "estimated", estimate: 64)
        XCTAssertEqual(driver.heightSnapshot(), ["measured": 120],
                       "the persisted height cache must never restore an estimate as exact")
    }

    /// Appending rows reuses every known height: the driver asks for an
    /// estimate only for the new rows, not the transcript it already measured.
    func testAppendingRowsEstimatesOnlyTheNewOnes() {
        let driver = TranscriptWindowDriver()
        let style = markdownProseStyle(theme: ThemeID.oneDark.theme, typography: Typography())
        var asked: [(id: String, needsEstimate: Bool)] = []
        let resolve: (String, Bool) -> RowHeightEstimator.ToolWarmSpec? = { id, needs in
            asked.append((id, needs))
            return RowHeightEstimator.ToolWarmSpec(facts: needs ? .init(expanded: false) : nil, warm: nil)
        }
        let rows = (0..<10).map { "tool-\($0)" }
        driver.update(viewportHeight: 2_000)
        driver.update(scrollY: 0)
        driver.sync(order: rows, scope: "s", style: style, warmPairFor: { _ in nil },
                    toolFactsFor: resolve, width: 370)
        XCTAssertEqual(Set(asked.filter(\.needsEstimate).map(\.id)), Set(rows), "a fresh transcript estimates every row")
        // The rows render and record their real heights.
        for id in rows { driver.record(id: id, height: 100) }
        asked.removeAll()
        driver.sync(order: rows + ["tool-10", "tool-11"], scope: "s", style: style, warmPairFor: { _ in nil },
                    toolFactsFor: resolve, width: 370)
        XCTAssertEqual(Set(asked.filter(\.needsEstimate).map(\.id)), ["tool-10", "tool-11"],
                       "only the appended rows need estimates")
        XCTAssertTrue(asked.contains { $0.id == "tool-3" && !$0.needsEstimate }, "known rows are still warmed, not estimated")
    }
}
