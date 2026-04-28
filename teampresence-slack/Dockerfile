# Gen Pulse — production Dockerfile for Cloud Run.
#
# Multi-stage on purpose:
#
#  1. "builder" — has the toolchain needed to compile native Node
#     deps (better-sqlite3 pulls python3 / make / g++). We run
#     `npm ci --omit=dev` here so node_modules/ ends up lean.
#  2. "runtime" — ships only the pruned node_modules + app source
#     on top of a plain slim image. No compiler, no apt cache, no
#     build scratch — the final image is ~180 MB vs ~620 MB for
#     the previous single-stage build, which roughly halves
#     Cloud Run cold-start.
#
# Security baseline:
#  - Runs as a dedicated non-root user (`app`, uid 10001) so a
#    remote-code-execution hole in any dep can't own the
#    container filesystem.
#  - Writes no state to disk at runtime (the SQLite cache lives
#    in /tmp, which is a tmpfs on Cloud Run). Cache rebuilds from
#    Slack/Jira/Workday on every cold start — matches the
#    "ephemeral" storage choice confirmed with Kevin on 28-Apr-2026.
#  - No secrets are baked in. Azure AD client secret, Slack bot
#    token, Jira PAT etc. are bound from Secret Manager at
#    `gcloud run deploy --set-secrets` time.

# syntax=docker/dockerfile:1.7

# ---------- 1. builder ----------------------------------------------------
FROM node:20-bookworm-slim AS builder

# Native-module toolchain. We intentionally DON'T put this in the runtime
# stage — the compiled .node files are portable across glibc-compatible
# Debian slim images, so the runtime layer stays compiler-free.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy only the manifests first so `npm ci` gets a clean cache layer that
# survives any source-code change. The layer is only busted when
# package.json or package-lock.json actually change.
COPY package.json package-lock.json ./

# `npm ci` enforces the lockfile (deterministic, reproducible builds) and
# `--omit=dev` prunes devDependencies so the resulting node_modules/
# matches what production actually needs.
#
# `--ignore-scripts=false` is the default and we leave it that way on
# purpose: better-sqlite3 needs its postinstall build step to produce
# the native binding. If we ever switch to a prebuilt-only dep set, we
# can flip this to `--ignore-scripts` for a further safety hardening.
RUN npm ci --omit=dev --no-audit --no-fund --prefer-offline \
  && npm cache clean --force

# ---------- 2. runtime ----------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# Make apt-get installs here strictly minimal — tini (so PID 1 reaps
# zombies cleanly on Cloud Run SIGTERM) and the CA bundle so outbound
# TLS to Jira/Slack/Microsoft works out of the box. No compilers.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini \
      ca-certificates \
      curl \
  && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. uid/gid 10001 is an arbitrary high number
# chosen to avoid collisions with any distro system accounts.
RUN groupadd --system --gid 10001 app \
 && useradd  --system --uid 10001 --gid app --home /app --shell /sbin/nologin app

WORKDIR /app

# Copy the lean node_modules from the builder + source from the build
# context. Ownership is set to the non-root user in the same COPY so
# we don't need a separate `chown -R` layer.
COPY --from=builder --chown=app:app /build/node_modules ./node_modules
COPY --chown=app:app package.json package-lock.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app public ./public

# Production environment defaults. Anything sensitive is passed in at
# runtime via --set-env-vars / --set-secrets; these four are just
# baseline flags that don't change between environments.
ENV NODE_ENV=production \
    PORT=8080 \
    NPM_CONFIG_LOGLEVEL=warn \
    NODE_OPTIONS=--enable-source-maps

# Cloud Run ignores EXPOSE (it reads the PORT env var) but we keep it
# for local `docker run -p 8080:8080` parity.
EXPOSE 8080

# Health probe — hits /healthz which already exists in src/web.js.
# Cloud Run's managed startup/liveness probes can target the same path;
# this HEALTHCHECK is for local `docker` users and non-Cloud-Run hosts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail --silent --max-time 4 "http://127.0.0.1:${PORT}/healthz" || exit 1

USER app

# `tini` as PID 1 guarantees SIGTERM propagates to node and any
# child processes (e.g. the Slack socket-mode worker) when Cloud
# Run scales the instance to zero. Without it, the container gets
# a 10-second SIGKILL grace period and we can lose in-flight
# Jira/Slack requests mid-fetch.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
