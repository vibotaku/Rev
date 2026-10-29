#!/usr/bin/env bash
# Restores a backup made by deploy/backup.sh:  ./deploy/restore.sh backups/20260101-031500
# This REPLACES the current database and media.
set -euo pipefail
cd "$(dirname "$0")/.."
src="${1:?usage: restore.sh backups/<timestamp>}"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

read -r -p "Replace the current Rev data with $src? [y/N] " ok
[ "$ok" = "y" ] || exit 1

docker compose stop rev
docker compose exec -T db pg_restore -U rev -d rev --clean --if-exists < "$src/rev.dump"
media="${REV_MEDIA_DIR:-./data/rev}"
rm -rf "$media/media"
tar -C "$media" -xf "$src/media.tar"
docker compose start rev
echo "Restored $src"
