# ---- Stage 1: Build client ----
FROM node:20-alpine AS client-builder

WORKDIR /app/client
COPY client/package.json client/package-lock.json* client/pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --no-frozen-lockfile
COPY client/ ./
RUN pnpm run build

# ---- Stage 2: Production image ----
FROM node:20-alpine AS production

# ffmpeg + native build deps (needed for better-sqlite3, sharp, etc.)
RUN apk add --no-cache ffmpeg python3 make g++

# Skip Puppeteer chromium download (headless scraping not needed in prod)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Install server production deps using npm (no pnpm needed for server)
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Copy server source
COPY server/ ./server/

# Copy built client from stage 1
COPY --from=client-builder /app/client/dist ./client/dist

# Persistent data volume mount point
RUN mkdir -p /data

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001

CMD ["node", "server/index.js"]
