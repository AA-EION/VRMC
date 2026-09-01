# Pairing: connecting a headset to a bridge

The XR client is served from `https://vrmc.eionstudios.com`. The bridge runs on
a musician's own computer, on a private network. This is how they find each
other, and what the user has to do about it: read six characters off the desktop
app and type them in the headset. That is the whole procedure. No DNS, no
certificates, no port forwarding, no addresses.

## Why this was hard

A page served over HTTPS may only open `wss://`, and only to a host whose
certificate the browser already trusts. The browser never *navigates* to the
bridge, so there is no moment at which the user could accept a self-signed
certificate — the WebSocket handshake just fails, with no prompt and a useless
error.

The usual answer is to own a wildcard domain whose subdomains decode to private
addresses (`192-168-1-42.lan.example.com` → `192.168.1.42`), get a real
certificate for it, and ship the private key to every user. It works — it is
what Plex does — but it means running a DNS zone, renewing a wildcard
certificate, and shipping a private key that is public in practice.

**None of that is necessary, because the constraint is a WebSocket constraint.**

## What we do instead

A WebRTC data channel. Two peers exchange DTLS fingerprints during the
handshake and verify each other against them directly. There is no certificate
authority in the picture, so there is nothing to obtain, install, trust or
renew, and no name that has to resolve anywhere.

It is also the better transport for this. The channel is configured unordered
and unreliable (`ordered: false, maxRetransmits: 0`), which is what MIDI wants:
a note that arrives late is worse than one that never arrives, and TCP's
in-order delivery means a single lost packet stalls every packet behind it — a
gap in the music followed by a burst of notes that are all wrong. The WebSocket
forced that compromise. It is gone.

## How it works

```
headset (browser)          vrmc.eionstudios.com          bridge (your computer)
      │                            │                             │
      │                            │◀──── POST /api/pair ────────│  code + name
      │                            │◀──── GET /api/signal/CODE ──│  (long poll)
      │─── GET /api/pair/CODE ────▶│                             │
      │─── POST /api/signal/CODE ─▶│──────── offer ─────────────▶│
      │                            │◀─────── answer ─────────────│
      │◀── GET /api/signal/CODE/… ─│                             │
      │                            │                             │
      │═════════════ DTLS + SCTP data channel, direct ═══════════│
                        MIDI, on the LAN, at LAN latency
```

1. The bridge generates a six-character code on first run and keeps it, so a
   restart does not invalidate one the user wrote down. Every 40 seconds it
   registers that code; registrations expire after two minutes, so a bridge that
   stops running stops being findable with nothing to clean up.
2. The bridge long-polls `GET /api/signal/<code>`, waiting for a headset. It has
   no public address, so it cannot be dialled — it has to reach out and wait.
3. The user types the code in the headset. The client checks it with
   `GET /api/pair/<code>` first, so a mistyped code fails immediately with
   something readable rather than after a handshake times out.
4. The client creates an offer, gathers its candidates, and posts it. The
   bridge's poll returns instantly, it answers, and the client's poll returns
   that answer.
5. The data channel forms directly between the two machines and everything
   musical goes over it.
6. The code is remembered in the headset. Every later visit reconnects on its
   own, and the code is never needed again.

**No MIDI passes through the service.** Two SDP blobs cross it per connection,
and they describe how to reach a private address that is useless to anyone
outside the network it names.

### What the service holds

A code, a handful of private IPs, a machine name, a version, and — for at most
two minutes — one offer and one answer. All in memory, gone on restart. There is
no database because there is nothing worth persisting.

### No ICE servers

Both peers are on the same network, so their host candidates are all that is
needed. `iceServers: []` on both sides means nothing outside the LAN is
contacted while connecting, not even to discover an address. There is no STUN
server to run and no TURN relay that could end up carrying the audio path.

## Choices that are load-bearing

**Signalling is refused for a code no bridge has claimed.** Without that check
the endpoint would be an open message queue keyed by any string a caller cared
to invent.

**Registrations naming a public address are refused.** Accepting one would let a
registration point every headset that types that code at a machine on the open
internet — both an attack on a third party and a way to leak a user's traffic.

**Unknown and expired codes give the same answer.** Distinguishing them would
let someone probe which codes are live.

**The code alphabet excludes both halves of every confusable pair.** No `0` and
no `O`, no `1`, `I` or `L`. There is nothing to misread *into*, because neither
character is ever in a code.

**Normalisation does not "correct" a misread character.** Since the alphabet
excludes both halves of each pair, a code containing `O` was misread, not
mistyped, and there is no valid character to map it to. Guessing would turn a
clear "that is not a valid code" into a silent lookup against somebody else's
bridge.

**Rate limited to 60 requests a minute per caller.** The code space is 24^6, so
this turns guessing from an afternoon's work into years. The forwarded address
is used where present and is spoofable, which is acceptable: this is a brake on
guessing, not an authentication boundary.

**Both polls are long-held rather than repeated.** A bridge polling every second
would add up to a second to every connection for no benefit, and one polling
faster is just busier. Held requests mean the connection starts the moment the
other side appears.

## The WebSocket is still there

It serves the case where the client and the bridge are on the same machine — the
desktop dashboard, or `pnpm xr` during development — where plain `ws://` is
already a secure context and none of the above applies. The client's "Enter an
address instead" field targets it.

It is plain `ws://` by default now. `--self-signed-tls` still generates a
certificate if you want one, but it buys nothing: a browser will not trust it,
and the path that needed trust no longer exists.

## Running without the service

Set `--pair-service ""` on the bridge and nothing is published — no code, and no
signalling. The dashboard still shows the LAN addresses and the client's address
field takes them directly, which works when the page is served over plain HTTP.

## What is and is not verified

Covered by tests, including a full handshake between two real peers over the
real signalling service — offer, answer, DTLS, data channel, a note into a
virtual MIDI port and an LED write back (`apps/desktop-bridge/test/webrtc.test.ts`):

- the signalling endpoints, their limits and their refusals
- the bridge's polling client and its backoff
- code generation, normalisation, expiry and address filtering
- MIDI in both directions across a live data channel

Not yet verified: a Quest browser as the offering peer, and a real home network
between the two. The peer here is libdatachannel rather than Chromium, and both
ends are on loopback. What the browser does differently — its candidate
gathering and its own DTLS stack — is standard interop, but it has not been run.
