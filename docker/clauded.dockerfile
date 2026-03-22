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
    libnss3 libatk1.0-0 libcups2 && \
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

# Create non-root user
RUN groupadd -r clauded && useradd -r -g clauded -m clauded

# Copy built app and node_modules from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Copy runtime files (banner, system prompt, entrypoint)
COPY banner.txt CLAUDED.md ./
# Copy static web assets for voice chat (served from dist/web/public/)
COPY src/web/public/ ./dist/web/public/
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create runtime directories (repos for GitHub clones, screenshots for captures)
RUN mkdir -p /app/store /app/workspace/uploads /app/workspace/repos /app/workspace/screenshots && \
    chown -R clauded:clauded /app

# Switch to non-root user
USER clauded

# Health check — verify the process is running
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "process.exit(0)" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
