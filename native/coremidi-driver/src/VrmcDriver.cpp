// SPDX-License-Identifier: GPL-3.0-only
//
// A CoreMIDI driver plugin that publishes one device with several ports.
//
// WHY THIS EXISTS
// Everything else in this repo opens *virtual endpoints* — MIDISourceCreate
// and MIDIDestinationCreate — because that is all an application is allowed to
// do. A virtual endpoint has no device behind it, so three of them are three
// devices in every DAW's port list, where a real Launchpad Pro MK3 is one
// device with three ports. CoreMIDI's own header is explicit that the API for
// the latter is not ours to call from an app: MIDIDeviceCreate takes a
// MIDIDriverRef owner, and MIDISetupAddDevice is documented for drivers.
//
// A driver is the thing that has a MIDIDriverRef. This is that driver.
//
// WHAT IT IS NOT, YET
// This is a spike, and it answers exactly one question: will MIDIServer on
// macOS 26 load a third-party MIDI driver plugin that carries only an ad-hoc
// signature? That question decides the whole approach, because the modern
// replacement — a MIDIDriverKit .dext — needs the restricted entitlement
// com.apple.developer.driverkit.family.midi, which Apple grants per developer
// account and which cannot be ad-hoc signed at all. If MIDIServer loads this,
// the device can present as hardware with no Apple Developer account and no
// change to how the app is distributed. If it refuses, no free path exists and
// we have spent days rather than weeks finding out.
//
// So Send() throws MIDI away and nothing connects this to the bridge. Adding
// that is the next step, and only worth taking if this one succeeds.
//
// LIFETIME AND THREADING
// This code runs inside MIDIServer, not inside the bridge — a crash here takes
// MIDI down for every application on the machine, which is why it does as
// little as possible. The header's rule: MIDISend and MIDIReceived may be
// called from any thread; every other CoreMIDI call must be made on the
// server's main thread, which is the thread the driver is created on and the
// one all of these entry points except Send() arrive on.

#include <CoreMIDI/CoreMIDI.h>
#include <CoreMIDI/MIDIDriver.h>
#include <CoreFoundation/CoreFoundation.h>

// Must match CFPlugInFactories and CFPlugInTypes in Info.plist. Generated
// once; changing it orphans any device MIDIServer has already persisted under
// the old id, so it does not change.
#define kVrmcFactoryUUID \
  CFUUIDGetConstantUUIDWithBytes(NULL, 0xA8, 0x86, 0x93, 0x48, 0x1A, 0x3B, \
                                 0x4F, 0x2A, 0x8A, 0x7C, 0x2A, 0x4F, 0x31, \
                                 0xAD, 0xD0, 0xEB)

namespace {

/*
 * The three ports of a Launchpad Pro MK3, in the order the hardware presents
 * them. Kept in step with packages/devices/src/launchpadProMk3.ts — the DAW
 * port is last on this model, which is what Live's Launchpad_Pro_MK3
 * capabilities describe (REMOTE, then a propless port, then SCRIPT).
 *
 * Each becomes one entity with one source and one destination, which is how a
 * real multi-port USB MIDI device appears: one device, three entities, six
 * endpoints.
 */
const CFStringRef kPortNames[] = {
    CFSTR("LPProMK3 MIDI"),
    CFSTR("LPProMK3 DIN"),
    CFSTR("LPProMK3 DAW"),
};
const ItemCount kPortCount = sizeof(kPortNames) / sizeof(kPortNames[0]);

const CFStringRef kDeviceName = CFSTR("Launchpad Pro MK3");
const CFStringRef kManufacturer = CFSTR("Focusrite - Novation");
const CFStringRef kModel = CFSTR("Launchpad Pro MK3");

/*
 * A CFPlugIn instance.
 *
 * `interface` must be the first member: a MIDIDriverRef is a
 * MIDIDriverInterface**, so the server dereferences the address of this struct
 * to reach the function table. Everything after it is ours.
 */
struct VrmcDriver {
  MIDIDriverInterface *interface;
  CFUUIDRef factoryID;
  UInt32 refCount;
};

// ---------------------------------------------------------------------------
// IUnknown
// ---------------------------------------------------------------------------

HRESULT QueryInterface(void *instance, REFIID iid, LPVOID *ppv) {
  CFUUIDRef requested = CFUUIDCreateFromUUIDBytes(NULL, iid);
  VrmcDriver *driver = reinterpret_cast<VrmcDriver *>(instance);

  /*
   * Version 2 or version 3, not version 1.
   *
   * Version 3 (macOS 12 and later) is the one MIDIServer asks for first on any
   * machine this targets: it carries MIDI through MIDIEventList rather than the
   * deprecated MIDIPacketList. Accepting both costs one extra entry point and
   * means the driver still works if the server falls back.
   *
   * Version 1 is refused. It would be a macOS 10.0-era server, and claiming it
   * while making version 2 calls in Start() would be a lie with a crash in it.
   */
  const bool wanted = CFEqual(requested, kMIDIDriverInterface3ID) ||
                      CFEqual(requested, kMIDIDriverInterface2ID) ||
                      CFEqual(requested, IUnknownUUID);
  CFRelease(requested);

  if (!wanted) {
    *ppv = NULL;
    return E_NOINTERFACE;
  }
  driver->refCount++;
  *ppv = instance;
  return S_OK;
}

ULONG AddRef(void *instance) {
  return ++reinterpret_cast<VrmcDriver *>(instance)->refCount;
}

ULONG Release(void *instance) {
  VrmcDriver *driver = reinterpret_cast<VrmcDriver *>(instance);
  if (--driver->refCount > 0) return driver->refCount;

  // Balances the CFPlugInAddInstanceForFactory in the factory function. Doing
  // this before the free matters: the framework may unload the bundle as a
  // result, and touching `driver` afterwards would be a use-after-free inside
  // MIDIServer.
  CFUUIDRef factoryID = driver->factoryID;
  free(driver->interface);
  free(driver);
  if (factoryID != NULL) {
    CFPlugInRemoveInstanceForFactory(factoryID);
    CFRelease(factoryID);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// MIDIDriverInterface
// ---------------------------------------------------------------------------

/*
 * Say the device is here.
 *
 * Without this it is *offline*: Audio MIDI Setup draws it greyed with
 * "Device is online" unchecked, and a host is entitled to skip an offline
 * device's endpoints entirely — which looks exactly like the driver having
 * loaded and done nothing useful. The header is explicit about whose job this
 * is: "1 = device is offline (is temporarily absent), 0 = present. Set by the
 * owning driver, on the device".
 *
 * On the device alone, because the same paragraph says the property "is
 * inherited from the device by its entities and endpoints" — setting it on
 * each of the three entities as well would be six redundant calls that could
 * disagree with each other.
 *
 * This is what a driver would toggle when its hardware is unplugged. Here the
 * device is emulated, so it is present from the moment the driver loads and
 * there is nothing that would ever make it absent — Stop() deliberately does
 * not set it back, because Stop() runs whenever MIDIServer goes idle.
 */
void markPresent(MIDIDeviceRef device) {
  if (device == 0) return;
  MIDIObjectSetIntegerProperty(device, kMIDIPropertyOffline, 0);
}

/*
 * Build the device, if the server is not already holding one for us.
 *
 * MIDIServer persists a driver's devices in the MIDI setup across restarts and
 * hands them back in `devList`, so creating unconditionally would add a second
 * Launchpad on every launch. Finding one there means it is already built and
 * already in the setup — but not that there is nothing to do: it still has to
 * be marked present, or it comes back from the persisted setup offline.
 */
OSStatus Start(MIDIDriverRef driver, MIDIDeviceListRef devList) {
  const ItemCount existing = MIDIDeviceListGetNumberOfDevices(devList);
  if (existing > 0) {
    // Already built, on a previous run, and handed back from the persisted
    // setup. Nothing to create — but it still has to be marked present, see
    // `markPresent`.
    for (ItemCount i = 0; i < existing; i++) {
      markPresent(MIDIDeviceListGetDevice(devList, i));
    }
    return noErr;
  }

  MIDIDeviceRef device = 0;
  OSStatus err =
      MIDIDeviceCreate(driver, kDeviceName, kManufacturer, kModel, &device);
  if (err != noErr) return err;

  for (ItemCount i = 0; i < kPortCount; i++) {
    MIDIEntityRef entity = 0;
    // `embedded` true: these ports are part of the device rather than sockets
    // it drives, which is what makes them show under one device instead of as
    // separate ones. One source and one destination each, as a USB MIDI cable
    // pair.
    err = MIDIDeviceAddEntity(device, kPortNames[i], true, 1, 1, &entity);
    if (err != noErr) {
      // Never leave a half-built device in the setup. It has not been added
      // yet, so disposing it is both allowed and the whole cleanup.
      MIDIDeviceDispose(device);
      return err;
    }
  }

  err = MIDISetupAddDevice(device);
  if (err != noErr) {
    MIDIDeviceDispose(device);
    return err;
  }

  markPresent(device);
  return noErr;
}

/*
 * A version 1 entry point. A version 2 driver does its work in Start, and the
 * header says so, but the table has no holes: leaving the pointer null would
 * be a crash if any server ever called it.
 */
OSStatus FindDevices(MIDIDriverRef, MIDIDeviceListRef) { return noErr; }

/*
 * Deliberately leaves the device in the setup.
 *
 * Stop is called when MIDIServer shuts down, which happens routinely — it is
 * launched on demand and exits when idle. Removing the device here would make
 * the Launchpad disappear and reappear underneath whatever had it open, and
 * a DAW that sees a control surface vanish unbinds its script.
 */
OSStatus Stop(MIDIDriverRef) { return noErr; }

OSStatus Configure(MIDIDriverRef, MIDIDeviceRef) { return noErr; }

/*
 * Where MIDI bound for the device arrives, on the server's I/O thread.
 *
 * Discarded, because nothing is behind this device yet — see the note at the
 * top. Returning noErr rather than an error is deliberate: an error here is
 * reported to whichever application sent the MIDI, and the spike is not a
 * reason for a DAW to show a write failure.
 */
OSStatus Send(MIDIDriverRef, const MIDIPacketList *, void *, void *) {
  return noErr;
}

/* The version 3 form of Send, taking a MIDIEventList. Discarded likewise. */
OSStatus SendPackets(MIDIDriverRef, const MIDIEventList *, void *, void *) {
  return noErr;
}

OSStatus EnableSource(MIDIDriverRef, MIDIEndpointRef, Boolean) { return noErr; }
OSStatus Flush(MIDIDriverRef, MIDIEndpointRef, void *, void *) { return noErr; }
OSStatus Monitor(MIDIDriverRef, MIDIEndpointRef, const MIDIPacketList *) {
  return noErr;
}
OSStatus MonitorEvents(MIDIDriverRef, MIDIEndpointRef, const MIDIEventList *) {
  return noErr;
}

/*
 * Every field, positionally, with no gaps.
 *
 * Deliberately not a designated or partial initializer, and built with
 * -Wmissing-field-initializers under -Werror: Apple has grown this table
 * before — SendPackets and MonitorEvents arrived with the version 3 interface
 * in macOS 12, and building against a 10.11 header left both slots null. A
 * null the server calls is a crash inside MIDIServer, which takes MIDI down
 * for every application on the machine. Failing the build is the better half
 * of that trade, so if this stops compiling against a future SDK the fix is to
 * implement the new entry point, not to silence the warning.
 */
MIDIDriverInterface kInterface = {
    NULL,  // _reserved, from IUNKNOWN_C_GUTS
    QueryInterface,
    AddRef,
    Release,
    FindDevices,
    Start,
    Stop,
    Configure,
    Send,
    EnableSource,
    Flush,
    Monitor,
    SendPackets,
    MonitorEvents,
};

}  // namespace

/*
 * The CFPlugIn factory. Named in Info.plist under the factory UUID, and
 * exported with C linkage so the name in the plist is the name in the symbol
 * table.
 *
 * `typeID` is how the server says which interface version it wants; anything
 * but a MIDI driver gets NULL rather than a plausible-looking table.
 */
extern "C" __attribute__((visibility("default"))) void *
VrmcDriverFactory(CFAllocatorRef, CFUUIDRef typeID) {
  if (!CFEqual(typeID, kMIDIDriverTypeID)) return NULL;

  VrmcDriver *driver = static_cast<VrmcDriver *>(malloc(sizeof(VrmcDriver)));
  if (driver == NULL) return NULL;

  // The table is copied per instance rather than shared: the server receives a
  // MIDIDriverInterface**, and handing every instance a pointer to one static
  // table would make two drivers indistinguishable by address.
  driver->interface =
      static_cast<MIDIDriverInterface *>(malloc(sizeof(MIDIDriverInterface)));
  if (driver->interface == NULL) {
    free(driver);
    return NULL;
  }
  *driver->interface = kInterface;

  driver->factoryID = static_cast<CFUUIDRef>(CFRetain(kVrmcFactoryUUID));
  CFPlugInAddInstanceForFactory(driver->factoryID);
  driver->refCount = 1;
  return driver;
}
