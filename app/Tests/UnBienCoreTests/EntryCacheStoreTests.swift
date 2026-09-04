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
    private func entry(_ id: String, text: String = "m", parent: String = "") -> JSONValue {
        .object([
            "type": .string("message_end"),
            "id": .string(id),
            "parentId": .string(parent),
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

    func testPureRedeliveryNoOps() async {
        // A fully-redelivered page (every entry already cached — straggler /
        // re-walk replay): no-op, nothing duplicated. (A STRADDLING page —
        // cached head, new tail — appends its suffix instead: see
        // testStraddleAppendsOnlyUncachedSuffix, run 2026-09-18.)
        await store.append(key: "k", roomID: "roomK",
                           entries: [entry("e1"), entry("e2", parent: "e1")], leafId: "e2")
        let appended = await store.append(key: "k", roomID: "roomK",
                                          entries: [entry("e1"), entry("e2", parent: "e1")],
                                          leafId: "e2")
        XCTAssertFalse(appended, "a pure redelivery appends nothing")
        let cached = await store.load(key: "k")
        XCTAssertEqual(cached?.entries.count, 2, "no duplicates")
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
        // Suffix-append (run 2026-09-18): the straddle [e2, e3] drops the
        // already-cached e2 and appends its new tail — the no-double-append
        // intent holds (e2 appears once), and no gap is left behind.
        let straddled = await relaunched.append(
            key: key, roomID: "roomK", entries: [entry("e2"), entry("e3", parent: "e2")],
            leafId: "e3")
        XCTAssertTrue(straddled, "the straddle's uncached tail appends")

        let cached = await relaunched.load(key: key)
        XCTAssertEqual(cached?.entries.count, 3, "e1, e2, e3 — no duplicates, no gap")
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
        // Post-rename pages are straddles (cached head, new tail): the suffix
        // appends AND the append's meta write carries the FRESH room — the
        // rename refresh survives the semantics change.
        let appended = await store.append(key: "r1:peer:sess", roomID: "newRoom",
                                          entries: [entry("e1"), entry("e2", parent: "e1")],
                                          leafId: "e2")
        XCTAssertTrue(appended, "the straddle's new tail appends")

        await store.reconcile(relayID: "r1", peer: "peer", liveRoomIDs: ["newRoom"])
        let survived = await store.load(key: "r1:peer:sess")
        XCTAssertNotNil(survived,
                        "renamed session's cache survives the reconcile")
    }
    /// REGRESSION (run 2026-09-18 — the blank branched session): a straddling
    /// response (first entries already cached, later ones NEW — a post-branch
    /// refetch from an older cursor) must append its uncached SUFFIX. The old
    /// skip-whole guard dropped the tail, and the advancing cursor made the
    /// gap permanent — a 3-entry fragment stood in for a 26-entry session and
    /// rendered zero rows forever.
    func testStraddleAppendsOnlyUncachedSuffix() async {
        await store.append(key: "k", roomID: "r",
                           entries: [entry("e1"), entry("e2", parent: "e1")], leafId: "e2")
        // Straddle: e2 already cached, e3/e4 new.
        let appended = await store.append(key: "k", roomID: "r",
                                          entries: [entry("e2"), entry("e3", parent: "e2"),
                                                    entry("e4", parent: "e3")],
                                          leafId: "e4")
        XCTAssertTrue(appended, "the straddle's new tail must append")
        let cached = await store.load(key: "k")
        XCTAssertEqual(cached?.entries.count, 4, "e1, e2, e3, e4 — no gap, no dup")
        XCTAssertEqual(cached?.leafId, "e4")
    }

    /// REGRESSION (same run): a FRAGMENTED cache (the straddle hole's residue
    /// — a tail-only fragment whose meta leaf sits at its end) must DISCARD at
    /// load: the delta from that cursor re-serves nothing and the fold renders
    /// nothing. Discard → full walk re-seeds (memo discipline).
    func testFragmentedCacheDiscardsAtLoad() async throws {
        // Healthy chain first: root e1 → e2 → e3.
        await store.append(key: "k", roomID: "r",
                           entries: [entry("e1"), entry("e2", parent: "e1"),
                                     entry("e3", parent: "e2")], leafId: "e3")
        // Simulate the hole: rewrite the file with ONLY the e2,e3 tail (the
        // meta leaf stays e3 — the fragment shape from the device; e2's
        // parent e1 is gone, so the chain can't reach a root).
        let file = fileURL(forKey: "k")
        let enc = JSONEncoder()
        var body = Data()
        for e in [entry("e2", parent: "e1"), entry("e3", parent: "e2")] {
            body.append(try enc.encode(e)); body.append(0x0A)
        }
        try body.write(to: file, options: .atomic)

        let cached = await store.load(key: "k")
        XCTAssertNil(cached, "a fragment whose chain can't reach a root discards")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path),
                       "discard trashes the fragment")
    }
}
