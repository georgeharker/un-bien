import SwiftUI
import UnBienCore

/// Full license texts for every bundled part (App Store compliance — MIT/BSD
/// want the agreement REPRODUCED, not just named). Texts are vendored from the
/// dependency checkouts + this repo's licenses into `App/Shared/Licenses/`
/// (bundled as resources in both app targets). Reached from Settings →
/// Acknowledgements → Licenses.
private struct LicensePart: Identifiable {
    let name: String
    let kind: String
    let resource: String
    var id: String { resource }
}

/// The list of bundled parts; each row pushes the full agreement text.
struct LicensesView: View {
    @Environment(\.appTheme) private var theme

    private static let parts: [LicensePart] = [
        .init(name: "Un Bien", kind: "MIT", resource: "un-bien"),
        .init(name: "remote-pi (derivation origin)", kind: "MIT", resource: "remote-pi"),
        .init(name: "Highlightr", kind: "MIT", resource: "highlightr"),
        .init(name: "highlight.js (bundled in Highlightr)", kind: "BSD-3", resource: "highlightjs"),
        .init(name: "swift-markdown-ui", kind: "MIT", resource: "swift-markdown-ui"),
        .init(name: "NetworkImage", kind: "MIT", resource: "networkimage"),
        .init(name: "swift-cmark (cmark-gfm)", kind: "BSD-2", resource: "cmark"),
    ]

    var body: some View {
        List(Self.parts) { part in
            NavigationLink {
                LicenseTextView(part: part)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(part.name)
                    Text(part.kind)
                        .font(.caption)
                        .foregroundStyle(theme.secondaryText)
                }
            }
        }
        .navigationTitle("Licenses")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// One part's full agreement text, selectable + monospaced (it's the license
/// of record — render it verbatim, never restyled prose).
private struct LicenseTextView: View {
    let part: LicensePart

    var body: some View {
        ScrollView {
            Text(Self.text(part.resource))
                .font(.system(.footnote, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .textSelection(.enabled)
        }
        .navigationTitle(part.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    static func text(_ resource: String) -> String {
        guard let url = Bundle.main.url(forResource: resource, withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            return "License text unavailable."
        }
        return text
    }
}
