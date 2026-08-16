# syntax=docker/dockerfile:1
#
# Proxy node image: Squid plus the control plane agent.
#
# This is what an operator deploys on a proxy host. One container, one compose
# file, no Node.js and no build tooling on the host - only Docker, exactly like
# the control plane itself (PLAN.md Gate I, section 36).
#
# The agent is PID 1 and supervises Squid, so applying a new configuration is a
# `squid -k reconfigure` inside the container rather than a container restart.
# That is also why this image does not need the Docker socket (PLAN.md 27).

# --- build the agent ---------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/agent/package.json apps/agent/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY apps/agent apps/agent
RUN npm run build --workspace @scp/agent

# --- runtime -----------------------------------------------------------------
FROM ubuntu/squid:latest AS runtime

ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Squid Control Plane Node" \
      org.opencontainers.image.description="Squid with the control plane agent" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/fabsnmoe/squidui"

# The agent has no dependencies of its own, so the distribution's Node is
# enough and the image gains no npm tree.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/apps/agent/dist /opt/scp-agent
# The compiled output is ESM. Without this marker the distribution's Node reads
# the .js files as CommonJS and refuses the first import statement.
RUN printf '{"type":"module"}\n' > /opt/scp-agent/package.json

ENV AGENT_VERSION=${APP_VERSION} \
    SCP_STATE_DIR=/var/lib/scp-agent \
    SCP_POLL_INTERVAL_SECONDS=30

RUN mkdir -p /var/lib/scp-agent /etc/squid/scp && chmod 0700 /var/lib/scp-agent

EXPOSE 3128

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD squid -k check || exit 1

ENTRYPOINT ["node", "/opt/scp-agent/index.js"]
