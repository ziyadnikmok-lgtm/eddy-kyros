# ---- Stage 1: Build the real nested client ----
FROM node:20-alpine AS client-builder

WORKDIR /app/client
COPY ai-content-studio-saas-main/client/package.json ai-content-studio-saas-main/client/package-lock.json* ai-content-studio-saas-main/client/pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --no-frozen-lockfile
COPY ai-content-studio-saas-main/client/ ./
RUN pnpm run build

# ---- Stage 2: Production image ----
FROM node:20-alpine AS production

# Build tools for native deps (better-sqlite3, sharp) + ffmpeg
RUN apk add --no-cache ffmpeg python3 make g++

# Skip Puppeteer chromium download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Install production deps from the real nested app (rebuilds native modules for Alpine)
COPY ai-content-studio-saas-main/package.json ai-content-studio-saas-main/package-lock.json ./
RUN npm install --omit=dev --build-from-source

# Copy the real nested server source
COPY ai-content-studio-saas-main/server/ ./server/

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
