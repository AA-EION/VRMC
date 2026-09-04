// SPDX-License-Identifier: GPL-3.0-only
//
// VRMC's dashboard, natively.
//
// WHY THIS EXISTS AS A SEPARATE EXECUTABLE
// The same reason the tray helper does: a window needs AppKit and a real main
// run loop, and Node has neither. It sits in the app bundle beside the bridge
// and the tray helper, and the tray's "Open dashboard" launches it.
//
// WHY IT DOES NOT INVENT A PROTOCOL
// It reads the same `/api/status` JSON the web dashboard already reads, from
// the HTTP server the WebSocket transport already runs. So the bridge needed no
// change to gain a native window, and there is exactly one description of what
// the dashboard shows rather than two that can disagree.
//
// The server refuses anything that is not loopback — see WsServer — which is
// what makes it safe for this to hold no credential of any kind.
//
// Build: two swiftc invocations, one per architecture, joined with lipo. See
// native/build.mjs. Universal because a Mac running this may be either, and a
// helper that is missing the running architecture does not fail loudly — it
// fails as a window that never appears.

import AppKit
import SwiftUI

// MARK: - What the bridge reports

/// The half of `/api/status` this window draws.
///
/// Deliberately a subset. Every field the bridge publishes is optional here, so
/// a dashboard from one build talking to a bridge from another shows what it
/// understands instead of failing to decode — which for a diagnostic window is
/// the difference between a partial answer and no answer at all.
struct Status: Decodable {
    var version: String?
    var addresses: [String]?
    var wsPort: Int?
    var clients: Int?
    var devices: [Device]?
    var packetsIn: Int?
    var packetsOut: Int?
    var jitterMs: Double?
    var peakJitterMs: Double?
    var lossRatio: Double?
    var midiAvailable: Bool?
    var pairingCode: String?
    var pairingRegistered: Bool?
    var pairingError: String?
    var siteUrl: String?
    var rtcPeers: Int?
    var rtcError: String?
    var lastPacketAgoMs: Double?

    struct Device: Decodable, Identifiable {
        var deviceId: Int
        var model: String
        var status: Int
        var detail: String
        var id: Int { deviceId }
    }
}

// MARK: - Polling

@MainActor
@Observable
final class BridgeStatus {
    private(set) var status: Status?
    /// Why the last fetch failed. Shown rather than swallowed: a dashboard that
    /// silently stops updating looks exactly like a bridge that has stopped.
    private(set) var error: String?

    private let url: URL
    private var task: Task<Void, Never>?

    init(baseURL: URL) {
        self.url = baseURL.appendingPathComponent("api/status")
    }

    func start() {
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                // A second. The numbers that move fastest here are jitter and
                // packet counts, and neither is read at a glance faster than
                // that; polling harder would spend the bridge's time on the
                // window rather than on MIDI.
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func refresh() async {
        do {
            var request = URLRequest(url: url)
            request.timeoutInterval = 3
            // Never a cached answer: this window exists to show what is true
            // now, and a 200 from a cache would be indistinguishable from a
            // bridge that is still running.
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                error = "the bridge answered unexpectedly"
                return
            }
            status = try JSONDecoder().decode(Status.self, from: data)
            error = nil
        } catch {
            self.error = "cannot reach the bridge"
        }
    }
}

// MARK: - The window

/// EION Studios' two inks, as the rest of the interface uses them.
private extension Color {
    static let eionInk = Color(red: 0.05, green: 0.05, blue: 0.06)
    static let eionAccent = Color(red: 0.40, green: 0.78, blue: 0.94)
    static let eionWarn = Color(red: 0.98, green: 0.72, blue: 0.35)
}

struct DashboardView: View {
    @State private var model: BridgeStatus
    @State private var copied = false

    init(baseURL: URL) {
        _model = State(initialValue: BridgeStatus(baseURL: baseURL))
    }

    private var status: Status? { model.status }

    var body: some View {
        /*
         * One GlassEffectContainer around everything that is glass.
         *
         * Not decoration: the container is what lets separate glass shapes be
         * treated as one material, so they sample and blend together rather
         * than each compositing against the window separately. Individually
         * glassed cards in a stack look like stickers; in a container they look
         * like one pane.
         */
        GlassEffectContainer(spacing: 18) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    pairingCard
                    linkCard
                    devicesCard
                }
                .padding(22)
            }
        }
        .frame(minWidth: 460, minHeight: 560)
        .background(backdrop)
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    /// A quiet gradient, so the glass has something to refract.
    ///
    /// Liquid Glass over a flat fill reads as a grey rectangle — the material
    /// is only legible when there is something behind it to bend.
    private var backdrop: some View {
        LinearGradient(
            colors: [Color.eionInk, Color.eionInk.opacity(0.82), Color.eionAccent.opacity(0.16)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("VRMC")
                .font(.system(size: 26, weight: .semibold, design: .rounded))
            Spacer()
            Text(status?.version.map { "v\($0)" } ?? "—")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .foregroundStyle(.white)
    }

    private var pairingCard: some View {
        Card(title: "Pairing code") {
            if let code = status?.pairingCode, !code.isEmpty {
                HStack(spacing: 14) {
                    // Monospaced and wide-tracked: this is read off a screen
                    // and typed into a headset, character by character, which
                    // is exactly when 0 against O costs somebody a minute.
                    Text(code)
                        .font(.system(size: 34, weight: .medium, design: .monospaced))
                        .tracking(4)
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                    Spacer()
                    Button(copied ? "Copied" : "Copy") { copy(code) }
                        .buttonStyle(.glass)
                }
                if status?.pairingRegistered == false {
                    Note("not reachable — check the network", tone: .eionWarn)
                }
                if let site = status?.siteUrl, !site.isEmpty {
                    Note("open \(site) in the headset")
                }
            } else if let reason = status?.pairingError, !reason.isEmpty {
                Note(reason, tone: .eionWarn)
            } else {
                Note("publishing is off")
            }
        }
    }

    private var linkCard: some View {
        Card(title: "Link") {
            Row("Headsets", value: count(status?.clients))
            Row("Over WebRTC", value: count(status?.rtcPeers))
            Row("Packets in / out", value: "\(count(status?.packetsIn)) / \(count(status?.packetsOut))")
            Row("Jitter", value: milliseconds(status?.jitterMs), detail: "peak \(milliseconds(status?.peakJitterMs))")
            Row("Loss", value: status?.lossRatio.map { percent($0) } ?? "—")
            if let error = status?.rtcError, !error.isEmpty {
                Note(error, tone: .eionWarn)
            }
            if let error = model.error {
                Note(error, tone: .eionWarn)
            }
        }
    }

    private var devicesCard: some View {
        Card(title: "Devices") {
            let devices = status?.devices ?? []
            if devices.isEmpty {
                Note(status?.midiAvailable == false
                     ? "no MIDI port — the bridge cannot reach a DAW"
                     : "none open; spawn one from the wrist menu in the headset",
                     tone: status?.midiAvailable == false ? .eionWarn : nil)
            } else {
                ForEach(devices) { device in
                    Row(device.model, value: "", detail: device.detail)
                }
            }
        }
    }

    private func copy(_ code: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }

    private func count(_ value: Int?) -> String { value.map(String.init) ?? "—" }
    private func milliseconds(_ value: Double?) -> String {
        value.map { String(format: "%.1f ms", $0) } ?? "—"
    }
    private func percent(_ value: Double) -> String {
        String(format: "%.2f%%", value * 100)
    }
}

// MARK: - Pieces

/// A pane of Liquid Glass with a heading.
private struct Card<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.4)
                .foregroundStyle(.white.opacity(0.55))
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        // `.regular` rather than `.clear`: this sits over a gradient, and clear
        // glass over a dark ground leaves the text with nothing to sit against.
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }
}

private struct Row: View {
    let label: String
    let value: String
    let detail: String?

    init(_ label: String, value: String, detail: String? = nil) {
        self.label = label
        self.value = value
        self.detail = detail
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.white.opacity(0.75))
            Spacer(minLength: 12)
            VStack(alignment: .trailing, spacing: 2) {
                if !value.isEmpty {
                    Text(value)
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(.white)
                }
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.5))
                }
            }
        }
        .font(.system(size: 13))
    }
}

private struct Note: View {
    let text: String
    let tone: Color?

    init(_ text: String, tone: Color? = nil) {
        self.text = text
        self.tone = tone
    }

    var body: some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(tone ?? .white.opacity(0.55))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Entry point

/*
 * AppKit rather than the SwiftUI `App` lifecycle.
 *
 * This executable lives inside the bridge's app bundle alongside the tray
 * helper, so it is a second process sharing one bundle identity — and the
 * `App` lifecycle assumes it owns the bundle. Driving NSApplication directly
 * is what the tray helper already does here, it is predictable, and
 * `setActivationPolicy(.regular)` is what turns a helper into something with a
 * Dock icon and a window that can take focus.
 */
let arguments = CommandLine.arguments
let base = URL(string: arguments.count > 1 ? arguments[1] : "http://127.0.0.1:7401/")
    ?? URL(string: "http://127.0.0.1:7401/")!

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 480, height: 620),
    styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
    backing: .buffered,
    defer: false
)
window.title = "VRMC"
window.titlebarAppearsTransparent = true
window.titleVisibility = .hidden
// The glass has to have the desktop behind it to be worth using.
window.isMovableByWindowBackground = true
window.contentView = NSHostingView(rootView: DashboardView(baseURL: base))
window.center()
window.makeKeyAndOrderFront(nil)

app.activate(ignoringOtherApps: true)
app.run()
