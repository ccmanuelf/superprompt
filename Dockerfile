# Convenience alias — points to the main Luna dockerfile
# Usage: docker build -t luna .
# For docker-compose, use docker-compose.yml which references docker/luna.dockerfile directly.

FROM node:26-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:26-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl minizinc && \
    npm install -g @anthropic-ai/claude-code && \
    rm -rf /var/lib/apt/lists/*

RUN groupadd -r luna && useradd -r -g luna -m luna

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

RUN mkdir -p /app/store /app/workspace/uploads && \
    chown -R luna:luna /app

USER luna

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s \
    CMD curl -fsS -o /dev/null http://127.0.0.1:3030/api/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
