# syntax=docker/dockerfile:1
# Radial without a window (radial serve) in a container, built from the
# radial-cli npm package as people install it (plans/headless-core.md, phase 5).
#
#   npm run pack:cli                                                    # dist/cli/radial-cli-<version>.tgz
#   docker build -f docker/Dockerfile -t radial dist/cli                # slim: no browser
#   docker build -f docker/Dockerfile --target browser -t radial-browser dist/cli
#
# Or from npm, with any folder as the context: --build-arg RADIAL_CLI=radial-cli@<version>.
#
# Run it, then make a token from the host:
#   docker run -d --name radial -p 4000-4020:4000-4020 -v radial-data:/data -v "$PWD":/work radial
#   docker exec radial radial token create laptop
#
# Port 4000 takes MCP (/mcp), the CLI (/rpc, RADIAL_URL and RADIAL_TOKEN) and
# events (/events). Each open project's preview gets a stable port of its own
# from 4001 up: publish the range one to one, so the addresses serve prints
# and its share links work from the host. /data keeps Radial's state (tokens,
# preview ports, recent projects); /work is for the sites.

ARG NODE_IMAGE=node:24-bookworm-slim

# 1. The package, installed into /opt/radial. node-pty, the agent terminals'
#    native module, comes prebuilt for Linux x64 and arm64; on any other
#    architecture radial-cli's postinstall compiles it here, with these tools,
#    which stay in this stage. npm 12 runs a package's install scripts only
#    when allowed, hence --allow-scripts (older npm runs them anyway).
FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
ARG RADIAL_CLI=
COPY . /tmp/radial-cli/
RUN set -eu; \
    if [ -n "$RADIAL_CLI" ]; then pkg="$RADIAL_CLI"; \
    else pkg="$(ls /tmp/radial-cli/radial-cli-*.tgz | sort -V | tail -n 1)"; fi; \
    npm install -g --prefix /opt/radial --no-audit --no-fund --no-update-notifier --foreground-scripts --allow-scripts="$pkg" "$pkg"; \
    /opt/radial/bin/radial --version

# 2. What radial serve runs with: git and ssh for the sites' repositories, ps
#    and lsof to find and clean up dev servers, CA certificates for HTTPS, and
#    tini as the init process, which reaps the exited processes the dev servers
#    and agent terminals leave behind (as PID 1, serve itself wouldn't).
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client procps lsof ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/radial /opt/radial
# Everything runs as the image's node user (uid 1000). Its own npm prefix lets
# it add agent CLIs (npm install -g @anthropic-ai/claude-code) without root.
ENV PATH=/home/node/.npm-global/bin:/opt/radial/bin:$PATH \
    NPM_CONFIG_PREFIX=/home/node/.npm-global \
    RADIAL_DATA_DIR=/data \
    RADIAL_CONTAINER=docker \
    SHELL=/bin/bash
RUN mkdir -p /data /work /home/node/.npm-global \
 && chown node:node /data /work /home/node/.npm-global
USER node
WORKDIR /work
VOLUME ["/data", "/work"]
EXPOSE 4000-4020
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s CMD ["radial", "serve", "status"]
# Listening on 0.0.0.0 with --allow-remote, because a container's network is a
# machine of its own: its loopback can't be reached from the host, through -p
# or otherwise. Every request still needs a token, and until one exists serve
# refuses them all and logs the docker exec line that makes one.
ENTRYPOINT ["/usr/bin/tini", "--", "radial", "serve", "--listen", "0.0.0.0:4000", "--allow-remote"]

# 3. The browser variant: Chrome Headless Shell and its system libraries, for
#    screenshots, page fields and migration compares. `radial browser install`
#    runs as root at build time, so it installs the libraries too, into a
#    folder every user reads (PLAYWRIGHT_BROWSERS_PATH). Docker's default
#    security profile gives Chrome no user namespaces, so it runs without its
#    sandbox here, and radial doctor says so.
FROM runtime AS browser
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN radial browser install \
 && chmod -R a+rX /opt/ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache
USER node

# The default image: no browser. Page work refuses, saying `radial browser install` adds one.
FROM runtime AS slim
