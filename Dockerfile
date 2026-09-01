# SPDX-License-Identifier: GPL-3.0-only
#
# The VRMC web tier: the XR client, plus the pairing service that introduces a
# headset to a bridge on someone's LAN.
#
# The desktop bridge is deliberately absent. It needs native MIDI addons and
# access to the host's audio subsystem, neither of which works from a container
# that only has to serve files — and it belongs on the musician's machine, not
# on a web server.

# ---------- build ----------
FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /app

# The client carries Playwright as a test dependency. Nothing here runs it, and
# a browser download would add hundreds of megabytes to a layer that is thrown
# away anyway.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1

# Manifests first, so a source-only change reuses the cached dependency layer.
# The bridge's manifest is copied because the lockfile refers to it and a frozen
# install validates the whole workspace — its dependencies are not installed,
# only its package.json read.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/layout/package.json packages/layout/
COPY packages/interaction/package.json packages/interaction/
COPY packages/devices/package.json packages/devices/
COPY apps/xr-client/package.json apps/xr-client/
COPY apps/web/package.json apps/web/
COPY apps/desktop-bridge/package.json apps/desktop-bridge/

# Only the client, the web tier, and the workspace packages they depend on. The
# bridge's native MIDI addons are never fetched rather than fetched and
# discarded.
RUN pnpm install --frozen-lockfile \
      --filter @vrmc/xr-client... \
      --filter @vrmc/web...

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/xr-client/ apps/xr-client/
COPY apps/web/ apps/web/

# Built in dependency order explicitly rather than through turbo: the filtered
# install does not pull in the root toolchain, and an explicit order is one less
# thing to go wrong in a build with no interactive shell.
RUN pnpm --filter @vrmc/protocol --filter @vrmc/layout \
         --filter @vrmc/interaction --filter @vrmc/devices build \
 && pnpm --filter @vrmc/xr-client build \
 && pnpm --filter @vrmc/web build

# Reduce to exactly what the runtime needs, so the final image carries no
# toolchain and no dev dependencies.
# --legacy because pnpm 10 otherwise refuses to deploy a workspace that does
# not set inject-workspace-packages. Setting that repo-wide would change how
# every package links during development, to fix one command in one image.
RUN pnpm --filter @vrmc/web deploy --prod --legacy /out \
 && cp -r apps/xr-client/dist /out/client \
 && rm -rf /out/src /out/test /out/tsconfig.json

# ---------- runtime ----------
FROM node:22-alpine AS runtime

# Run unprivileged. The base image ships a `node` user for exactly this.
USER node
WORKDIR /srv

COPY --from=build --chown=node:node /out /srv

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=/srv/client

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
