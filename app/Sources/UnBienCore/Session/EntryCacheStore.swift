import Foundation
import os

/// LOCAL ENTRY-STREAM CACHE (design 01M1M4N8RZZANDX6NWY7FCSBT5, appends 1-5):
/// the raw pi entry log exactly as get_entries returns it — one JSON line per
/// entry, per session, under Application Support/un-bien/entry-cache — a
/// transport-level memoization of the reconstruction walk. NEVER derived
/// transcript state: the EnvelopeReducer stays the single fold path; identify
/// dedup makes overlap safe.
///
/// FILL (append 5): the single choke point is handleGetEntriesPaging — every
/// get_entries response funnels there, walk pages AND message_end refetch
/// entries (the authoritative log versions that replace the streamed message
/// fragments, which also carry the out-of-band compaction/model entries) — so
/// the cache tracks the LIVE frontier and a warm open's delta is only the
/// streaming tail.
///
/// RETENTION (append 3, user 2026-09-18: "no LRU — invalidates the point"):
/// NO cap. The cache lives exactly as long as the ROOM does — trashed on
/// room-gone (AppModel.forgetSession: room_ended / rooms_check purge /
/// removal), discarded wholesale on version mismatch or corruption.
///
/// DELTA-ALWAYS (append 4): a cache hit NEVER replaces the network check —
/// the warm open always follows with get_entries(since: cachedLeafId) to
/// confirm new content or none. The cache only eliminates the bulk history
/// re-walk.
///
/// Actor: serialized file IO off the main thread — loads are awaited from
/// requestReconstruction, appends are fire-and-forget from the paging handler.
public actor EntryCacheStore {
    /// Bump on ANY format/content change (line layout, meta shape, keying) —
    /// an unknown version discards wholesale (a memo's regeneration is always
    /// safe; the max cost is one slow open, never correctness).
    /// v1 (2026-09-18): initial, pre-release — no identity fields in meta.
    /// v2: + key/relayID/peer/roomID — the rooms-check reconcile matches on
    /// the ROOM the cache was filled from (the cache KEY is the pi session
    /// id, which the relay's room set can't speak to).
    public static let cacheVersion = 2

    public struct CachedEntries: Sendable {
        public let entries: [JSONValue]
        public let leafId: String
    }

    private struct Meta: Codable {
        var v: Int
        /// Raw sessionKey (relayUUID:peer:piSessionId) — filenames are
        /// sanitized; this is the authoritative key.
        var key: String
        /// Identity for the rooms-check reconcile: the relay + peer + the
        /// ROOM this cache was filled from (captured at append, from the
        /// envelope — the key's pi session id is NOT derivable from a room
        /// id, which is a one-way hash of it).
        var relayID: String
        var peer: String
        var roomID: String
        var leafId: String
        var count: Int
        var at: Date
    }

    private let dir: URL
    private let log = Logger(subsystem: "un-bien", category: "entry-cache")
    /// Cached entry ids per key — built at load, scanned lazily on the first
    /// append for a key never loaded this launch (a warm reconnect's retry
    /// page must see the file's ids or it would double-append).
    private var knownIds: [String: Set<String>] = [:]
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(directory: URL? = nil) {
        let base = directory ?? FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("un-bien/entry-cache", isDirectory: true)
        dir = base
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    // sessionKey chars are [A-Za-z0-9-_:] (UUID / base64 peer / base64url
    // room) — ":" is the only filesystem-unsafe character. Injective + readable.
    private func sanitized(_ key: String) -> String {
        key.replacingOccurrences(of: ":", with: "_")
    }
    private func fileURL(_ key: String) -> URL {
        dir.appendingPathComponent(sanitized(key) + ".jsonl")
    }
    private func metaURL(_ key: String) -> URL {
        dir.appendingPathComponent(sanitized(key) + ".meta.json")
    }

    // MARK: - load

    /// The cached history prefix for a session, or nil (miss / version
    /// mismatch / nothing usable). A corrupt LINE truncates to the last good
    /// entry — the trusted cursor moves back to that entry's id, and the next
    /// delta re-covers the lost tail.
    public func load(key: String) -> CachedEntries? {
        let file = fileURL(key), metaFile = metaURL(key)
        guard let metaData = try? Data(contentsOf: metaFile),
              let meta = try? decoder.decode(Meta.self, from: metaData) else {
            // No meta / unreadable: orphaned junk — remove, treat as miss.
            remove(key: key)
            return nil
        }
        guard meta.v == Self.cacheVersion else {
            remove(key: key)
            log.notice("cache discard: version \(meta.v, privacy: .public) != \(Self.cacheVersion, privacy: .public) key=\(String(key.suffix(12)), privacy: .public)")
            return nil
        }
        guard let text = try? String(contentsOf: file, encoding: .utf8),
              !text.isEmpty else {
            remove(key: key)
            return nil
        }
        var entries: [JSONValue] = []
        var ids: Set<String> = []
        var corrupt = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let data = String(line).data(using: .utf8),
                  let entry = try? decoder.decode(JSONValue.self, from: data) else {
                corrupt = true
                break
            }
            entries.append(entry)
            if let id = entry["id"]?.stringValue { ids.insert(id) }
        }
        guard let lastId = entries.last?["id"]?.stringValue else {
            remove(key: key)   // zero good entries — nothing usable
            return nil
        }
        if corrupt {
            // Truncate to the good prefix: rewrite file + meta from what
            // parsed; the cursor moves BACK to the last good entry.
            rewrite(file: file, entries: entries)
            write(metaFile: metaFile, key: key, roomID: meta.roomID,
                  leafId: lastId, count: entries.count)
            log.notice("cache truncated at \(entries.count, privacy: .public) good entries (corrupt tail) key=\(String(key.suffix(12)), privacy: .public)")
        }
        knownIds[key] = ids
        return CachedEntries(entries: entries, leafId: corrupt ? lastId : meta.leafId)
    }

    // MARK: - append

    /// Append one get_entries page's entries + the response cursor.
    /// `roomID` is the relay room the page arrived on — captured for the
    /// rooms-check reconcile (see Meta.roomID). OVERLAP GUARD: a response
    /// whose FIRST entry is already cached is a straggler / re-walk page —
    /// skipped whole; the next delta from the trusted cursor re-covers any
    /// hole (identify dedup makes the re-fetch harmless).
    @discardableResult
    public func append(key: String, roomID: String, entries: [JSONValue], leafId: String) -> Bool {
        guard !entries.isEmpty else { return false }
        let ids = idsForKey(key)
        if let firstId = entries.first?["id"]?.stringValue, ids.contains(firstId) {
            // Overlap — but the room association must stay CURRENT: a rename
            // re-keys the relay ROOM while the cache key (the pi session id)
            // is stable, and every subsequent page is an overlap-skip — so
            // refresh meta.roomID here or a later reconcile would trash a
            // LIVE session's cache over its stale room.
            refreshRoomIDIfStale(key: key, roomID: roomID)
            return false
        }
        var body = Data()
        for entry in entries {
            guard let line = try? encoder.encode(entry) else { continue }
            body.append(line)
            body.append(0x0A)
        }
        guard !body.isEmpty else { return false }
        let file = fileURL(key)
        do {
            if !FileManager.default.fileExists(atPath: file.path) {
                guard FileManager.default.createFile(atPath: file.path, contents: body) else {
                    return false
                }
            } else {
                let handle = try FileHandle(forWritingTo: file)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: body)
            }
        } catch {
            log.error("cache append failed: \(String(describing: error), privacy: .public)")
            return false
        }
        // Meta AFTER the file: a crash between leaves meta BEHIND the file —
        // the safe direction (the trusted cursor only ever lags, never leads;
        // the next delta re-covers).
        var merged = ids
        for entry in entries { if let id = entry["id"]?.stringValue { merged.insert(id) } }
        write(metaFile: metaURL(key), key: key, roomID: roomID, leafId: leafId, count: merged.count)
        knownIds[key] = merged
        return true
    }

    /// Room-set reconcile (user 2026-09-18: "we might not be open when the
    /// room end is published"): on each relay rooms_check for a peer, trash
    /// cached files whose ROOM is not in the published live set — orphaned
    /// caches from rooms that ended while the app was dead (a dead room never
    /// materializes as a session, so the in-memory purge + forgetSession
    /// never fire for it). NO signal (a peer that never publishes a room set)
    /// → keep: indistinguishable from temporarily-offline, never false-purge.
    /// Renamed sessions self-heal — appends refresh meta.roomID (see append).
    public func reconcile(relayID: String, peer: String, liveRoomIDs: Set<String>) {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil) else { return }
        var trashed = 0
        for url in files where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url),
                  let meta = try? decoder.decode(Meta.self, from: data),
                  meta.relayID == relayID, meta.peer == peer,
                  !liveRoomIDs.contains(meta.roomID) else { continue }
            remove(key: meta.key)
            trashed += 1
        }
        if trashed > 0 {
            log.notice("cache reconcile: trashed \(trashed) orphaned room(s) for peer \(String(peer.suffix(8)), privacy: .public)")
        }
    }

    /// Trash the cache for a session (room gone / removal). No-op when absent.
    public func remove(key: String) {
        knownIds[key] = nil
        try? FileManager.default.removeItem(at: fileURL(key))
        try? FileManager.default.removeItem(at: metaURL(key))
    }

    // MARK: - internals

    /// The file's id set — in-memory if loaded this launch, else scanned once
    /// via load (which also discards a version-mismatched/unreadable file so
    /// this append re-seeds a fresh cache).
    private func idsForKey(_ key: String) -> Set<String> {
        if let ids = knownIds[key] { return ids }
        _ = load(key: key)
        return knownIds[key] ?? []
    }

    private func write(metaFile: URL, key: String, roomID: String, leafId: String, count: Int) {
        let identity = identity(of: key)
        let meta = Meta(v: Self.cacheVersion, key: key,
                        relayID: identity?.relayID ?? "", peer: identity?.peer ?? "",
                        roomID: roomID, leafId: leafId, count: count, at: Date())
        if let data = try? encoder.encode(meta) {
            try? data.write(to: metaFile, options: .atomic)
        }
    }

    private func refreshRoomIDIfStale(key: String, roomID: String) {
        let metaFile = metaURL(key)
        guard let data = try? Data(contentsOf: metaFile),
              var meta = try? decoder.decode(Meta.self, from: data),
              meta.roomID != roomID else { return }
        meta.roomID = roomID
        meta.at = Date()
        if let out = try? encoder.encode(meta) {
            try? out.write(to: metaFile, options: .atomic)
        }
    }

    /// sessionKey = "relayUUID:peerBase64:piSessionId" — the peer is base64
    /// (no ":"), so maxSplits 2 keeps any exotic session id intact.
    private func identity(of key: String) -> (relayID: String, peer: String)? {
        let parts = key.split(separator: ":", maxSplits: 2)
        guard parts.count == 3 else { return nil }
        return (String(parts[0]), String(parts[1]))
    }

    private func rewrite(file: URL, entries: [JSONValue]) {
        var body = Data()
        for entry in entries {
            guard let line = try? encoder.encode(entry) else { continue }
            body.append(line)
            body.append(0x0A)
        }
        try? body.write(to: file, options: .atomic)
    }
}
