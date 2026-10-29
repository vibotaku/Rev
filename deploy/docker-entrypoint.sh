#!/bin/sh
# Bind-mounted data directories are often created root-owned by Docker. Fix the
# directories Rev writes to (only those: a mounted volume may also contain
# entries like lost+found that we must leave alone), then drop to `node`.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/media /data/tmp
  for dir in /data /data/media /data/tmp /data/pglite; do
    if [ -e "$dir" ] && [ "$(stat -c %u "$dir")" != "$(id -u node)" ]; then
      chown node:node "$dir"
    fi
  done
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
