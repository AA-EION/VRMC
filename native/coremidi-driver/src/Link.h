// SPDX-License-Identifier: GPL-3.0-only
#pragma once

// The driver's end of the link to the bridge.
//
// THREADING, WHICH IS THE WHOLE DIFFICULTY
// CoreMIDI's own header states the rules: MIDISend and MIDIReceived may be
// called from any thread, and *every other* CoreMIDI call must be made on the
// server's main thread. On top of that, `Send()` arrives on MIDIServer's I/O
// thread, which is shared with every other MIDI device on the machine — so
// anything slow or blocking there stutters somebody else's audio.
//
// Hence: `Send()` does a non-blocking write and nothing else. It never blocks,
// never allocates, and never waits for a reconnect. A separate thread owns the
// socket's lifetime — connecting, retrying, reading — and calls MIDIReceived,
// which the header permits from any thread.
//
// WHY THE WRITE MAY BE DROPPED RATHER THAN QUEUED
// If the socket's buffer is full, the bridge is not reading, which means it is
// wedged or gone. Queueing would grow without bound behind a peer that is not
// coming back, and the queue would then be delivered as a burst of notes
// minutes late. A dropped LED update is repainted by the next one; a dropped
// note is one note. Both are better than an unbounded buffer inside MIDIServer.
//
// WHY THE SOCKET IS NOT IN /tmp
// It is under the user's Application Support directory, which is theirs alone.
// A socket in /tmp is writable by every local account, and this one carries
// every note played.

#include "Framing.h"

#include <errno.h>
#include <pthread.h>
#include <pwd.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>

namespace vrmc {

/// Called on the link's own thread when MIDI arrives from the bridge.
using LinkMidiHandler = void (*)(void *context, uint8_t kind, uint8_t address,
                                 const uint8_t *data, size_t length);
/// Called on the link's own thread when the link comes up or goes down.
using LinkStateHandler = void (*)(void *context, bool connected);

class Link {
 public:
  /// The socket path, under the user's own Application Support directory.
  ///
  /// Resolved from the passwd database rather than $HOME: the driver runs
  /// inside MIDIServer, whose environment is launchd's and not a login shell's,
  /// so $HOME is not something to rely on. It is read once into a fixed buffer
  /// — no allocation, and nothing to free on a path that runs at load time.
  static const char *SocketPath() {
    static char path[512] = {};
    if (path[0] != '\0') return path;
    const char *home = nullptr;
    if (const struct passwd *pw = getpwuid(getuid())) home = pw->pw_dir;
    if (home == nullptr || home[0] == '\0') home = getenv("HOME");
    if (home == nullptr || home[0] == '\0') return "";
    snprintf(path, sizeof(path),
             "%s/Library/Application Support/VRMC/driver.sock", home);
    return path;
  }

  void Start(LinkMidiHandler onMidi, LinkStateHandler onState, void *context) {
    onMidi_ = onMidi;
    onState_ = onState;
    context_ = context;
    running_.store(true, std::memory_order_release);
    pthread_create(&thread_, nullptr, &Link::Run, this);
    started_ = true;
  }

  void Stop() {
    if (!started_) return;
    running_.store(false, std::memory_order_release);
    // Shutting the socket down is what wakes a blocked read; without it the
    // join waits for the peer to say something, which it may never do.
    const int fd = fd_.load(std::memory_order_acquire);
    if (fd >= 0) ::shutdown(fd, SHUT_RDWR);
    pthread_join(thread_, nullptr);
    started_ = false;
  }

  bool Connected() const { return fd_.load(std::memory_order_acquire) >= 0; }

  /// Send MIDI to the bridge. Safe from MIDIServer's I/O thread.
  ///
  /// Returns false if it went nowhere — no link, or the socket would have
  /// blocked. Callers do not retry: see the note at the top about why dropping
  /// beats queueing here.
  bool SendMidi(uint8_t port, const uint8_t *data, size_t length) {
    const int fd = fd_.load(std::memory_order_acquire);
    if (fd < 0) return false;
    uint8_t frame[kMaxFrameBytes];
    const size_t written =
        EncodeFrame(frame, sizeof(frame), kFrameMidi, port, data, length);
    if (written == 0) return false;
    return WriteAll(fd, frame, written);
  }

 private:
  /// Write with MSG_DONTWAIT, treating a partial write as a failure.
  ///
  /// A partial write on a message-framed stream is worse than none: the peer
  /// would read a header whose body never arrives and stall on it forever. So
  /// a frame goes entirely or not at all. MSG_NOSIGNAL because a write to a
  /// closed socket otherwise raises SIGPIPE, which would take MIDIServer down
  /// — and with it MIDI for every application on the machine.
  static bool WriteAll(int fd, const uint8_t *data, size_t length) {
    const ssize_t n =
        ::send(fd, data, length, MSG_DONTWAIT | MSG_NOSIGNAL);
    return n == static_cast<ssize_t>(length);
  }

  static void *Run(void *self) {
    static_cast<Link *>(self)->Loop();
    return nullptr;
  }

  void Loop() {
    while (running_.load(std::memory_order_acquire)) {
      const int fd = Connect();
      if (fd < 0) {
        // A second between attempts. The bridge is often simply not running —
        // MIDIServer loads this driver whenever anything touches MIDI — so
        // this is the ordinary state, not an error worth spinning on.
        for (int i = 0; i < 10 && running_.load(std::memory_order_acquire); i++) {
          usleep(100 * 1000);
        }
        continue;
      }

      fd_.store(fd, std::memory_order_release);
      reader_.Reset();
      {
        const uint8_t version = kProtocolVersion;
        uint8_t hello[kMaxFrameBytes];
        const size_t n =
            EncodeFrame(hello, sizeof(hello), kFrameHello, 0, &version, 1);
        WriteAll(fd, hello, n);
      }
      if (onState_) onState_(context_, true);

      uint8_t chunk[4096];
      for (;;) {
        const ssize_t got = ::recv(fd, chunk, sizeof(chunk), 0);
        if (got <= 0) break;  // 0 is a clean close; <0 an error or shutdown
        if (!reader_.Push(chunk, static_cast<size_t>(got), &Link::OnFrame,
                          this)) {
          break;  // not this protocol; there is nothing to resynchronise to
        }
      }

      fd_.store(-1, std::memory_order_release);
      ::close(fd);
      if (onState_) onState_(context_, false);
    }
  }

  static void OnFrame(void *context, uint8_t kind, uint8_t port,
                      const uint8_t *payload, size_t length) {
    auto *self = static_cast<Link *>(context);
    switch (kind) {
      case kFrameMidi:
      case kFrameDeviceState:
        // Both are addressed to a device, and both are the driver's to act on;
        // the handler tells them apart by `kind`.
        if (self->onMidi_) {
          self->onMidi_(self->context_, kind, port, payload, length);
        }
        break;
      case kFramePing: {
        const int fd = self->fd_.load(std::memory_order_acquire);
        if (fd < 0) break;
        uint8_t pong[kHeaderBytes];
        const size_t n = EncodeFrame(pong, sizeof(pong), kFramePong, 0, nullptr, 0);
        WriteAll(fd, pong, n);
        break;
      }
      default:
        // Hello, pong, or something a newer bridge sends. Ignoring unknown
        // kinds is what lets the format grow without old drivers refusing to
        // talk to new bridges.
        break;
    }
  }

  static int Connect() {
    const char *path = SocketPath();
    if (path[0] == '\0') return -1;
    const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(addr.sun_path)) {
      ::close(fd);
      return -1;
    }
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

    if (::connect(fd, reinterpret_cast<struct sockaddr *>(&addr),
                  sizeof(addr)) != 0) {
      ::close(fd);
      return -1;
    }
    return fd;
  }

  FrameReader reader_;
  std::atomic<int> fd_{-1};
  std::atomic<bool> running_{false};
  pthread_t thread_ = {};
  bool started_ = false;
  LinkMidiHandler onMidi_ = nullptr;
  LinkStateHandler onState_ = nullptr;
  void *context_ = nullptr;
};

}  // namespace vrmc
