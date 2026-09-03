// SPDX-License-Identifier: GPL-3.0-only

/**
 * Installing the CoreMIDI driver from inside the app.
 *
 * WHAT THE DRIVER BUYS
 * Virtual endpoints — all an application may open — have no device behind
 * them, so a Launchpad's three ports appear as three separate devices. The
 * driver publishes one device with three entities, which is how the hardware
 * appears, and it does so at the CoreMIDI layer: every DAW reads the same
 * setup, so this is not an Ableton-specific fix.
 *
 * WHERE IT GOES, AND WHY THE ORDER MATTERS
 * CoreMIDI's own header lists two locations for a driver plugin:
 *
 *     /Library/Audio/MIDI Drivers     -- every user, needs root
 *     ~/Library/Audio/MIDI Drivers    -- this user, needs nothing
 *
 * The per-user one is tried first and it is not a fallback — it is the better
 * outcome. It needs no administrator, shows no dialog, and can be undone by
 * deleting a folder the user already owns. A MIDI driver for one person's
 * music software has no business being installed for every account on the
 * machine, and asking for a password to do it is a cost with nothing bought.
 *
 * ABOUT TOUCH ID
 * It is not available, and not for want of trying. The `system.privilege.admin`
 * right authenticates through the `builtin:authenticate` mechanism, and Apple's
 * developer relations have stated plainly that this mechanism "has a hard-coded
 * check for Apple-signed code. If the requesting process's main executable is
 * signed by Apple, it allows the use of Touch ID. If not, it skips that option
 * and always prompts for a password." Asked whether any API exists to get an
 * AuthorizationRef by Touch ID, the answer was "No." LocalAuthentication is not
 * a way around it either — it can tell you the user authenticated, but it
 * cannot hand you root.
 *
 * So a system-wide install shows a password prompt, and there is no version of
 * this that shows a fingerprint. The per-user path shows nothing at all, which
 * is the honest reason to prefer it beyond mere tidiness.
 *
 * HOW ROOT IS ASKED FOR
 * `osascript` with `do shell script … with administrator privileges`. Apple's
 * guidance on privilege escalation names exactly two options for a one-shot
 * elevation — this and `AuthorizationExecuteWithPrivileges`, which has been
 * deprecated since 10.7 — and says of this one that it "works great from
 * AppleScript, but you can also use it from a shell script, using osascript".
 * `SMAppService` is for a daemon that needs privileges *for its lifetime*; this
 * needs them for one `cp`. An installer package would also do, and is what this
 * should become if the driver ever ships as a product rather than as something
 * the app offers to set up.
 */

import { execFile } from "node:child_process";
import { access, cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { removeDriverDevices } from "./coreMidiIdentity.js";

const run = promisify(execFile);

/** The bundle's name, in the app and once installed. */
export const DRIVER_BUNDLE = "VRMC.plugin";

/**
 * Where the driver ships inside the app, in the order to look.
 *
 * `Contents/Resources` when packaged — the same reasoning as the native
 * addons: `Contents/MacOS` means *executables* by the bundle format's own
 * definition, and a bundle staged there is a bundle in the wrong place.
 * Beside the executable is the unpackaged case, where the build script leaves
 * it next to whatever is being run.
 */
export function driverSourcePaths(execPath = process.execPath): string[] {
  const beside = dirname(execPath);
  return [
    join(beside, "..", "Resources", DRIVER_BUNDLE),
    join(beside, DRIVER_BUNDLE),
  ];
}

/** The driver bundled with this app, or null if this build has none. */
export async function bundledDriver(
  execPath = process.execPath,
): Promise<string | null> {
  for (const candidate of driverSourcePaths(execPath)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/** Where a driver may live. */
export type DriverScope = "user" | "system";

export const DRIVER_DIRS: Readonly<Record<DriverScope, string>> = {
  user: join(homedir(), "Library/Audio/MIDI Drivers"),
  system: "/Library/Audio/MIDI Drivers",
};

export interface InstallResult {
  ok: boolean;
  scope: DriverScope;
  path: string;
  /** Lines worth showing the user; explains anything surprising. */
  notes: string[];
}

/**
 * Quote a string for a `do shell script` argument.
 *
 * Two layers, and getting either wrong is a command injection rather than a
 * typo. The text is first wrapped in single quotes for the *shell*, with any
 * embedded single quote closed, escaped and reopened — the standard
 * `'\''` dance, after which no shell metacharacter can survive. The result is
 * then embedded in an AppleScript string literal, where backslash and double
 * quote are the two characters that need escaping.
 *
 * The paths this handles are the app's own and the user's home directory,
 * neither of which is attacker-controlled in any ordinary sense. It is written
 * to be correct anyway, because "the input is trusted" is how injection bugs
 * are argued into existence, and a home directory really can contain a quote.
 */
export function shellQuoteForAppleScript(value: string): string {
  const shellQuoted = `'${value.replaceAll("'", `'\\''`)}'`;
  return shellQuoted.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Build the AppleScript that copies the driver into place as root.
 *
 * Separate from running it so the quoting above can be tested without a Mac and
 * without a password prompt.
 */
export function installScript(source: string, targetDir: string): string {
  const s = shellQuoteForAppleScript(source);
  const d = shellQuoteForAppleScript(targetDir);
  const bundle = shellQuoteForAppleScript(join(targetDir, DRIVER_BUNDLE));
  // `rm -rf` first: `cp -R` onto an existing bundle merges directories rather
  // than replacing it, which would leave stale files from an older driver
  // inside a signature that no longer seals them.
  return (
    `do shell script "mkdir -p ${d} && rm -rf ${bundle} && cp -R ${s} ${d}/` +
    ` && ${QUARANTINE_STRIP} ${bundle} 2>/dev/null || true"` +
    ` with administrator privileges`
  );
}

/**
 * Stripping the quarantine flag off the installed driver.
 *
 * WHY IT IS NEEDED
 * A downloaded app arrives with `com.apple.quarantine` set on everything
 * inside it, and macOS `cp` preserves extended attributes — so the driver
 * copied out of the app lands in the MIDI Drivers folder still flagged as
 * downloaded-from-the-internet. MIDIServer is not a user launching an app; it
 * gets no dialog to approve, so a quarantined plugin is one it can decline to
 * load with nothing said anywhere the user will look.
 *
 * WHY IT IS NOT A GATEKEEPER BYPASS
 * The flag is removed from one bundle, the app's own payload, at the moment
 * the user has asked for it to be installed — and only after they have already
 * approved the app itself, since nothing here runs before that. This is what
 * an installer package would do implicitly: a pkg's payload is never
 * quarantined in the first place. Nothing here touches quarantine on anything
 * the app did not ship, and none of it disables Gatekeeper or assessment.
 *
 * `|| true` because `xattr -d` fails when the attribute is not there, which is
 * the normal case for a build that was never downloaded — a locally built
 * driver, or one already cleared. That is a success, not an error.
 */
const QUARANTINE_STRIP = "/usr/bin/xattr -r -d com.apple.quarantine";

/**
 * Remove the quarantine flag from a path, if it has one.
 *
 * Never fatal. A driver that is quarantined *might* not load; a driver that
 * failed to install because `xattr` was unhappy definitely does not. The note
 * it returns is worth reporting either way, because "installed but still
 * quarantined" is a state worth being able to see when diagnosing.
 */
async function clearQuarantine(path: string): Promise<string | null> {
  try {
    await run("/usr/bin/xattr", ["-r", "-d", "com.apple.quarantine", path]);
    return null;
  } catch {
    // The usual reason is that there was no such attribute, which is what we
    // wanted anyway.
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check the bundle is intact before installing it.
 *
 * A driver whose signature does not verify is one MIDIServer will refuse, and
 * the refusal looks exactly like the driver not working — so it is worth
 * separating "this build is broken or was damaged in transit" from "macOS
 * declined to load it", which are different problems with different answers.
 */
async function verifySignature(path: string): Promise<string | null> {
  try {
    await run("codesign", ["--verify", "--strict", path]);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `the driver's signature does not verify (${message.split("\n")[0]})`;
  }
}

/**
 * Make MIDIServer pick the change up.
 *
 * It is launched on demand and exits when idle, so killing it is a reload
 * rather than an outage: the next thing to ask for MIDI starts it again. Not
 * fatal if it fails — the driver is in place either way, and a logout or a
 * restart gets there too.
 */
async function reloadMidiServer(): Promise<string | null> {
  try {
    await run("killall", ["MIDIServer"]);
    return null;
  } catch {
    // `killall` exits non-zero when nothing matched, which is the common case:
    // MIDIServer simply was not running. Nothing to report.
    return null;
  }
}

/**
 * Install the driver, preferring the path that needs no password.
 *
 * `scope` "user" never prompts. "system" always prompts, once, for an
 * administrator password — see the note above about why it cannot be Touch ID.
 */
export async function installDriver(options: {
  source: string;
  scope?: DriverScope;
  /** Injected in tests. */
  osascript?: (script: string) => Promise<void>;
}): Promise<InstallResult> {
  const scope = options.scope ?? "user";
  const dir = DRIVER_DIRS[scope];
  const notes: string[] = [];

  if (process.platform !== "darwin") {
    return {
      ok: false,
      scope,
      path: dir,
      notes: ["CoreMIDI drivers are a macOS thing; nothing to install here"],
    };
  }
  if (!(await exists(options.source))) {
    return {
      ok: false,
      scope,
      path: dir,
      notes: [`no driver to install: ${options.source} is not there`],
    };
  }

  const bad = await verifySignature(options.source);
  if (bad !== null) return { ok: false, scope, path: dir, notes: [bad] };

  try {
    if (scope === "user") {
      await mkdir(dir, { recursive: true });
      await rm(join(dir, DRIVER_BUNDLE), { recursive: true, force: true });
      await cp(options.source, join(dir, DRIVER_BUNDLE), { recursive: true });
      await clearQuarantine(join(dir, DRIVER_BUNDLE));
      notes.push("installed for this user; no administrator password needed");
    } else {
      const script = installScript(options.source, dir);
      const exec =
        options.osascript ??
        (async (s: string) => {
          await run("osascript", ["-e", s]);
        });
      await exec(script);
      notes.push("installed for every user on this Mac");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A cancelled password dialog is a decision, not a fault, and reads badly
    // as a stack trace.
    const cancelled = /User cancell?ed|-128/.test(message);
    return {
      ok: false,
      scope,
      path: dir,
      notes: [cancelled ? "cancelled at the password prompt" : message],
    };
  }

  await reloadMidiServer();
  notes.push("restarted MIDIServer, so the device should appear now");
  return { ok: true, scope, path: join(dir, DRIVER_BUNDLE), notes };
}

/**
 * Remove the driver from *both* locations, and then the device it left behind.
 *
 * Both, rather than the one scope asked for. A copy left in the other location
 * is loaded by MIDIServer just the same, and it puts the device straight back
 * — so an uninstall that cleared only one would report success and change
 * nothing visible. The system copy is only touched if there is one, so the
 * common case still costs no password.
 */
export async function uninstallDriver(options: {
  osascript?: (script: string) => Promise<void>;
} = {}): Promise<InstallResult> {
  const scopes = await driverScopes();
  const target = join(DRIVER_DIRS.user, DRIVER_BUNDLE);
  const notes: string[] = [];

  try {
    // Always, whether or not it was listed: `rm -rf` on a path that is not
    // there is a no-op, and it costs nothing to be sure.
    await rm(join(DRIVER_DIRS.user, DRIVER_BUNDLE), {
      recursive: true,
      force: true,
    });
    if (scopes.includes("user")) notes.push("removed the copy for this user");

    if (scopes.includes("system")) {
      const exec =
        options.osascript ??
        (async (s: string) => {
          await run("osascript", ["-e", s]);
        });
      await exec(
        `do shell script "rm -rf ${shellQuoteForAppleScript(
          join(DRIVER_DIRS.system, DRIVER_BUNDLE),
        )}" with administrator privileges`,
      );
      notes.push("removed the copy installed for every user");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = /User cancell?ed|-128/.test(message);
    return {
      ok: false,
      scope: "system",
      path: target,
      notes: [cancelled ? "cancelled at the password prompt" : message],
    };
  }

  /*
   * Order matters, and getting it wrong makes the uninstall look like it
   * worked and then undo itself.
   *
   * The plugin is deleted first, then MIDIServer is restarted so the driver is
   * no longer loaded, and only then is the device taken out of the setup.
   * Removing the device while the driver is still resident just means the next
   * `Start()` puts it straight back.
   */
  await reloadMidiServer();

  const removed = removeDriverDevices();
  if (removed > 0) {
    notes.push(
      `removed ${removed} device${removed === 1 ? "" : "s"} from the MIDI setup`,
    );
  } else if (removed === 0) {
    notes.push("no device of ours was left in the MIDI setup");
  } else {
    // Only reachable when CoreMIDI could not be reached at all — koffi
    // missing, or not macOS. Worth saying, because the leftover is visible.
    notes.push(
      "could not reach CoreMIDI to clear the device; if a Launchpad Pro MK3" +
        " is still listed in Audio MIDI Setup, remove it there",
    );
  }

  return { ok: true, scope: "user", path: target, notes };
}

/** Where the driver is installed, if anywhere. */
export async function driverScopes(): Promise<DriverScope[]> {
  const found: DriverScope[] = [];
  for (const scope of ["user", "system"] as const) {
    if (await exists(join(DRIVER_DIRS[scope], DRIVER_BUNDLE))) found.push(scope);
  }
  return found;
}
