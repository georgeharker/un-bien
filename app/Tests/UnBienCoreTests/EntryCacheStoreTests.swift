import XCTest
@testable import UnBienCore

/// EntryCacheStore (design 01M1M4N8RZZANDX6NWY7FCSBT5): raw-entry JSONL memo
/// of the get_entries walk. Covers round-trip, the overlap guard, version
/// discard, corrupt-tail truncation, remove, and the fresh-launch lazy id
/// scan (a retry page after relaunch must not double-append).
final class EntryCacheStoreTests: XCTestCase {
    var dir: URL!
    var store: EntryCacheStore!

    override func setUp() {
        super.setUp()
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("entry-cache-tests-\(UUID().uuidString)", isDirectory: true)
        store = EntryCacheStore(directory: dir)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    /// A get_entries entry shape (docs/rpc-on-event-map.md):
    /// {type,id,parentId,timestamp,message}.
    private func entry(_ id: String, text: String = "m") -> JSONValue {
        .object([
            "type": .string("message_end"),
            "id": .string(id),
            "parentId": .string("p-\(id)"),
            "timestamp": .number(1),
            "message": .object(["role": .string("assistant"), "text": .string(text)]),
        ])
    }

    private func metaURL(forKey key: String) -> URL {
        // Mirrors the store's sanitized naming — keeps the on-disk format honest.
        dir.appendingPathComponent(key.replacingOccurrences(of: ":", with: "_") + ".meta.json")
    }
    private func fileURL(forKey key: String) -> URL {
        dir.appendingPathComponent(key.replacingOccurrences(of: ":", with: "_") + ".jsonl")
    }

    func testRoundTrip() async {
        await store.append(key: "r:peer:room", roomID: "roomX", entries: [entry("e1"), entry("e2")], leafId: "e2")
        await store.append(key: "r:peer:room", roomID: "roomX", entries: [entry("e3")], leafId: "e3")
        let cached = await store.load(key: "r:peer:room")
        XCTAssertNotNil(cached)
        XCTAssertEqual(cached?.entries.count, 3)
        XCTAssertEqual(cached?.leafId, "e3")
        XCTAssertEqual(cached?.entries.last?["id"]?.stringValue, "e3")
    }

    func testMissWithoutFiles() async {
        let cached = await store.load(key: "never:seen")
        XCTAssertNil(cached)
    }

    func testOverlapPageSkipped() async {
        // A straggler / re-walk page: its FIRST entry is already cached —
        // skipped whole (the next delta from the trusted cursor re-covers).
        await store.append(key: "k", roomID: "roomK", entries: [entry("e1"), entry("e2")], leafId: "e2")
        let appended = await store.append(key: "k", roomID: "roomK", entries: [entry("e2"), entry("e3")], leafId: "e3")
        XCTAssertFalse(appended)
        let cached = await store.load(key: "k")
        XCTAssertEqual(cached?.entries.count, 2, "overlap page must not land")
        XCTAssertEqual(cached?.leafId, "e2")
    }

    func testVersionMismatchDiscardsWholesale() async {
        let key = "k"
        await store.append(key: key, roomID: "roomK", entries: [entry("e1")], leafId: "e1")
        // Hand-write a future-version meta (what an upgraded-then-downgraded
        // install leaves behind).
        let futureMeta = "{\"v\":99,\"key\":\"k\",\"relayID\":\"r\",\"peer\":\"p\",\"roomID\":\"roomK\",\"leafId\":\"e1\",\"count\":1,\"at\":0}"
        try? futureMeta.data(using: .utf8)!.write(to: metaURL(forKey: key))
        let cached = await store.load(key: key)
        XCTAssertNil(cached)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL(forKey: key).path),
                       "version mismatch must trash the file too")
    }

    func testCorruptTailTruncatesToLastGoodEntry() async {
        let key = "k"
        await store.append(key: key, roomID: "roomK", entries: [entry("e1")], leafId: "e1")
        // Corrupt the tail with a garbage line after a good second entry:
        // file = e1, garbage → load keeps only e1, cursor moves BACK to e1.
        let garbage = "{\"type\":\"message_end\",\"id\":"
        try? "\(garbage)".data(using: .utf8)!.write(
            to: fileURL(forKey: key),
            options: .atomic)   // replaces: now a lone corrupt line
        // Rebuild the intended shape: one good line + one corrupt line.
        let good = (try? JSONEncoder().encode(entry("e1"))) ?? Data()
        let body = good + Data([0x0A]) + Data(garbage.utf8)
        try? body.write(to: fileURL(forKey: key), options: .atomic)

        let cached = await store.load(key: key)
        XCTAssertEqual(cached?.entries.count, 1, "corrupt line truncates the prefix")
        XCTAssertEqual(cached?.leafId, "e1", "cursor moves back to the last good entry")

        // And the truncated state is LOADABLE and continues cleanly.
        let again = await store.load(key: key)
        XCTAssertEqual(again?.entries.count, 1)
        await store.append(key: key, roomID: "roomK", entries: [entry("e2")], leafId: "e2")
        let final = await store.load(key: key)
        XCTAssertEqual(final?.entries.count, 2, "append continues from the truncated prefix")
        XCTAssertEqual(final?.leafId, "e2")
    }

    func testRemoveTrashesBothFiles() async {
        let key = "k"
        await store.append(key: key, roomID: "roomK", entries: [entry("e1")], leafId: "e1")
        await store.remove(key: key)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL(forKey: key).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: metaURL(forKey: key).path))
        let cached = await store.load(key: key)
        XCTAssertNil(cached)
    }

    func testFreshLaunchScansIdsBeforeAppending() async {
        // Simulate a NEW LAUNCH (fresh store instance over the same dir): the
        // first append for a key never loaded this launch must see the file's
        // ids — a retry page whose first entry is already cached is skipped,
        // not double-appended.
        let key = "k"
        await store.append(key: key, roomID: "roomK", entries: [entry("e1"), entry("e2")], leafId: "e2")

        let relaunched = EntryCacheStore(directory: dir)
        let skipped = await relaunched.append(
            key: key, roomID: "roomK", entries: [entry("e2"), entry("e3")], leafId: "e3")
        XCTAssertFalse(skipped, "fresh launch must detect the overlap via the lazy id scan")

        let appended = await relaunched.append(key: key, roomID: "roomK", entries: [entry("e3")], leafId: "e3")
        XCTAssertTrue(appended)
        let cached = await relaunched.load(key: key)
        XCTAssertEqual(cached?.entries.count, 3)
        XCTAssertEqual(cached?.leafId, "e3")
    }

    func testKeysAreIsolatedFiles() async {
        await store.append(key: "r1:peer:sessA", roomID: "roomA", entries: [entry("e1")], leafId: "e1")
        await store.append(key: "r2:peer:sessB", roomID: "roomB", entries: [entry("f1")], leafId: "f1")
        let a = await store.load(key: "r1:peer:sessA")
        let b = await store.load(key: "r2:peer:sessB")
        XCTAssertEqual(a?.entries.count, 1)
        XCTAssertEqual(a?.entries.last?["id"]?.stringValue, "e1")
        XCTAssertEqual(b?.entries.last?["id"]?.stringValue, "f1")
    }

    // MARK: - rooms-check reconcile (design 01M1M4N8RZZANDX6NWY7FCSBT5)

    func testReconcileTrashesOrphanedRoomsOnly() async {
        // Three caches: a LIVE room, a DEAD room (ended while the app was
        // gone — its session never materializes, forgetSession never fires),
        // and another peer's (no signal — must stay).
        await store.append(key: "r1:peer:sessA", roomID: "roomA", entries: [entry("e1")], leafId: "e1")
        await store.append(key: "r1:peer:sessB", roomID: "roomB", entries: [entry("f1")], leafId: "f1")
        await store.append(key: "r1:other:sessC", roomID: "roomC", entries: [entry("g1")], leafId: "g1")

        await store.reconcile(relayID: "r1", peer: "peer", liveRoomIDs: ["roomA"])

        let live = await store.load(key: "r1:peer:sessA")
        let dead = await store.load(key: "r1:peer:sessB")
        let otherPeer = await store.load(key: "r1:other:sessC")
        XCTAssertNotNil(live, "live room's cache stays")
        XCTAssertNil(dead, "dead room's cache is trashed")
        XCTAssertNotNil(otherPeer, "no-signal peer's cache stays")
    }

    func testReconcileSparesRenamedSessionWithRefreshedRoom() async {
        // A rename re-keys the relay ROOM while the cache key (the pi session
        // id) is stable. Post-rename pages are overlap-skips — but append must
        // REFRESH meta.roomID, or reconcile would trash the live session's
        // cache over its stale room.
        await store.append(key: "r1:peer:sess", roomID: "oldRoom", entries: [entry("e1")], leafId: "e1")
        let skipped = await store.append(key: "r1:peer:sess", roomID: "newRoom",
                                         entries: [entry("e1"), entry("e2")], leafId: "e2")
        XCTAssertFalse(skipped, "overlap page is still skipped")

        await store.reconcile(relayID: "r1", peer: "peer", liveRoomIDs: ["newRoom"])
        let survived = await store.load(key: "r1:peer:sess")
        XCTAssertNotNil(survived,
                        "renamed session's cache survives the reconcile")
    }
}
