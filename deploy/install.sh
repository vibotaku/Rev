#!/usr/bin/env bash
# One-shot installer for a fresh Debian/Ubuntu VM or LXC (e.g. on Proxmox).
# Run from the repository root as root:  ./deploy/install.sh
# Optional env: PUBLIC_URL=https://rev.example.com REV_MEDIA_DIR=/mnt/media/rev
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo ./deploy/install.sh)" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker (get.docker.com)"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null

if [ ! -f .env ]; then
  echo "==> Creating .env"
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  cp .env.example .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')|" .env
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=${PUBLIC_URL:-http://${ip:-localhost}:8080}|" .env
  [ -n "${REV_MEDIA_DIR:-}" ] && sed -i "s|^REV_MEDIA_DIR=.*|REV_MEDIA_DIR=${REV_MEDIA_DIR}|" .env
  chmod 600 .env
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a
mkdir -p "${REV_DB_DIR:-./data/postgres}" "${REV_MEDIA_DIR:-./data/rev}" ./config

echo "==> Building and starting Rev"
docker compose up -d --build

echo "==> Waiting for Rev to become healthy"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${REV_PORT:-8080}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${REV_PORT:-8080}/api/health" >/dev/null

token=$(docker compose logs rev 2>/dev/null | grep -o 'setup token: [A-Za-z0-9_-]*' | tail -1 | cut -d' ' -f3 || true)
echo
echo "Rev is running at ${PUBLIC_URL}"
if [ -n "$token" ]; then
  echo "Create the first admin at ${PUBLIC_URL}/setup with setup token: $token"
fi
