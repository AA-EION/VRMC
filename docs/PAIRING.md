# Pairing: connecting a headset to a bridge

The XR client is served from `https://vrmc.eionstudios.com`. The bridge runs on
a musician's own computer, on a private network. This is how they find each
other.

## Why it needs setting up at all

A page served over HTTPS may only open `wss://`, and only to a certificate the
browser already trusts. The browser never *navigates* to the bridge, so there is
no moment at which the user could accept a self-signed certificate — the
WebSocket handshake simply fails, with no prompt and a useless error.

So the bridge needs a genuinely valid certificate, for a hostname that resolves
to a private address. That is possible, and it is what Plex does:

```
192-168-1-42.lan.vrmc.eionstudios.com   →   A record   →   192.168.1.42
```

The name is public and resolvable by anyone. The address it resolves to is on
the user's LAN. A real wildcard certificate for `*.lan.vrmc.eionstudios.com`
covers it, so the headset connects with no warning — and the packets never leave
the local network.

## What you have to set up, once

### 1. DNS

Publish records under `lan.vrmc.eionstudios.com` that decode a dashed IPv4 label
back to the address. Two ways:

- **A small resolver.** Answer any `a-b-c-d.lan.vrmc.eionstudios.com` with
  `a.b.c.d`, refusing anything outside RFC 1918. About thirty lines with any DNS
  library, and it is what Plex runs.
- **Pre-generated records.** Feasible if you only support one range: a `/24`
  needs 254 records. A full `10/8` does not fit this approach.

Refuse to answer with public addresses. A resolver that happily returns
`8.8.8.8` for `8-8-8-8.lan…` hands anyone a valid-certificate name pointing at a
third party.

### 2. Certificate

A wildcard for `*.lan.vrmc.eionstudios.com`, via Let's Encrypt with a DNS-01
challenge. Renew it the usual way and ship the new one with bridge updates.

**The trade-off, stated plainly:** the private key ships inside the bridge, to
every user. It is public in practice. Treat that subdomain as compromised by
design — scope the certificate to it alone, never reuse it, and never let it
near anything else. Plex accepts exactly this; it is the price of a trusted
certificate on someone else's LAN.

### 3. Point the pieces at it

```bash
# Web container
LAN_DOMAIN=lan.vrmc.eionstudios.com

# Bridge
vrmc-bridge --lan-domain lan.vrmc.eionstudios.com \
            --tls-cert wildcard.pem --tls-key wildcard.key
```

Without the shipped certificate the bridge falls back to one it generates
itself, which works for a client served from the bridge but not from your site.

## How pairing works

The remaining problem is *which* address, since a browser cannot enumerate the
local network.

1. The bridge generates a six-character code on first run and keeps it, so a
   restart does not invalidate one the user wrote down.
2. Every 40 seconds it posts that code plus its private addresses to
   `POST /api/pair`. Registrations expire after two minutes, so a bridge that
   stops running stops being findable with nothing to clean up.
3. The user types the code in the headset. The client calls
   `GET /api/pair/<code>`, gets the addresses back, and builds
   `wss://192-168-1-42.lan.vrmc.eionstudios.com:7401`.
4. It races every candidate and keeps the first that opens — a computer on both
   Wi-Fi and Ethernet publishes several, and only one shares a network with the
   headset. Asking the user which interface their computer is on is not a
   question a musician should have to answer.
5. The address is remembered. The code is never needed again on that headset.

**No MIDI passes through the service.** It makes an introduction and gets out of
the way. Everything after step 3 is direct, on the LAN, at LAN latency.

### What the service holds

A code, a handful of private IPs, a machine name and a version — in memory, for
two minutes, gone on restart. There is no database because there is nothing
worth persisting.

## Choices that are load-bearing

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

## If you would rather not run any of this

Set `--pair-service ""` on the bridge and the code is never published. The
dashboard still shows the LAN addresses, and the client's "Enter an address
instead" field takes them directly. Everything works; the user types an address
rather than a code.

## Not yet verified

None of this has run against real DNS or a real certificate. The service, the
code handling and the address filtering are covered by tests; the DNS zone, the
wildcard certificate and a Quest browser resolving these names are not, because
they need infrastructure that does not exist yet. The first end-to-end pairing
is the real test.
