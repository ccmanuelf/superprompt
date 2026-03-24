# Convenience alias — points to the main clauded dockerfile
# Usage: docker build -t clauded .
# For docker-compose, use docker-compose.yml which references docker/clauded.dockerfile directly.

FROM node:22-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl minizinc && \
    npm install -g @anthropic-ai/claude-code && \
    rm -rf /var/lib/apt/lists/*

RUN groupadd -r clauded && useradd -r -g clauded -m clauded

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

RUN mkdir -p /app/store /app/workspace/uploads && \
    chown -R clauded:clauded /app

USER clauded

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "process.exit(0)" || exit 1

ENTRYPOINT ["node", "dist/index.js"]
