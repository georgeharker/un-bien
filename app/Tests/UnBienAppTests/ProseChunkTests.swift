import Foundation
import Testing
@testable import UnBienApp

struct ProseChunkTests {
    @Test func shortProseStaysWhole() {
        let prose = AttributedString("one\n\ntwo")
        #expect(EntityStack.proseChunks(prose, bodySize: 17) == [prose])
    }

    @Test func tallProseSplitsAtParagraphBreaksAndRejoins() {
        let paragraphs = (0..<60).map { "Paragraph \($0) " + String(repeating: "word ", count: 30) }
        let whole = paragraphs.joined(separator: "\n\n")
        let chunks = EntityStack.proseChunks(AttributedString(whole), bodySize: 17, maxHeight: 400)
        #expect(chunks.count > 1)
        // Putting back the one "\n" dropped at each cut restores the run exactly.
        #expect(chunks.map { String($0.characters) }.joined(separator: "\n") == whole)
        #expect(chunks.dropFirst().allSatisfy { $0.characters.first == "\n" })
    }

    @Test func shortHardLinesCountAsFullLines() {
        // 300 one-word lines: few characters, but tall.
        let whole = (0..<300).map { "line \($0)" }.joined(separator: "\n\n")
        let chunks = EntityStack.proseChunks(AttributedString(whole), bodySize: 17, maxHeight: 1000)
        #expect(chunks.count > 1)
    }
}
