# syntax=docker/dockerfile:1
#
# Multi-stage build for the web UI (PLAN.md section 8):
#   node build image -> npm ci -> vite build -> minimal nginx runtime.

# --- dependencies ------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

# --- build -------------------------------------------------------------------
FROM deps AS build
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
ENV VITE_APP_VERSION=${APP_VERSION} \
    VITE_GIT_SHA=${GIT_SHA} \
    VITE_BUILD_DATE=${BUILD_DATE}
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/ui packages/ui
COPY apps/web apps/web
RUN npm run build --workspace @scp/shared \
 && npm run build --workspace @scp/web

# --- runtime -----------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Squid Control Plane Web" \
      org.opencontainers.image.description="Web UI for the Squid control plane" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/example/squid-control-plane" \
      org.opencontainers.image.licenses="See LICENSE"

COPY deployments/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
