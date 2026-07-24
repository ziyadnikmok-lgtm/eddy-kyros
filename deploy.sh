#!/usr/bin/env bash
# =====================================================
# AI Content Studio — VPS Deploy Script
# VPS IP: 216.246.104.87
# Domain: studio.216.246.104.87.nip.io
# =====================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN="studio.216.246.104.87.nip.io"
NGINX_CONF="/etc/nginx/sites-available/ai-content-studio"

echo ""
echo "=== AI Content Studio Deploy ==="
echo "Dir:    $REPO_DIR"
echo "Domain: $DOMAIN"
echo ""

# ---- 1. Check .env exists ----
if [ ! -f "$REPO_DIR/.env" ]; then
  echo "[WARN] .env not found — copying from .env.example"
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  echo "[ACTION REQUIRED] Edit $REPO_DIR/.env and set ENCRYPTION_SECRET, AUTH_PASSWORD_HASH etc."
  echo "  Then re-run this script."
  exit 1
fi

# ---- 2. Build & start Docker container ----
echo "[1/4] Building Docker image..."
docker compose -f "$REPO_DIR/docker-compose.yml" build --no-cache

echo "[2/4] Starting container..."
docker compose -f "$REPO_DIR/docker-compose.yml" up -d

echo "[3/4] Waiting for health check..."
for i in $(seq 1 12); do
  if curl -sf http://127.0.0.1:3001/api/health > /dev/null 2>&1; then
    echo "       App is healthy!"
    break
  fi
  echo "       Attempt $i/12 — waiting 5s..."
  sleep 5
done

# ---- 3. Install nginx config ----
echo "[4/4] Configuring nginx..."
cp "$REPO_DIR/nginx/ai-content-studio.conf" "$NGINX_CONF"
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/ai-content-studio

nginx -t && systemctl reload nginx

echo ""
echo "=== Deploy complete ==="
echo "  App:    http://$DOMAIN"
echo "  Health: http://$DOMAIN/api/health"
echo ""
