import Foundation

/// One plan node — mirror of pi-plan's `PlanItem` wire shape. The wire field is
/// `title`; older sources send `name`. `deps` are must-precede refs by id.
public struct PlanItem: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let name: String
    public let status: String?
    public let deps: [String]
    public let tainted: Bool?

    public init(id: String, kind: String, name: String, status: String?,
                deps: [String], tainted: Bool?) {
        self.id = id
        self.kind = kind
        self.name = name
        self.status = status
        self.deps = deps
        self.tainted = tainted
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.kind = (try? container.decode(String.self, forKey: .kind)) ?? "plan"
        self.name = (try? container.decode(String.self, forKey: .title))
            ?? (try? container.decode(String.self, forKey: .name)) ?? id
        self.status = try? container.decode(String.self, forKey: .status)
        self.deps = (try? container.decode([String].self, forKey: .deps)) ?? []
        self.tainted = try? container.decode(Bool.self, forKey: .tainted)
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, name, title, status, deps, tainted
    }
}

/// A plan item enriched with its wave position (dependency depth). Mirrors
/// pi-plan's `PlanRow` / `waveOrder` (model.ts).
public struct PlanRow: Equatable, Sendable, Identifiable {
    public let item: PlanItem
    /// 0 = free now; N = behind N waves of unsatisfied deps; nil = circular.
    public let wave: Int?
    public let blockedCount: Int
    public let circular: Bool
    /// A plan item, not done, wave 0 — pick-up-now set.
    public let actionable: Bool

    public var id: String { item.id }
}

public enum PlanModel {
    private static func isDone(_ item: PlanItem) -> Bool { item.status == "done" }

    /// Crib dep semantics: note → never blocks; design → blocks while tainted;
    /// plan → blocks until done.
    private static func isSatisfied(_ item: PlanItem) -> Bool {
        switch item.kind {
        case "note": return true
        case "design": return !(item.tainted ?? false)
        default: return isDone(item)
        }
    }

    private static func kindRank(_ kind: String) -> Int {
        switch kind {
        case "plan": return 0
        case "design": return 1
        case "note": return 2
        default: return 3
        }
    }

    /// Kahn-style layering into waves (port of pi-plan model.ts `waveOrder`):
    /// each pass places items whose unsatisfied in-set deps are all placed;
    /// leftovers form a cycle (`circular`, wave nil). Ordered by (done, wave,
    /// kind, id).
    public static func waveOrder(_ items: [PlanItem]) -> [PlanRow] {
        let byID = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        func blockers(_ item: PlanItem) -> [PlanItem] {
            item.deps.compactMap { byID[$0] }.filter { $0.id != item.id && !isSatisfied($0) }
        }
        let blockerMap = Dictionary(items.map { ($0.id, blockers($0)) }, uniquingKeysWith: { first, _ in first })

        var wave: [String: Int] = [:]
        var placed = Set<String>()
        var waveNum = 0
        var remaining = items
        while !remaining.isEmpty {
            let ready = remaining.filter { (blockerMap[$0.id] ?? []).allSatisfy { placed.contains($0.id) } }
            if ready.isEmpty { break }
            for item in ready { wave[item.id] = waveNum; placed.insert(item.id) }
            remaining.removeAll { placed.contains($0.id) }
            waveNum += 1
        }

        let rows = items.map { item -> PlanRow in
            let circular = !placed.contains(item.id)
            let waveValue = circular ? nil : wave[item.id]
            let actionable = item.kind == "plan" && !isDone(item) && !circular && waveValue == 0
            return PlanRow(item: item, wave: waveValue,
                           blockedCount: (blockerMap[item.id] ?? []).count,
                           circular: circular, actionable: actionable)
        }

        return rows.sorted { lhs, rhs in
            let ld = isDone(lhs.item) ? 1 : 0
            let rd = isDone(rhs.item) ? 1 : 0
            if ld != rd { return ld < rd }
            switch (lhs.wave, rhs.wave) {
            case let (l?, r?) where l != r: return l < r
            case (nil, _?): return false
            case (_?, nil): return true
            default: break
            }
            let lk = kindRank(lhs.item.kind), rk = kindRank(rhs.item.kind)
            if lk != rk { return lk < rk }
            return lhs.item.id < rhs.item.id
        }
    }

    /// Extract plan items from a `panel_update` data payload (`{ items: [...] }`).
    public static func items(from data: JSONValue) -> [PlanItem] {
        guard let encoded = try? JSONEncoder().encode(data),
              let object = try? JSONDecoder().decode(PlanPayload.self, from: encoded) else { return [] }
        return object.items
    }

    private struct PlanPayload: Decodable { let items: [PlanItem] }
}
