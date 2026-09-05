// SPDX-License-Identifier: GPL-3.0-only

import { MACOS_DEPLOYMENT_TARGET } from '../native/target.mjs';

/**
 * The bundle's main executable, named here because two things need to agree.
 *
 * `CFBundleExecutable` below is one of them. The other is signing: `codesign`
 * on the *path* of a bundle's main executable does not sign that file, it signs
 * the enclosing bundle — so a signing plan that treats it as one more nested
 * binary signs the whole bundle halfway through, before the nested code is
 * done. Exported rather than written twice, because the failure when these
 * drift is a bundle that signs and then does not verify.
 */
export const BUNDLE_EXECUTABLE = 'vrmc-bridge';

/**
 * The app bundle's Info.plist.
 *
 * Its own module because it is the one part of packaging with no build step to
 * catch a mistake: a `.app` with a wrong key here is assembled without
 * complaint and then behaves oddly on someone else's Mac — a Dock icon that
 * should not be there, a login item that never runs, a network prompt with no
 * explanation in it. A test reads it instead.
 */
export function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>VRMC Bridge</string>
  <key>CFBundleDisplayName</key><string>VRMC Bridge</string>
  <key>CFBundleIdentifier</key><string>studio.eion.vrmc.bridge</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>${BUNDLE_EXECUTABLE}</string>
  <key>CFBundleIconFile</key><string>vrmc.icns</string>
  <key>LSMinimumSystemVersion</key><string>${MACOS_DEPLOYMENT_TARGET}</string>
  <!--
    LSUIElement, not LSBackgroundOnly.

    Both hide the Dock tile, but LSBackgroundOnly forbids any user interface at
    all — including the status item, which simply never appears. LSUIElement is
    the tray-only policy: a menu bar item, no Dock icon, no application menu,
    and no window that could steal focus from the DAW.
  -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <!--
    Why the bridge wants the local network, in the user's words.

    macOS asks before an app may reach the local network, and the prompt quotes
    this string. Without the key the prompt is a bare request from an app with
    no window, which is a thing to deny. The bridge genuinely needs it: the
    headset connects to this machine directly, over the LAN.
  -->
  <key>NSLocalNetworkUsageDescription</key>
  <string>VRMC needs the local network so your headset can reach this computer directly.</string>
  <!--
    Never nap.

    App Nap throttles timers and I/O for an app the system judges idle, and an
    app with no window that mostly waits is exactly what it judges idle. What
    it would be throttling here is MIDI: a note arriving late is audible in a
    way nothing else on this list is.
  -->
  <key>NSAppSleepDisabled</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.music</string>
  <key>NSHumanReadableCopyright</key>
  <string>GPL-3.0-only. https://github.com/AA-EION/VRMC</string>
</dict>
</plist>
`;
}
