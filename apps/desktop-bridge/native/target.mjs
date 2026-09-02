// SPDX-License-Identifier: GPL-3.0-only

/**
 * The macOS version VRMC targets, in one place.
 *
 * Two things have to agree on this, and they are built by different scripts:
 * the Swift deployment target the tray helper is compiled against, and the
 * `LSMinimumSystemVersion` in the app bundle's Info.plist. Let them drift and
 * the app either refuses to launch on a system it would have worked on, or
 * launches on one where a symbol it needs does not exist — a crash on a call
 * that looks perfectly ordinary in the source.
 *
 * 26 is a deliberate floor rather than an incidental one. It is what makes
 * SMAppService, the current concurrency model and the current AppKit worth
 * using without a version check around each of them, and every Mac that can
 * run a Quest 3 session over Wi-Fi comfortably is a machine that runs 26.
 */
export const MACOS_DEPLOYMENT_TARGET = '26.0';
