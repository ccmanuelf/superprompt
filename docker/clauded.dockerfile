FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ─────────────────────────────────────────

FROM node:22-slim

WORKDIR /app

# Install runtime dependencies
# - curl: health checks
# - claude CLI: AI provider (installed via npm globally)
# NOTE: Pin to @latest and bust cache with date to keep in sync with host
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    npm install -g @anthropic-ai/claude-code@latest && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r clauded && useradd -r -g clauded -m clauded

# Copy built app and node_modules from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Copy runtime files (banner, system prompt, entrypoint)
COPY banner.txt CLAUDED.md ./
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create runtime directories
RUN mkdir -p /app/store /app/workspace/uploads && \
    chown -R clauded:clauded /app

# Switch to non-root user
USER clauded

# Health check — verify the process is running
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "process.exit(0)" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
