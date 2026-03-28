# ---- Stage 1: Build client ----
FROM node:20-alpine AS client-builder

WORKDIR /app/client
COPY client/package.json client/pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY client/ ./
RUN pnpm run build

# ---- Stage 2: Production image ----
FROM node:20-alpine AS production

# ffmpeg + native build deps + chromium for Puppeteer
RUN apk add --no-cache ffmpeg python3 make g++ chromium

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Install production deps only
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod

# Copy server source + build assets
COPY server/ ./server/
COPY build/  ./build/

# Copy built client from stage 1
COPY --from=client-builder /app/client/dist ./client/dist

# Create persistent data directories and seed with empty JSON
RUN mkdir -p /data/data /data/uploads/generated /data/characters /data/temp \
 && cp /app/build/seed-data/*.json /data/data/ 2>/dev/null || true

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV DOTENV_CONFIG_PATH=/data/.env

CMD ["node", "server/index.js"]
