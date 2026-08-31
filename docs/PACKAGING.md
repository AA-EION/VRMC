# Building the desktop bridge as a binary

Users should not need Node installed. `pnpm --filter @vrmc/desktop-bridge run
package` produces a folder per platform under
`apps/desktop-bridge/build/dist/`:

| Target | Output |
|---|---|
| `macos-arm64`, `macos-x64` | `VRMC Bridge.app` |
| `windows-x64` | `vrmc-bridge.exe` |
| `linux-x64` | `vrmc-bridge` |

Build one target with `node build/package.mjs windows-x64`.

## The one thing that makes this awkward

The bridge depends on two compiled native addons — `@julusian/midi` for
CoreMIDI and ALSA, and `koffi` for the Windows teVirtualMIDI FFI. Neither can
be embedded in a JavaScript bundle: they are `.node` binaries the OS loads
directly. So a "single executable" is really an executable plus a `prebuilds/`
folder beside it, and the two must ship together.

What makes this tractable is that both packages ship prebuilds for **every**
platform in a single `pnpm install`. A Linux machine already has the macOS and
Windows `.node` files on disk, so it can assemble all four targets. That is
cross-*packaging*: nothing is compiled, only selected and copied. The packager
warns rather than proceeding quietly if a target's prebuild is missing, since
the resulting binary would start up and then fail to open any MIDI port.

The `pkg` step downloads a prebuilt Node binary per target on first run, so the
first build is slow and needs network access.

## Signing

Both builds are unsigned, which is a real limitation rather than an oversight:

- **macOS** quarantines an unsigned app downloaded from the internet. The first
  launch is refused outright; the user must right-click the app and choose
  Open. Distributing without that step needs an Apple Developer ID, a signature
  and notarisation.
- **Windows** SmartScreen warns on an unsigned executable until it has built
  reputation. An EV code-signing certificate avoids it.

Both are commercial prerequisites, not code changes. The release workflow builds
macOS on macOS runners specifically so signing can be added there later without
restructuring anything.

## CI

`.github/workflows/release.yml` builds each target on its own runner and smoke
tests the artifact on the OS it targets — `--list-ports` exits after
enumerating, which proves both that the executable runs and that the native
MIDI addon loaded. Those are the two things packaging is most likely to break,
and neither shows up in a typecheck.

Tagging `v*` attaches zips to a GitHub release.

## What has and has not been verified

**Verified:** the bundling step. `pnpm --filter @vrmc/desktop-bridge run bundle`
produces a 205 KB CommonJS file that runs standalone on Node with the native
addons resolved externally — `node build/out/bridge.cjs --help` works.

**Not verified:** the `pkg` step and everything after it. `pkg` downloads a
prebuilt Node binary per target from GitHub releases on first run, and the
sandboxed environment this was developed in returns 403 for that host, so no
executable has ever been produced here. The script, the target list and the
`.app` assembly are written against `pkg`'s documented behaviour and have not
been run end to end.

That is what the release workflow is for: it builds each target on its own
runner, where the download works, and smoke tests the artifact on the OS it
targets before publishing. The first tagged build is the real test of this
file.

No one has yet opened `VRMC Bridge.app` on a Mac and watched a MIDI port
appear. Until that happens, treat the packaging as plausible rather than proven
— see [Architecture](ARCHITECTURE.md#what-is-not-yet-verified).

The `.app` bundle is deliberately minimal: `Info.plist` plus the executable,
marked `LSBackgroundOnly` because the bridge has no window. It is not a GUI
app, and a bouncing Dock icon for a background process would be noise.
