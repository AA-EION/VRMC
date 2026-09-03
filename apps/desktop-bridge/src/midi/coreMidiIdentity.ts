// SPDX-License-Identifier: GPL-3.0-only

import { requireNative } from "../native.js";

/**
 * Giving a virtual endpoint the identity the hardware has.
 *
 * WHAT THIS CANNOT DO, SO THE LIMIT IS WRITTEN DOWN ONCE
 * A real Launchpad is one USB device, so macOS shows one CoreMIDI *device*
 * containing two *entities*. This cannot reproduce that, and no application
 * can: CoreMIDI's headers are explicit that `MIDISetupAddDevice` is "only MIDI
 * drivers may make this call", that a non-driver calling `MIDIDeviceCreate` or
 * `MIDIDeviceAddEntity` gets an *external* device — a description of hardware
 * plugged into an interface, whose endpoints are not ones we could send on —
 * and that "virtual sources and destinations don't have entities". Grouping
 * needs a driver plugin in /Library/Audio/MIDI Drivers, which is an admin
 * install and a different product.
 *
 * WHAT IT CAN DO, AND WHY IT IS WORTH DOING
 * The same headers say, for manufacturer and model and for nothing else useful
 * here: "Creators of virtual endpoints may set this property on their
 * endpoints." So a MIDI monitor, an Audio MIDI Setup inspector and any host
 * that surfaces those fields see "Focusrite - Novation" and "Launchpad X"
 * rather than nothing.
 *
 * This comment used to include display name in that list, on the strength of a
 * summary rather than the header itself. It is not settable — it is derived
 * from the device and endpoint names — and writing to it returns paramErr,
 * which took a macOS runner to discover because nothing here can execute
 * CoreMIDI. See `EndpointIdentity` for why the derived value was already the
 * one we wanted.
 *
 * HOW IT TALKS TO CoreMIDI
 * Through koffi, the same FFI the Windows backend uses for teVirtualMIDI, so
 * this adds no new kind of dependency. The property ids are read as *data
 * symbols* from the framework rather than rebuilt from the string literals
 * they happen to hold: `kMIDIPropertyName` is a CFStringRef global, and
 * reading it is exact, where hardcoding "name" is a guess that would fail
 * silently — `MIDIObjectSetStringProperty` with an id CoreMIDI does not
 * recognise sets some other property and returns success.
 *
 * Everything here is best-effort. A failure costs the endpoint its metadata
 * and nothing else: the port still exists, still sends and still receives, so
 * a missing koffi or an OS that moved a symbol must not stop MIDI working.
 */

/**
 * What a host may be told about an endpoint.
 *
 * Two fields, because two is what CoreMIDI permits. The header grants exactly
 * this much to an application: "Creators of virtual endpoints may set this
 * property on their endpoints" appears on `kMIDIPropertyManufacturer` and
 * `kMIDIPropertyModel`, and on nothing else useful here.
 *
 * `kMIDIPropertyDisplayName` is deliberately absent. It looked like the field
 * that mattered — it is the one hosts show — but it is *derived*: "the
 * Apple-recommended user-visible name for an endpoint, by combining the device
 * and endpoint names". Writing to it returns paramErr (OSStatus -50), which is
 * how this was found, on a macOS runner, on the first build that ever executed
 * this code.
 *
 * That same sentence says the display name is already correct without us. A
 * virtual endpoint has no device to combine with, so the combination
 * degenerates to the endpoint's own name — which packaging already sets to
 * "Launchpad X LPX DAW". The value we were trying to write was the value it
 * already had.
 */
export interface EndpointIdentity {
  /** The USB manufacturer string, e.g. "Focusrite - Novation". */
  manufacturer: string;
  /** The USB product string, e.g. "Launchpad X". */
  model: string;
}

/**
 * What a host can actually see on an endpoint.
 *
 * Deliberately wider than `EndpointIdentity`: the display name and the
 * endpoint's own name are readable but not writable, and reading them is how
 * the self-check confirms the derived display name came out right without us
 * touching it.
 */
export interface EndpointFacts {
  name: string;
  displayName: string;
  manufacturer: string;
  model: string;
}

/** CFStringEncoding for UTF-8. */
const K_CF_STRING_ENCODING_UTF8 = 0x0800_0100;

const CORE_MIDI = "/System/Library/Frameworks/CoreMIDI.framework/CoreMIDI";
const CORE_FOUNDATION =
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

/** The slice of koffi used here, declared structurally so this typechecks
 * without the optional dependency installed. */
interface KoffiLike {
  load(path: string): {
    func(name: string, result: unknown, args: unknown[]): unknown;
    symbol(name: string): unknown;
  };
  decode(pointer: unknown, type: string): unknown;
  alloc(type: string, count: number): unknown;
  decodeString?(pointer: unknown): string;
}

interface Bound {
  setStringProperty(object: number, property: unknown, value: unknown): number;
  getStringProperty(object: number, property: unknown, out: unknown): number;
  deviceCount(): number;
  device(index: number): number;
  removeDevice(device: number): number;
  sourceCount(): number;
  source(index: number): number;
  destinationCount(): number;
  destination(index: number): number;
  cfStringCreate(alloc: unknown, cstr: Buffer, encoding: number): unknown;
  cfStringGetCString(
    str: unknown,
    buffer: Buffer,
    size: number,
    encoding: number,
  ): boolean;
  cfRelease(cf: unknown): void;
  property: {
    name: unknown;
    manufacturer: unknown;
    model: unknown;
    displayName: unknown;
    driverOwner: unknown;
  };
  koffi: KoffiLike;
}

/** Why the last attempt failed, if it did. Read for reporting. */
let lastError = "";

export function coreMidiIdentityError(): string {
  return lastError;
}

let bound: Bound | null | undefined;

/**
 * Bind the two frameworks, once.
 *
 * `undefined` means "not tried yet", `null` means "tried and cannot" — the
 * distinction matters because a failure here is permanent for the process and
 * retrying it per port would pay the same cost repeatedly.
 */
function bind(): Bound | null {
  if (bound !== undefined) return bound;
  bound = null;

  if (process.platform !== "darwin") {
    lastError = "not macOS";
    return null;
  }

  try {
    const koffi = requireNative<KoffiLike>("koffi");
    const midi = koffi.load(CORE_MIDI);
    const cf = koffi.load(CORE_FOUNDATION);

    /*
     * `kMIDIPropertyName` and friends are `const CFStringRef` globals. The
     * symbol is the address *of the variable*, so it has to be dereferenced to
     * get the CFStringRef the variable holds.
     */
    const constant = (name: string): unknown => {
      const address = midi.symbol(name);
      const value = koffi.decode(address, "void *");
      if (value === null || value === undefined) {
        throw new Error(`CoreMIDI exports no ${name}`);
      }
      return value;
    };

    bound = {
      // ItemCount is unsigned long; MIDIObjectRef and MIDIEndpointRef are UInt32.
      setStringProperty: midi.func("MIDIObjectSetStringProperty", "int32", [
        "uint32",
        "void *",
        "void *",
      ]) as Bound["setStringProperty"],
      getStringProperty: midi.func("MIDIObjectGetStringProperty", "int32", [
        "uint32",
        "void *",
        "void **",
      ]) as Bound["getStringProperty"],
      deviceCount: midi.func(
        "MIDIGetNumberOfDevices",
        "ulong",
        [],
      ) as Bound["deviceCount"],
      device: midi.func("MIDIGetDevice", "uint32", [
        "ulong",
      ]) as Bound["device"],
      removeDevice: midi.func("MIDISetupRemoveDevice", "int32", [
        "uint32",
      ]) as Bound["removeDevice"],
      sourceCount: midi.func(
        "MIDIGetNumberOfSources",
        "ulong",
        [],
      ) as Bound["sourceCount"],
      source: midi.func("MIDIGetSource", "uint32", [
        "ulong",
      ]) as Bound["source"],
      destinationCount: midi.func(
        "MIDIGetNumberOfDestinations",
        "ulong",
        [],
      ) as Bound["destinationCount"],
      destination: midi.func("MIDIGetDestination", "uint32", [
        "ulong",
      ]) as Bound["destination"],
      cfStringCreate: cf.func("CFStringCreateWithCString", "void *", [
        "void *",
        "char *",
        "uint32",
      ]) as Bound["cfStringCreate"],
      cfStringGetCString: cf.func("CFStringGetCString", "bool", [
        "void *",
        "char *",
        "long",
        "uint32",
      ]) as Bound["cfStringGetCString"],
      cfRelease: cf.func("CFRelease", "void", ["void *"]) as Bound["cfRelease"],
      property: {
        name: constant("kMIDIPropertyName"),
        manufacturer: constant("kMIDIPropertyManufacturer"),
        model: constant("kMIDIPropertyModel"),
        displayName: constant("kMIDIPropertyDisplayName"),
        driverOwner: constant("kMIDIPropertyDriverOwner"),
      },
      koffi,
    };
    lastError = "";
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    bound = null;
  }
  return bound;
}

/** A CFString holding `value`, which the caller must release. */
function cfString(b: Bound, value: string): unknown {
  const buffer = Buffer.from(value + "\0", "utf8");
  const str = b.cfStringCreate(null, buffer, K_CF_STRING_ENCODING_UTF8);
  if (str === null || str === undefined)
    throw new Error(`could not make a CFString for ${value}`);
  return str;
}

/** Read one string property, or '' when it has none. */
function readProperty(b: Bound, endpoint: number, property: unknown): string {
  const out = b.koffi.alloc("void *", 1);
  if (b.getStringProperty(endpoint, property, out) !== 0) return "";
  const str = b.koffi.decode(out, "void *");
  if (str === null || str === undefined) return "";
  try {
    // 512 is generous: these are port names, not documents.
    const buffer = Buffer.alloc(512);
    if (
      !b.cfStringGetCString(
        str,
        buffer,
        buffer.length,
        K_CF_STRING_ENCODING_UTF8,
      )
    )
      return "";
    const end = buffer.indexOf(0);
    return buffer.toString("utf8", 0, end === -1 ? buffer.length : end);
  } finally {
    // MIDIObjectGetStringProperty gives the caller a reference to release.
    b.cfRelease(str);
  }
}

/** Every endpoint on the system, sources and destinations both. */
function* endpoints(b: Bound): Generator<number> {
  for (let i = 0; i < b.sourceCount(); i++) yield b.source(i);
  for (let i = 0; i < b.destinationCount(); i++) yield b.destination(i);
}

/**
 * Every endpoint currently called `name`.
 *
 * Plural because a bidirectional port is two endpoints — a source and a
 * destination — created under one name, and both should carry the identity. It
 * returned the first match once, which meant the destination never got one:
 * the search walks sources first, so stamping the input half found the output
 * half again and wrote the same values to it a second time.
 *
 * By name because that is the only handle RtMidi gives us — it creates the
 * endpoint and keeps the `MIDIEndpointRef` to itself. Names are unique at this
 * point precisely because the manager creates them pre-combined
 * ("Launchpad X LPX DAW"); the bare name is set afterwards, by which time we
 * no longer need to find it.
 */
function findEndpoints(b: Bound, name: string): number[] {
  const found: number[] = [];
  for (const endpoint of endpoints(b)) {
    if (readProperty(b, endpoint, b.property.name) === name)
      found.push(endpoint);
  }
  return found;
}

/**
 * Give the endpoint named `createdAs` the identity of real hardware.
 *
 * Returns whether every property was set. Best-effort by design: a false here
 * means a port with less metadata, never a port that does not work.
 */
export function stampIdentity(
  createdAs: string,
  identity: EndpointIdentity,
): boolean {
  const b = bind();
  if (b === null) return false;

  try {
    const found = findEndpoints(b, createdAs);
    if (found.length === 0) {
      lastError = `no CoreMIDI endpoint named "${createdAs}"`;
      return false;
    }

    /*
     * Each property on its own, and a refusal does not abandon the rest.
     *
     * The first version stopped at the first non-zero status, so when
     * CoreMIDI refused the derived display name the endpoint ended up with no
     * manufacturer and no model either — one wrong field cost all of them. It
     * also reported "refused a property" without saying which, which is a
     * sentence that describes the symptom and hides the cause.
     */
    const writes: [string, unknown, string][] = [
      ["manufacturer", b.property.manufacturer, identity.manufacturer],
      ["model", b.property.model, identity.model],
    ];

    const refused: string[] = [];
    for (const [label, property, value] of writes) {
      const str = cfString(b, value);
      try {
        for (const endpoint of found) {
          const status = b.setStringProperty(endpoint, property, str);
          if (status !== 0) refused.push(`${label} (OSStatus ${status})`);
        }
      } finally {
        b.cfRelease(str);
      }
    }

    if (refused.length > 0) {
      lastError = `CoreMIDI refused ${refused.join(", ")} on "${createdAs}"`;
      return false;
    }
    lastError = "";
    return true;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/**
 * Read back what a host would see for the endpoint named `name`.
 *
 * Exists for the self-test: no machine that runs this project's test suite has
 * CoreMIDI, so the only honest verification is on a macOS runner, round-tripping
 * through the real framework. See `--check-midi`.
 */
export function readIdentity(name: string): EndpointFacts | null {
  const b = bind();
  if (b === null) return null;
  try {
    const [endpoint] = findEndpoints(b, name);
    if (endpoint === undefined) return null;
    return {
      name: readProperty(b, endpoint, b.property.name),
      displayName: readProperty(b, endpoint, b.property.displayName),
      manufacturer: readProperty(b, endpoint, b.property.manufacturer),
      model: readProperty(b, endpoint, b.property.model),
    };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/**
 * The CFBundleIdentifier of our CoreMIDI driver.
 *
 * `kMIDIPropertyDriverOwner` carries the owning driver's name, and MIDIServer
 * uses the plugin's bundle identifier for it. It must match Info.plist in
 * native/coremidi-driver.
 */
export const DRIVER_BUNDLE_ID = "studios.eion.vrmc.midi.driver";

/**
 * Remove devices our driver left behind in the MIDI setup.
 *
 * WHY UNINSTALLING THE PLUGIN IS NOT ENOUGH
 * `MIDISetupAddDevice` writes the device into the *persisted* MIDI setup, not
 * into a list that lives as long as the driver. Delete the plugin and the
 * device stays — offline, unowned, and still listed in Audio MIDI Setup and in
 * every DAW's port menu. Nothing ever collects it, because from CoreMIDI's
 * point of view it is a device whose driver is merely absent, which is exactly
 * the state a real interface is in when it is unplugged.
 *
 * WHY THIS IS ALLOWED FROM HERE
 * `MIDISetupAddDevice` is drivers-only — *"Only MIDI drivers may make this
 * call"* — but its counterpart is not. `MIDISetupRemoveDevice` is documented
 * as something that *"should only be called from a studio configuration
 * editor, to remove a device which is offline and which the user has specified
 * as being permanently missing"*, which is precisely what uninstalling is: the
 * user has said this device is not coming back. It is the same call Audio MIDI
 * Setup's own Remove button makes.
 *
 * The same paragraph warns drivers off using it for a device that is merely
 * absent — *"drivers should set the device's kMIDIPropertyOffline to 1 so that
 * if the device reappears later, none of its properties are lost"*. That is
 * the running case, and is why the driver marks itself present rather than
 * adding and removing itself as the bridge comes and goes.
 *
 * MATCHED ON THE DRIVER, NOT THE NAME
 * `kMIDIPropertyDriverOwner` and nothing else. Matching "Launchpad Pro MK3"
 * would also match a real Launchpad Pro MK3 — and removing a device belonging
 * to somebody's actual hardware, from the setup where its configuration and
 * naming live, is a far worse bug than the one being fixed. A device our
 * driver did not create cannot carry our bundle id.
 *
 * @returns how many were removed, or -1 if CoreMIDI could not be reached
 */
export function removeDriverDevices(
  driverId: string = DRIVER_BUNDLE_ID,
): number {
  const b = bind();
  if (b === null) return -1;
  try {
    /*
     * Collected before removing any, then removed.
     *
     * `MIDIGetDevice` is an index into a list that this loop is about to
     * mutate, so removing as we walk would renumber everything after the
     * current position and skip the device that slid into it.
     */
    const ours: number[] = [];
    const total = b.deviceCount();
    for (let i = 0; i < total; i++) {
      const device = b.device(i);
      if (device === 0) continue;
      if (readProperty(b, device, b.property.driverOwner) === driverId) {
        ours.push(device);
      }
    }

    let removed = 0;
    for (const device of ours) {
      if (b.removeDevice(device) === 0) removed++;
    }
    return removed;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return -1;
  }
}
