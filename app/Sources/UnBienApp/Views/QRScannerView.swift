#if os(iOS)
import AVFoundation
import SwiftUI
import UIKit

/// Modal camera scanner for pairing. Reports the first decoded
/// `unbien://pair?…` string and dismisses. iOS-only (camera); macOS keeps the
/// paste path. Camera-usage string lives in the app Info.plist (project.yml).
struct QRScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var permission: Permission = .checking

    enum Permission { case checking, authorized, denied }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                switch permission {
                case .checking:
                    ProgressView().tint(.white)
                case .authorized:
                    CameraPreview { code in
                        onCode(code)
                        dismiss()
                    }
                    .ignoresSafeArea()
                    reticle
                case .denied:
                    deniedView
                }
            }
            .navigationTitle("Scan pairing QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task { await resolvePermission() }
    }

    private var reticle: some View {
        VStack(spacing: 16) {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(.white.opacity(0.9), lineWidth: 3)
                .frame(width: 240, height: 240)
            Text("Point at the QR code shown in your terminal")
                .font(.footnote)
                .foregroundStyle(.white)
        }
    }

    private var deniedView: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.fill").font(.largeTitle)
            Text("Camera access is off").font(.headline)
            Text("Enable camera access for un-bien in Settings to scan pairing "
                 + "codes, or paste the code instead.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
        }
        .foregroundStyle(.white)
        .padding()
    }

    private func resolvePermission() async {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            permission = .authorized
        case .notDetermined:
            permission = await AVCaptureDevice.requestAccess(for: .video) ? .authorized : .denied
        default:
            permission = .denied
        }
    }
}

/// Bridges an AVFoundation capture session into SwiftUI. Delivers the first
/// pairing QR string via `onScan` (on the main actor).
private struct CameraPreview: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    func makeUIViewController(context: Context) -> ScannerViewController {
        ScannerViewController(metadataDelegate: context.coordinator)
    }

    func updateUIViewController(_ controller: ScannerViewController, context: Context) {}

    /// Receives capture-output callbacks off the main actor and hops back to it.
    /// `@unchecked Sendable`: the only mutable state (`handled`) is touched
    /// exclusively inside the `@MainActor` hop, and `onScan` is immutable.
    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
        private let onScan: (String) -> Void
        private var handled = false

        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

        nonisolated func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  object.type == .qr,
                  let code = object.stringValue,
                  code.hasPrefix("unbien://pair") else { return }
            Task { @MainActor in
                guard !self.handled else { return }
                self.handled = true
                self.onScan(code)
            }
        }
    }
}

/// Hosts the capture session. Configuration runs on the main actor (before the
/// session is started); the blocking `startRunning`/`stopRunning` calls run on
/// a private queue via a `Sendable` box holding the session.
private final class ScannerViewController: UIViewController {
    private let sessionBox = SessionBox()
    private let sessionQueue = DispatchQueue(label: "un-bien.qr.session")
    private let metadataDelegate: AVCaptureMetadataOutputObjectsDelegate & NSObjectProtocol
    private var previewLayer: AVCaptureVideoPreviewLayer?

    init(metadataDelegate: AVCaptureMetadataOutputObjectsDelegate & NSObjectProtocol) {
        self.metadataDelegate = metadataDelegate
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
    }

    private func configureSession() {
        let session = sessionBox.session
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(metadataDelegate, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        let box = sessionBox
        sessionQueue.async { box.session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let box = sessionBox
        sessionQueue.async { box.session.stopRunning() }
    }
}

/// A `Sendable` handle to a non-`Sendable` `AVCaptureSession`, so the session
/// can be started/stopped off the main actor without tripping Swift 6 checks.
private final class SessionBox: @unchecked Sendable {
    let session = AVCaptureSession()
}
#endif
