# SPDX-License-Identifier: GPL-3.0-only
#
# The VRMC XR client, as a static site.
#
# This image contains the headset-facing web client and nothing else. The
# desktop bridge is deliberately absent: it needs native MIDI addons and access
# to the host's audio subsystem, neither of which belongs in — or works from —
# a container that only has to serve files. Bridge binaries are built by the
# release workflow and downloaded separately.

# ---------- build ----------
FROM node:22-alpine AS build

# corepack activates the pnpm version pinned in package.json's packageManager,
# so the image builds with the same pnpm the repository is developed against.
RUN corepack enable
WORKDIR /app

# The client carries Playwright as a test dependency. Nothing here runs it, and
# a browser download would add hundreds of megabytes to a layer that is thrown
# away anyway. Current versions only fetch browsers on an explicit
# `playwright install`, so this is belt and braces rather than load-bearing.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1

# Manifests first, so a source-only change reuses the cached dependency layer.
# The bridge's manifest is copied because the lockfile refers to it and a
# frozen install validates the whole workspace — its dependencies are not
# installed, only its package.json read.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/layout/package.json packages/layout/
COPY packages/interaction/package.json packages/interaction/
COPY packages/devices/package.json packages/devices/
COPY apps/xr-client/package.json apps/xr-client/
COPY apps/desktop-bridge/package.json apps/desktop-bridge/

# `--filter @vrmc/xr-client...` installs the client and the workspace packages
# it depends on, and nothing else. That keeps the bridge's native MIDI addons
# out of the image entirely rather than installing and then discarding them.
RUN pnpm install --frozen-lockfile --filter @vrmc/xr-client...

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/xr-client/ apps/xr-client/

# Built explicitly in dependency order rather than through turbo: the filtered
# install above does not pull in the root toolchain, and an explicit order is
# one less thing to go wrong in a build with no interactive shell.
RUN pnpm --filter @vrmc/protocol --filter @vrmc/layout \
         --filter @vrmc/interaction --filter @vrmc/devices build \
 && pnpm --filter @vrmc/xr-client build

# ---------- runtime ----------
FROM nginx:1.27-alpine AS runtime

# Only the built assets cross over. No node, no sources, no toolchain.
COPY --from=build /app/apps/xr-client/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# nginx's own image drops to an unprivileged worker after binding port 80.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
