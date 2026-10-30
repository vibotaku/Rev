#!/usr/bin/env bash
# Backs up the Rev database (pg_dump) and media files into ./backups/<timestamp>/.
# Schedule with cron, e.g.:  15 3 * * * cd /opt/rev && ./deploy/backup.sh >> backups/backup.log 2>&1
# Set KEEP_DAYS to prune older backups (default 14).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./.env
set +a

stamp=$(date +%Y%m%d-%H%M%S)
dest="backups/$stamp"
mkdir -p "$dest"

echo "==> Dumping database"
docker compose exec -T db pg_dump -U rev -d rev --format=custom > "$dest/rev.dump"

echo "==> Copying media"
media="${REV_MEDIA_DIR:-./data/rev}"
# secret.key decrypts secrets stored in the database (e.g. the AD bind password).
tar -C "$media" -cf "$dest/media.tar" media $( [ -f "$media/secret.key" ] && echo secret.key )

find backups -mindepth 1 -maxdepth 1 -type d -mtime "+${KEEP_DAYS:-14}" -exec rm -rf {} +
# --apparent-size: on ZFS and other compressing filesystems plain du lags right after a write.
echo "Backup written to $dest ($(du -sh --apparent-size "$dest" | cut -f1))"
