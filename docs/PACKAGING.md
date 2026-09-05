# Building the desktop bridge as a binary

Users should not need Node installed. `pnpm --filter @vrmc/desktop-bridge run
package` produces a folder per platform under
`apps/desktop-bridge/build/dist/`:

| Target | Output |
|---|---|
| `macos-arm64` | `VRMC Bridge.app`, shipped in a `.dmg`. Targets macOS 26; `macos-x64` still builds but is not released, because the Intel Macs that run 26 are a handful of late models. |
| `windows-x64` | `vrmc-bridge.exe`, shipped in `VRMC-Setup.msi` |
| `linux-x64` | `vrmc-bridge` |

Build one target with `node build/package.mjs windows-x64`. The tray helper is
built separately, and first: `pnpm tray`.

## The one thing that makes this awkward

The bridge depends on three compiled native addons — `@julusian/midi` for
CoreMIDI and ALSA, `koffi` for the Windows teVirtualMIDI FFI, and
`node-datachannel` for WebRTC. None can be embedded in a JavaScript bundle:
they are `.node` binaries the OS loads directly. So a "single executable" is
really an executable plus some files beside it, and they must ship together.

The MIDI and FFI addons ship prebuilds for **every** platform in a single
`pnpm install`, so one machine can assemble those for all four targets. That is
cross-*packaging*: nothing is compiled, only selected and copied.

Two things break that convenience, and both are why the release matrix has one
runner per OS:

- **`node-datachannel`'s addons are separate optional packages**, and a package
  manager installs only the one matching the machine it runs on. A Linux box
  simply does not have the macOS binary to copy.
- **The tray helper has to be compiled**, not selected. It is native GUI code
  against AppKit and the Win32 shell.

The packager warns rather than proceeding quietly when any of these is missing,
because each failure is invisible until it matters: no MIDI addon means a
bridge that opens no ports, no WebRTC addon means a headset that can never
pair, and no tray helper means no way to read the pairing code.

The `pkg` step downloads a prebuilt Node binary per target on first run, so the
first build is slow and needs network access.

## Installers

Neither platform asks the user to think about where the bridge lives.

**macOS** ships a `.dmg` containing `VRMC Bridge.app` and a symlink to
`/Applications`, so the install is the drag everyone already knows. The bundle
is marked `LSUIElement`: a menu bar item, no Dock tile, no application menu,
and no window that could take focus from the DAW. (`LSBackgroundOnly` would
also hide the Dock tile, but it forbids *any* interface — the status item
simply never appears.) Opening it the first time from Applications registers it
as a login item so it comes back after a reboot; the menu shows that as a
ticked "Start at login" you can turn off. `setup/firstRun.ts` skips
registration when the app is still running from the disk image or a Downloads
folder, because a login item recording a path that is about to change is worse
than none.

That registration goes through `SMAppService`, which is why the tray helper has
a `--login-item` mode: the API is Swift-only and needs a bundle to point at,
and the helper is already inside one. Registering this way is what puts VRMC in
System Settings → General → Login Items under its own name, where it can be
turned off like anything else — a hand-written LaunchAgent appears there as an
opaque row at best. The old LaunchAgent path is still the fallback, because
`SMAppService` can refuse outright on an unsigned build, which is what a
downloaded release currently is. `SMAppService` can also register and then wait
for the user to allow it; the bridge reports that as its own state rather than
claiming the setting took.

**Windows** ships an MSI built by `build/installer/`. It installs to Program
Files, adds a Start menu shortcut, writes a per-user `Run` entry, and launches
the bridge when it finishes.

It is deliberately **not a Windows service**. A service runs in session 0,
which has no desktop: it could not own a notification-area icon, so the user
would have no way to read the pairing code or see whether anything was working,
and it could not reach the per-user MIDI session the DAW lives in. A per-user
login entry needs no elevation and puts the bridge in the same session as the
DAW.

The MSI's file list is harvested from the staged build rather than written by
hand — the addons bring a nested directory tree, and a hand-maintained list is
one that eventually ships without the MIDI binding in it. That harvesting is
unit-tested (`test/installer.test.ts`) even though WiX itself only runs on the
Windows runner.

## Signing

### macOS: ad-hoc, and why that is not optional

The app bundle is ad-hoc signed — `codesign --sign -`, a signature with no
identity behind it. This is not a nicety on Apple Silicon: the kernel refuses to
map an unsigned Mach-O at all, and when Gatekeeper finds a quarantined bundle
whose code it cannot validate, the message it shows is **"damaged and can't be
opened. You should move it to the Bin."** It is the same dialog as a genuinely
corrupt download, which is why it sends people looking for one.

`@yao-pkg/pkg` already ad-hoc signs the executable it produces, so the bridge
binary was never the problem. What was unsigned was everything assembled around
it: the `@julusian/midi`, `koffi` and `node-datachannel` addons and the Swift
tray helper are copied in afterwards, and the bundle they sit in was never
sealed.

`build/codesign.mjs` signs it inside-out — every nested binary first, the bundle
last — because a signature seals what is beneath it and signing the bundle first
means the next nested signature silently invalidates it. `codesign` never
complains about that order; only `--verify` does, which is why the release
workflow verifies as a separate step and fails on it. `--deep` is deliberately
not used to sign: Apple deprecated it, and it papers over exactly that question.

**Where the addons live, and why it is not beside the executable.**
`Contents/MacOS` does not mean "next to the program" to macOS. It means
executables, and `codesign` enforces that literally: sealing the bundle, it
treats every file in there as a code object that must already carry a
signature. Staging `node_modules` in it fails the seal with *"code object is
not signed at all — In subcomponent: …/@julusian/midi/binding.gyp"*, naming
whichever ordinary text file it reached first, and there is no way to satisfy
that because nothing will sign a `.gyp`.

So the staged tree lives in `Contents/Resources`, whose contents are sealed
wholesale into `CodeResources` while the `.node` binaries inside still get
their own signatures — the same place Electron puts unpacked native modules,
for the same reason. `Contents/MacOS` holds two things: the bridge and the tray
helper. `stagedPaths` in `src/native.ts` is the other half of this and has its
own tests, because getting it wrong produces a bridge that starts cleanly,
shows a pairing code, and can open no MIDI port.

**What ad-hoc buys, and what it does not.** It makes the code loadable and the
bundle internally consistent, which turns "damaged" into the ordinary
unverified-developer prompt. It is not notarisation: a downloaded build is still
quarantined and still needs one deliberate approval. On macOS 15 and later,
right-click → Open is no longer a bypass — the person installing has to open it
once, let it be refused, then press **Open Anyway** in System Settings → Privacy
& Security. If a build ever does report itself as damaged, the download lost its
signature in transit and `xattr -dr com.apple.quarantine` on the installed app
clears it.

The day a Developer ID exists, `identity` in `signBundle` is the only thing that
changes; the order of operations is already what notarisation requires. Hardened
runtime is deliberately *not* enabled: it is a notarisation prerequisite, and
turning it on without notarising would only add the JIT and
unsigned-executable-memory entitlements a pkg binary needs, for no benefit.

### Windows

The executable is unsigned. SmartScreen warns until it has built reputation; an
EV code-signing certificate avoids it. That is a commercial prerequisite rather
than a code change.

## CI

`.github/workflows/release.yml` builds each target on its own runner, verifies
the macOS signature (both on the assembled bundle and again on the copy inside
the mounted `.dmg`, since copying a bundle can lose the extended attributes that
carry it), and smoke tests the artifact on the OS it targets — `--list-ports` exits after
enumerating, which proves both that the executable runs and that the native
MIDI addon loaded. Those are the two things packaging is most likely to break,
and neither shows up in a typecheck.

Tagging `v*` attaches zips to a GitHub release.

## What has and has not been verified

**Verified:** the bundling step. `pnpm --filter @vrmc/desktop-bridge run bundle`
produces a 205 KB CommonJS file that runs standalone on Node with the native
addons resolved externally — `node build/out/bridge.cjs --help` works.

**Verified:** the addon staging. The tree `copyDataChannel` and
`copyMidiPrebuild` assemble was checked by loading `node-datachannel` from a
staged copy and opening a peer connection with it, so the files a packaged
build resolves at runtime are known to be sufficient.

**Verified:** the MSI's file manifest, the tray protocol and the tray helper's
JSON reader — the last compiled and run on every platform, not just Windows.

**Not verified:** the `pkg` step and everything after it. `pkg` downloads a
prebuilt Node binary per target from GitHub releases on first run, and the
sandboxed environment this was developed in cannot reach that host, so no
executable has ever been produced here. The script, the target list, the `.app`
assembly, the WiX build and both native helpers are written against documented
behaviour and have not been run end to end.

That is what the release workflow is for: it builds each target on its own
runner, where the download works, and smoke tests the artifact on the OS it
targets before publishing. The first tagged build is the real test of this
file.

No one has yet opened `VRMC Bridge.app` on a Mac and watched a MIDI port
appear. Until that happens, treat the packaging as plausible rather than proven
— see [Architecture](ARCHITECTURE.md#what-is-not-yet-verified).

Neither the Swift nor the C helper has been compiled: this environment has no
Swift toolchain and no MSVC. Their shared protocol and the C parser are tested
here; the AppKit and Win32 code is not, and the release workflow's per-OS
matrix is where it first runs.
