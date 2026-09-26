# syntax=docker/dockerfile:1
# Multi-stage build: compile TypeScript in a full-deps image, run from a slim image with prod deps only.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY data ./data

# Non-root
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 8787
CMD ["node", "dist/index.js"]
