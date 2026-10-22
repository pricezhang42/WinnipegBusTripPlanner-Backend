# syntax=docker/dockerfile:1
# Multi-stage build: compile TypeScript in a full-deps image, run from a slim image with prod deps only.

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY data ./data
# The reliability store pinned by the lock (if any), checked against its SHA-256.
# It is used only where RELIABILITY_STORE_PATH=/app/reliability/reliability.sqlite.
COPY scripts/fetch-reliability-store.mjs ./scripts/
COPY package.json reliability-store.lock.jso[n] ./
RUN node scripts/fetch-reliability-store.mjs

# Non-root
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 8787
CMD ["node", "dist/index.js"]
