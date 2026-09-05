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

/*
 * Colour, and why almost none of it is fixed.
 *
 * The first version of this window painted a near-black ground and wrote white
 * on it, which is one theme wearing the name of a design. In Light it was
 * white-on-white in places and unreadable in the rest, and it ignored the
 * user's own setting entirely.
 *
 * Text is `.primary` and `.secondary` now — not "black" or "white opacity 0.7"
 * — so it follows the appearance and, more to the point, is *guaranteed* to
 * contrast with whatever is behind it, in both themes, including the ones
 * accessibility settings produce. Anything hard-coded here would be a
 * contrast ratio I cannot check from where I am and the user would find.
 *
 * The two colours that remain are semantic and both are system dynamic colours,
 * which means they already have a Light and a Dark value chosen by people who
 * did check.
 */
private extension Color {
    /// Something needs attention. Orange rather than red: nothing here is a
    /// failure the user caused, and red would say it was.
    static let warn = Color(nsColor: .systemOrange)
    /// The accent, used sparingly — for the tint on glass, not for text.
    static let brand = Color(nsColor: .controlAccentColor)
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

    /// A quiet ground, so the glass has something to refract.
    ///
    /// Liquid Glass over a flat fill reads as a grey rectangle — the material
    /// is only legible when there is something behind it to bend. So there is a
    /// gradient, but built from the *window's* own background colour rather
    /// than a fixed one: it follows the appearance, and the accent tint over it
    /// is faint enough to stay out of the way of the text on top.
    private var backdrop: some View {
        LinearGradient(
            colors: [
                Color(nsColor: .windowBackgroundColor),
                Color(nsColor: .underPageBackgroundColor),
                Color.brand.opacity(0.14),
            ],
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
        .foregroundStyle(.primary)
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
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                    Spacer()
                    Button(copied ? "Copied" : "Copy") { copy(code) }
                        .buttonStyle(.glass)
                }
                if status?.pairingRegistered == false {
                    Note("not reachable — check the network", tone: .warn)
                }
                if let site = status?.siteUrl, !site.isEmpty {
                    Note("open \(site) in the headset")
                }
            } else if let reason = status?.pairingError, !reason.isEmpty {
                Note(reason, tone: .warn)
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
                Note(error, tone: .warn)
            }
            if let error = model.error {
                Note(error, tone: .warn)
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
                     tone: status?.midiAvailable == false ? .warn : nil)
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
                .foregroundStyle(.secondary)
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
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            VStack(alignment: .trailing, spacing: 2) {
                if !value.isEmpty {
                    Text(value)
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(.primary)
                }
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
            .foregroundStyle(tone ?? Color.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Lifecycle

/*
 * When the window exists, and when the process does.
 *
 * THE PROBLEM THIS SOLVES
 * A dock icon lingered after the window was closed, and opening the dashboard
 * again added another — so the dock accumulated one icon per time it had ever
 * been opened. The cause was simply that nothing ever ended the process: the
 * run loop kept going with no window, holding an activation policy that puts an
 * icon in the dock.
 *
 * THE RULES, WHICH ARE THREE
 * The process ends when its last window closes. It ends when it loses focus,
 * because a status window you have clicked away from has served its purpose and
 * a lingering one is clutter. And a second copy is never started: the bridge
 * raises the one that is already running instead.
 *
 * WHY `hasBeenActive` GUARDS THE SECOND RULE
 * `applicationDidResignActive` also fires *before* a launching app has ever
 * been active — the window would appear and vanish in the same breath. So the
 * rule only arms once the app has actually held focus at least once.
 */
final class DashboardDelegate: NSObject, NSApplicationDelegate {
    private let window: NSWindow
    private var hasBeenActive = false
    private var signalSource: DispatchSourceSignal?

    init(window: NSWindow) {
        self.window = window
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        /*
         * SIGUSR1 means "the user asked for the dashboard again".
         *
         * The bridge sends it rather than launching a second copy. Handled
         * through a Dispatch source rather than `signal()` because a signal
         * handler may only call async-signal-safe functions, and raising a
         * window is emphatically not one — a Dispatch source delivers on a
         * queue, where ordinary code is allowed.
         */
        signal(SIGUSR1, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        source.setEventHandler { [weak self] in
            self?.raise()
        }
        source.resume()
        signalSource = source
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
        true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        hasBeenActive = true
    }

    func applicationDidResignActive(_ notification: Notification) {
        guard hasBeenActive else { return }
        NSApplication.shared.terminate(nil)
    }

    private func raise() {
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
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
 *
 * `.regular` is also why the lifecycle above matters: that policy is what puts
 * the icon in the dock, so the icon is present exactly as long as the process
 * is, and the process is present exactly as long as the window is wanted.
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
// Closing the window ends the process, so the window must not outlive its own
// close by being kept alive for a reuse that never comes.
window.isReleasedWhenClosed = false
window.contentView = NSHostingView(rootView: DashboardView(baseURL: base))
window.center()
window.makeKeyAndOrderFront(nil)

let delegate = DashboardDelegate(window: window)
app.delegate = delegate

app.activate(ignoringOtherApps: true)
app.run()
