import SwiftUI
import UnBienCore
#if canImport(UIKit)
import UIKit
#endif

/// Full-screen session-tree browser (design 01M1FTV2 append 8). One inset line
/// per entry (or per leaf), depth = branch nesting. Selecting a row navigates
/// to it (session_navigate → session_tree beacon → SessionState.derivePath
/// re-paths the transcript) and dismisses; Done/back dismisses without moving.
struct TreeBrowserView: View {
    let session: LiveSession
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appTheme) private var theme
    /// Show only branch TIPS, or every entry.
    @State private var leavesOnly = false

    private var rows: [BranchTreeRow] {
        model.transcripts[session.id]?.branchTreeRows(leavesOnly: leavesOnly) ?? []
    }

    var body: some View {
        NavigationStack {
            List(rows) { row in
                rowView(row)
            }
            .navigationTitle("Session Tree")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .principal) {
                    Picker("", selection: $leavesOnly) {
                        Text("All").tag(false)
                        Text("Leaves").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 200)
                }
            }
        }
        .tint(theme.accent)
    }

    @ViewBuilder
    private func rowView(_ row: BranchTreeRow) -> some View {
        // Two operations (user 2026-09-04):
        //  • TAP a LEAF — SELECT that prior branch tip (navigateTree(tip) lands
        //    on it → full branch). Non-leaf tap is a no-op (nothing to select).
        //  • LONG-PRESS (contextMenu) — REBRANCH from any point: navigateTree of
        //    a user message re-asks BEFORE it; of an interior entry truncates AT
        //    it (continue = new branch). A leaf "rebranch" == select.
        // Both ride the same session_navigate(entryId) — navigateTree's target
        // type IS the intent; no custom rpc needed for v1.
        Button {
            if row.isLeaf { navigate(row) }
        } label: {
            HStack(spacing: 8) {
                if row.depth > 0 {
                    Color.clear.frame(width: CGFloat(row.depth) * 16)
                }
                Image(systemName: glyph(row.kind))
                    .imageScale(.small)
                    .foregroundStyle(row.isOnPath ? theme.accent : theme.secondaryText)
                    .frame(width: 18)
                Text(row.label.isEmpty ? "(empty)" : row.label)
                    .lineLimit(1)
                    .foregroundStyle(row.isOnPath ? Color.primary : theme.secondaryText)
                    .fontWeight(row.isOnPath ? .semibold : .regular)
                Spacer(minLength: 4)
                if row.isBranchPoint {
                    Image(systemName: "arrow.triangle.branch")
                        .imageScale(.small).foregroundStyle(theme.secondaryText)
                }
                if row.isLeaf {
                    Image(systemName: row.isOnPath ? "checkmark.circle.fill" : "leaf")
                        .imageScale(.small)
                        .foregroundStyle(row.isOnPath ? theme.accent : theme.secondaryText)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Long-press: a PREVIEW of the entry (rendered ~1/4 screen, like the
        // transcript) so you can VALIDATE the point before committing, plus the
        // select/rebranch action.
        .contextMenu {
            Button {
                navigate(row)
            } label: {
                Label(row.isLeaf ? "Go to this branch" : "Rebranch from here",
                      systemImage: "arrow.triangle.branch")
            }
        } preview: {
            previewCard(row)
        }
    }

    @ViewBuilder
    private func previewCard(_ row: BranchTreeRow) -> some View {
        let text = model.transcripts[session.id]?.entryPreview(row.id) ?? row.label
        ScrollView {
            Text(text.isEmpty ? "(empty)" : text)
                .font(.callout)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
        .frame(width: previewWidth, height: previewHeight)
    }

    #if canImport(UIKit)
    private var previewHeight: CGFloat { UIScreen.main.bounds.height / 4 }
    private var previewWidth: CGFloat { min(UIScreen.main.bounds.width - 32, 460) }
    #else
    private var previewHeight: CGFloat { 220 }
    private var previewWidth: CGFloat { 460 }
    #endif

    private func navigate(_ row: BranchTreeRow) {
        // SELECT (leaf) or REBRANCH (point) — same wire: navigate the active leaf
        // toward this entry. branchFromEntry sends session_navigate; the
        // extension's ctx.navigateTree resolves the target by type (leaf/interior
        // → that entry; user message → before it) and the session_tree beacon
        // re-paths the transcript. prefill:nil — browsing, not resubmitting.
        Task { await model.branchFromEntry(session, entryID: row.id, prefill: nil) }
        dismiss()
    }

    private func glyph(_ kind: String) -> String {
        switch kind {
        case "user": return "person"
        case "assistant": return "sparkle"
        case "tool": return "wrench.and.screwdriver"
        case "reasoning": return "brain"
        case "image": return "photo"
        case "toolResult": return "checkmark.seal"
        case "compaction": return "arrow.down.right.and.arrow.up.left"
        case "branch": return "arrow.triangle.branch"
        case "model": return "cpu"
        case "thinking": return "gauge.with.dots.needle.33percent"
        default: return "circle"
        }
    }
}
