// SPDX-License-Identifier: GPL-3.0-only
//
// VRMC tray helper for macOS.
//
// Owns one NSStatusItem and nothing else. It reads newline-delimited JSON
// commands on stdin, draws whatever menu it is told to, and writes a line to
// stdout when something is clicked. Every decision about what the menu should
// say is made by the bridge; this file contains no product logic, which is why
// it can stay small enough to read in one sitting.
//
// Why a separate executable at all: a status item needs AppKit and a real main
// run loop, and Node has neither. Talking to a tiny native process over a pipe
// is far less machinery than embedding a GUI toolkit in the bridge.
//
// It has a second, non-graphical job: registering the app as a login item.
// That belongs here rather than in the bridge because the sanctioned API for it
// is SMAppService, which is Swift-only and needs a real bundle to point at —
// and this executable is already inside one. Run with `--login-item <verb>` it
// does that and exits without ever touching AppKit.
//
// Build:  swiftc -O -target arm64-apple-macosx26.0 main.swift -o vrmc-tray

import AppKit
import Foundation
import ServiceManagement

// MARK: - Protocol types

struct TrayItem: Decodable {
    let id: String?
    let label: String?
    let enabled: Bool?
    let separator: Bool?
    let checked: Bool?
}

struct TrayCommand: Decodable {
    let type: String
    let tooltip: String?
    let items: [TrayItem]?
}

/// Write one event line to the bridge.
///
/// Flushed immediately: the bridge acts on clicks, and a click sitting in a
/// buffer is a menu that appears not to work.
func emit(_ json: String) {
    FileHandle.standardOutput.write(Data((json + "\n").utf8))
}

// MARK: - The icon

/// Draw the VRMC mark as a template image.
///
/// Drawn rather than loaded from a file for two reasons. A template image is
/// tinted by the system, so it stays legible in a light menu bar, a dark one
/// and under Reduce Transparency without shipping three assets. And it means
/// the helper is a single self-contained executable with nothing beside it that
/// could go missing during packaging.
///
/// The mark is a V built from pads, matching the app icon. At menu bar size the
/// five-column grid of the full icon collapses into texture, so this is the
/// bold single-stroke form the icon generator uses for its own small sizes.
func makeStatusImage() -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let image = NSImage(size: size, flipped: false) { rect in
        let path = NSBezierPath()
        // A V inset from the edges, with squared-off ends: at 18 points a
        // pointed vertex loses its tip to antialiasing and reads as a U.
        let inset: CGFloat = 3.5
        let top = rect.maxY - inset
        let bottom = rect.minY + inset + 0.5
        path.move(to: NSPoint(x: rect.minX + inset, y: top))
        path.line(to: NSPoint(x: rect.midX, y: bottom))
        path.line(to: NSPoint(x: rect.maxX - inset, y: top))
        path.lineWidth = 2.0
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        NSColor.black.setStroke()
        path.stroke()

        // A single lit pad at the vertex, which is what makes it read as an
        // instrument rather than a letter.
        let dot = NSRect(x: rect.midX - 1.25, y: rect.minY + 1.0, width: 2.5, height: 2.5)
        NSColor.black.setFill()
        NSBezierPath(ovalIn: dot).fill()
        return true
    }
    // The system tints a template image for the current appearance. Without
    // this the icon is a black smudge on a dark menu bar.
    image.isTemplate = true
    return image
}

// MARK: - The status item

@MainActor
final class TrayDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    /// Menu item tags map to command ids; AppKit gives us the tag on action.
    private var ids: [Int: String] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = makeStatusImage()
        statusItem.button?.toolTip = "VRMC"
        statusItem.menu = NSMenu()
        emit("{\"type\":\"ready\"}")
        readCommands()
    }

    /// Read stdin on a thread of its own and apply each command on the main one.
    ///
    /// AppKit is main-thread-only, and a blocking read on the main thread would
    /// freeze the menu bar item — the one visible symptom users would notice.
    ///
    /// A real thread rather than a detached `Task`, deliberately. `readLine`
    /// blocks, and a task that blocks holds a thread of the cooperative pool
    /// for as long as the bridge runs, which is exactly what that pool is not
    /// for. And `DispatchQueue.main` rather than `MainActor.run`, because these
    /// commands are ordered — a menu built from the second of two updates and
    /// a tooltip from the first is a menu nobody can explain — and a serial
    /// queue keeps that order where a series of tasks does not.
    ///
    /// `assumeIsolated` is the part that is new: it tells the compiler what was
    /// previously only true in practice, that this closure runs on the main
    /// actor, so every AppKit call below is checked rather than trusted.
    private func readCommands() {
        Thread.detachNewThread { [self] in
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                      let command = try? JSONDecoder().decode(TrayCommand.self, from: data)
                else { continue }
                DispatchQueue.main.async { MainActor.assumeIsolated { self.apply(command) } }
            }
            // stdin closed: the bridge exited, or was killed. Either way this
            // icon now represents nothing, so take it down.
            DispatchQueue.main.async { MainActor.assumeIsolated { NSApp.terminate(nil) } }
        }
    }

    private func apply(_ command: TrayCommand) {
        switch command.type {
        case "menu":
            rebuild(tooltip: command.tooltip ?? "VRMC", items: command.items ?? [])
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func rebuild(tooltip: String, items: [TrayItem]) {
        statusItem.button?.toolTip = tooltip
        let menu = NSMenu()
        ids.removeAll()

        for (index, item) in items.enumerated() {
            if item.separator == true {
                menu.addItem(.separator())
                continue
            }
            let entry = NSMenuItem(
                title: item.label ?? "",
                action: #selector(clicked(_:)),
                keyEquivalent: ""
            )
            entry.target = self
            entry.tag = index
            entry.state = item.checked == true ? .on : .off
            // A row with no action is status the user reads. AppKit greys out
            // an item with no target, so dropping the action is enough.
            if item.enabled == false || item.id == nil {
                entry.action = nil
                entry.isEnabled = false
            } else {
                ids[index] = item.id
            }
            menu.addItem(entry)
        }
        statusItem.menu = menu
    }

    @objc private func clicked(_ sender: NSMenuItem) {
        guard let id = ids[sender.tag] else { return }
        // Encoded rather than interpolated: an id is ours, but building JSON by
        // hand from anything that might contain a quote is how this breaks.
        guard let data = try? JSONEncoder().encode(["type": "click", "id": id]),
              let json = String(data: data, encoding: .utf8)
        else { return }
        emit(json)
    }
}

// MARK: - Login items

/// Registering the app to start when the user logs in.
///
/// SMAppService, not a hand-written LaunchAgent. Since macOS 13 this is the
/// supported way, and the difference is visible to the user: an app registered
/// through it appears in System Settings → General → Login Items under its own
/// name, where it can be turned off the way every other login item can. A plist
/// dropped into ~/Library/LaunchAgents appears there only as an opaque row, and
/// on a system where the user has already denied background activity it is
/// simply ignored with nothing said.
///
/// `requiresApproval` is a real state, not an error: macOS has accepted the
/// registration but is waiting for the user to allow it in Settings. Saying
/// "on" there would be a lie, and saying "off" would send them to a switch that
/// is already flipped.
enum LoginItem {
    static func state() -> String {
        switch SMAppService.mainApp.status {
        case .enabled: return "on"
        case .requiresApproval: return "approval"
        case .notRegistered, .notFound: return "off"
        @unknown default: return "off"
        }
    }

    static func run(_ verb: String) -> [String: String] {
        do {
            switch verb {
            case "status":
                break
            case "enable":
                // Registering an already-registered app throws rather than
                // succeeding quietly, and that is not a failure to report.
                if SMAppService.mainApp.status != .enabled {
                    try SMAppService.mainApp.register()
                }
            case "disable":
                try SMAppService.mainApp.unregister()
            default:
                return ["error": "unknown verb"]
            }
        } catch {
            return ["error": error.localizedDescription, "state": state()]
        }
        return ["state": state()]
    }
}

// MARK: - Entry point

// The non-graphical mode, handled before anything creates an NSApplication:
// this path must not put an icon in the menu bar, and must exit on its own.
let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--login-item" {
    let result = LoginItem.run(arguments.count > 1 ? arguments[1] : "status")
    if let data = try? JSONEncoder().encode(result),
       let json = String(data: data, encoding: .utf8) {
        emit(json)
    }
    exit(result["error"] == nil ? 0 : 1)
}

/*
 * Inside `assumeIsolated`, because top-level code is not main-actor isolated.
 *
 * It reads as though it must be — this is the main thread, before anything
 * else exists — but the compiler does not know that, and under the Swift 6
 * language mode Xcode 26 defaults to, every line below is a main-actor call
 * from nowhere. `assumeIsolated` states the thing that is true: this runs on
 * the main thread, so it is the main actor.
 *
 * `delegate` is held here rather than in a global on purpose. NSApplication
 * does not retain its delegate, and `app.run()` does not return until the
 * helper is quitting, so this scope is exactly as long as the delegate needs
 * to live.
 */
MainActor.assumeIsolated {
    let app = NSApplication.shared
    // .accessory is the tray-only policy: a status item, no Dock tile, no menu
    // bar menus, and no window that could steal focus from the DAW.
    app.setActivationPolicy(.accessory)
    let delegate = TrayDelegate()
    app.delegate = delegate
    app.run()
}
