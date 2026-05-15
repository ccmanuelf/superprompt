FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3, canvas)
RUN apt-get update && apt-get install -y python3 make g++ \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ─────────────────────────────────────────

FROM node:22-slim

WORKDIR /app

# Install runtime dependencies
# - curl, git: basics
# - gh: GitHub CLI for repo operations
# - claude CLI: AI provider (installed via npm globally)
# - chromium + deps: Puppeteer screenshots (set PUPPETEER_SKIP_DOWNLOAD=true to use system chromium)
# NOTE: Pin to @latest and bust cache with date to keep in sync with host
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl git ca-certificates libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
    libjpeg62-turbo libgif7 librsvg2-2 \
    chromium libatk-bridge2.0-0 libdrm2 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libasound2 libxshmfence1 \
    libnss3 libatk1.0-0 libcups2 \
    minizinc && \
    npm install -g @anthropic-ai/claude-code@latest && \
    rm -rf /var/lib/apt/lists/*

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Non-root user — reuse 'node' user (UID 1000, already in base image)
# UID 1000 matches default host user on macOS/Linux for volume permissions

# Copy built app and node_modules from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Copy runtime files (banner, entrypoint)
COPY banner.txt ./
# Copy static web assets for voice chat (served from dist/web/public/)
COPY src/web/public/ ./dist/web/public/
# rc.98 — forge eval prompts (grader-luna.md is read at module load by
# src/forge/eval/runner.ts; tsc only emits .js so .md files are not in
# dist by default).
COPY src/forge/eval/prompts/ ./dist/forge/eval/prompts/
# Copy documentation (served via /docs web UI and /api/docs endpoint)
COPY docs/ ./docs/
# Copy domain packs (tools, skills, templates for department customization)
COPY packs/ ./packs/
# Copy forge directory (user tools and skills for auto-import)
COPY forge/ ./forge/
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create runtime directories (repos for GitHub clones, screenshots for captures)
RUN mkdir -p /app/store /app/workspace/uploads /app/workspace/repos /app/workspace/screenshots && \
    chown -R node:node /app

# Switch to non-root user (node, UID 1000)
USER node

# Health check — probe the HTTP server's /api/health endpoint (curl is
# installed above; route is registered at src/web/server.ts and returns 204
# when the voice server is up). Matches the docker-compose.yml healthcheck so
# standalone `docker run` and `docker compose up` report the same liveness.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s \
    CMD curl -fsS -o /dev/null http://127.0.0.1:3030/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
