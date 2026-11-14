import QuartzCore
import SwiftUI

/// Three dots pulsing in turn, animated by Core Animation. The animation runs
/// in the render server: SwiftUI is never woken per frame. A SwiftUI
/// `repeatForever` animation re-renders the whole window every frame for as
/// long as it runs (every ForEach in every on-screen row updates), which kept
/// the app busy for as long as a session was working.
struct PulsingDots: View {
    let color: Color
    var diameter: CGFloat = 5
    var spacing: CGFloat = 5

    var body: some View {
        PulsingDotsLayerView(color: color, diameter: diameter, spacing: spacing)
            .frame(width: diameter * 3 + spacing * 2, height: diameter)
    }
}

/// The layer-backed view: three circle layers with a repeating, staggered
/// opacity animation (0.6s each way, 0.2s apart: the timing the SwiftUI
/// version used).
final class PulsingDotsLayers {
    let dots: [CALayer] = (0..<3).map { _ in CALayer() }

    func install(in host: CALayer) {
        for dot in dots where dot.superlayer == nil { host.addSublayer(dot) }
    }

    func layout(diameter: CGFloat, spacing: CGFloat, color: CGColor) {
        for (index, dot) in dots.enumerated() {
            dot.frame = CGRect(x: CGFloat(index) * (diameter + spacing), y: 0, width: diameter, height: diameter)
            dot.cornerRadius = diameter / 2
            dot.backgroundColor = color
        }
    }

    func start() {
        let now = CACurrentMediaTime()
        for (index, dot) in dots.enumerated() where dot.animation(forKey: "pulse") == nil {
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1.0
            pulse.toValue = 0.25
            pulse.duration = 0.6
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            pulse.beginTime = now + Double(index) * 0.2
            pulse.fillMode = .backwards
            dot.add(pulse, forKey: "pulse")
        }
    }
}

#if os(macOS)
private struct PulsingDotsLayerView: NSViewRepresentable {
    let color: Color
    let diameter: CGFloat
    let spacing: CGFloat

    final class Host: NSView {
        let layers = PulsingDotsLayers()
        var diameter: CGFloat = 5
        var spacing: CGFloat = 5
        var color: CGColor = .clear

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
        }

        required init?(coder: NSCoder) { nil }

        override func layout() {
            super.layout()
            guard let layer else { return }
            layers.install(in: layer)
            layers.layout(diameter: diameter, spacing: spacing, color: color)
            layers.start()
        }

        // A view re-added to a window gets its animations back.
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window != nil { needsLayout = true }
        }
    }

    func makeNSView(context: Context) -> Host { Host() }

    func updateNSView(_ host: Host, context: Context) {
        host.diameter = diameter
        host.spacing = spacing
        host.color = NSColor(color).cgColor
        host.needsLayout = true
    }
}
#else
private struct PulsingDotsLayerView: UIViewRepresentable {
    let color: Color
    let diameter: CGFloat
    let spacing: CGFloat

    final class Host: UIView {
        let layers = PulsingDotsLayers()
        var diameter: CGFloat = 5
        var spacing: CGFloat = 5
        var color: CGColor = UIColor.clear.cgColor

        override func layoutSubviews() {
            super.layoutSubviews()
            layers.install(in: layer)
            layers.layout(diameter: diameter, spacing: spacing, color: color)
            layers.start()
        }

        // Core Animation drops a layer's animations when its view leaves the
        // window (and when the app backgrounds); re-adding restarts them.
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { setNeedsLayout() }
        }
    }

    func makeUIView(context: Context) -> Host { Host() }

    func updateUIView(_ host: Host, context: Context) {
        host.diameter = diameter
        host.spacing = spacing
        host.color = UIColor(color).cgColor
        host.setNeedsLayout()
    }
}
#endif
