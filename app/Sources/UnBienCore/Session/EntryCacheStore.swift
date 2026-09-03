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
    public static let cacheVersion = 1

    public struct CachedEntries: Sendable {
        public let entries: [JSONValue]
        public let leafId: String
    }

    private struct Meta: Codable {
        var v: Int
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
            write(metaFile: metaFile, leafId: lastId, count: entries.count)
            log.notice("cache truncated at \(entries.count, privacy: .public) good entries (corrupt tail) key=\(String(key.suffix(12)), privacy: .public)")
        }
        knownIds[key] = ids
        return CachedEntries(entries: entries, leafId: corrupt ? lastId : meta.leafId)
    }

    // MARK: - append

    /// Append one get_entries page's entries + the response cursor. OVERLAP
    /// GUARD: a response whose FIRST entry is already cached is a straggler /
    /// re-walk page — skipped whole; the next delta from the trusted cursor
    /// re-covers any hole (identify dedup makes the re-fetch harmless).
    @discardableResult
    public func append(key: String, entries: [JSONValue], leafId: String) -> Bool {
        guard !entries.isEmpty else { return false }
        let ids = idsForKey(key)
        if let firstId = entries.first?["id"]?.stringValue, ids.contains(firstId) {
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
        write(metaFile: metaURL(key), leafId: leafId, count: merged.count)
        knownIds[key] = merged
        return true
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

    private func write(metaFile: URL, leafId: String, count: Int) {
        let meta = Meta(v: Self.cacheVersion, leafId: leafId, count: count, at: Date())
        if let data = try? encoder.encode(meta) {
            try? data.write(to: metaFile, options: .atomic)
        }
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
