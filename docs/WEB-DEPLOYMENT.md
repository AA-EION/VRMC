# Hosting the XR client on a website

The client is a static site. It builds to `apps/xr-client/dist/` and can be
served from any static host — including an existing site, under a path like
`/studio/` or on a subdomain.

But there is one constraint that shapes the whole deployment, and it is worth
understanding before you pick a hosting approach.

## The constraint: an HTTPS page cannot talk to a plain `ws://` bridge

Two rules collide here.

1. **WebXR requires a secure context.** `navigator.xr` is not exposed on a
   plain `http://` page (other than `http://localhost`, which does not help —
   the headset connects to a LAN address, not to its own loopback). So the
   client *must* be served over HTTPS.

2. **A secure page cannot open an insecure WebSocket.** Browsers block
   `ws://` from an HTTPS page as mixed content. The connection fails before it
   reaches the network, and the error the page receives says almost nothing.

Put together: **a client served over HTTPS can only reach a bridge that speaks
`wss://`.** This is the single most common reason a first deployment appears to
work in the headset and then silently refuses to connect.

The bridge supports TLS for exactly this reason:

```bash
pnpm bridge --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

What remains is getting a certificate the headset's browser will accept for a
machine on the user's own LAN. There are three workable answers.

## Option A — Wildcard DNS onto a private IP (recommended for a public site)

This is how Plex solves the same problem, and it is the only option that works
with no warnings and no per-user setup.

1. Get a wildcard certificate for a subdomain you control, e.g.
   `*.bridge.example.com`.
2. Publish DNS records that resolve to **private** addresses:
   `192-168-1-40.bridge.example.com → 192.168.1.40`. Either pre-generate the
   records for common LAN ranges, or run a small resolver that decodes the
   address from the hostname.
3. Ship the certificate with the bridge. The user's headset resolves
   `192-168-1-40.bridge.example.com`, connects to their own LAN, and gets a
   certificate that chains to a public root.

Trade-off: the certificate's private key ships to end users, so treat that
subdomain as compromised by design — never reuse it for anything else, and
scope the certificate to it alone.

## Option B — Serve the client from the bridge itself

Rather than hosting the client on the public site, have the bridge serve both
the static files and the WebSocket on one origin. Same-origin means the scheme
matches automatically, and there is one certificate to deal with instead of a
cross-origin pair.

Still needs a certificate the browser trusts, so it does not avoid Option A or
C — it just reduces the problem to one host. Good fit if the client is
distributed as part of a desktop app download rather than as a web page.

## Option C — Self-signed, accepted once

For development and for technically comfortable users:

1. Start the bridge with a self-signed certificate.
2. In the headset browser, visit `https://<bridge-ip>:7401` directly. The
   bridge answers a plain GET with a small JSON status document, which is
   enough to get the certificate warning on screen.
3. Accept the warning. The browser remembers it, and the WebSocket handshake
   to the same host and port now succeeds.

This is what `pnpm xr` does for the dev server via `@vitejs/plugin-basic-ssl`.
It is fine for development and a poor experience to ask of a customer.

## What will not work

- **A public HTTPS page reaching `ws://192.168.x.x`.** Blocked as mixed
  content. No header, CSP directive, or fetch option changes this.
- **Serving the client over plain HTTP on the LAN.** WebXR will not initialise:
  it is not a secure context, so `navigator.xr` is absent.
- **Tunnelling the bridge through a public relay.** It would resolve the
  certificate problem and destroy the thing the design exists for — a local
  hop is a couple of milliseconds, a round trip through a cloud relay is tens.

## Running it with Docker

The repository ships a container for the client, and nothing else:

```bash
cp .env.example .env      # optional; WEB_PORT defaults to 8080
docker compose up -d --build
```

That serves the built client on `127.0.0.1:8080`. Point your existing reverse
proxy at it:

```nginx
server {
    listen 443 ssl http2;
    server_name studio.example.com;

    # your certificate directives here

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Three deliberate choices in that setup:

**The container has no TLS and no proxy of its own.** It speaks plain HTTP and
issues no redirects, because the proxy in front owns the public scheme and
hostname. A container that redirected using its own view of those would emit
`http://` links on an `https://` site.

**The port is published on loopback only.** `127.0.0.1:${WEB_PORT}:80` rather
than `${WEB_PORT}:80`. The only thing that should reach it is the proxy on the
same host; binding the wildcard address would expose a plain HTTP port to the
network and offer a way to reach the site while bypassing TLS.

**The desktop bridge is not in the image.** It needs native MIDI addons and
access to the host's audio subsystem, neither of which works from a container
that only has to serve files — and the bridge belongs on the musician's
machine, not on a web server. The build installs only the client and the
workspace packages it depends on (`pnpm install --filter @vrmc/xr-client...`),
so the native addons are never fetched rather than fetched and discarded.

Remember that the proxy must serve HTTPS. WebXR requires a secure context: over
plain `http://` the page loads and then refuses to start a session, with
`navigator.xr` simply absent.

### Serve it at a root, not a subpath

The build emits absolute asset paths (`/assets/...`), so the client expects to
live at the root of whatever hostname serves it — `studio.example.com/`, or
`example.com/` — rather than under `example.com/studio/`. A subpath mount will
serve the document and then 404 every asset.

This is deliberate rather than an oversight: making it relocatable means baking
the base path in at build time (Vite's `base` option), which would turn one
image into one-image-per-mount-point. A subdomain costs a DNS record and keeps
the image generic. If you genuinely need a subpath, rebuild with
`vite build --base=/studio/` and adjust the nginx `location` to match.

## Static hosting checklist

- Serve over HTTPS with HTTP/2 or HTTP/3. The bundle is ~305 KB gzipped, split
  so that three.js caches independently of app code.
- Set long `Cache-Control` on `/assets/*` (the filenames are content-hashed)
  and `no-cache` on `index.html`.
- No cross-origin isolation headers are needed: the client uses no
  `SharedArrayBuffer`. If the surrounding site sets COOP/COEP, make sure the
  client's page is not caught by a COEP policy that would block its assets.
- WebXR needs no permissions-policy entry when same-origin. If the client is
  embedded in an `<iframe>`, the parent must grant `xr-spatial-tracking`.

## Embedding in an existing site

Give it its own full-page route rather than an iframe if you can — entering an
immersive session from a framed document works but adds the permissions-policy
requirement above and an extra layer to debug. If you do embed:

```html
<iframe src="/studio/" allow="xr-spatial-tracking; autoplay" ...></iframe>
```

`autoplay` matters too: the local click audio needs an AudioContext, which
starts suspended without a user gesture.
