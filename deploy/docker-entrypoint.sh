#!/bin/sh
# Bind-mounted data directories are often created root-owned by Docker. Fix the
# top level, then drop to the unprivileged `node` user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/media /data/tmp
  find /data -maxdepth 1 ! -user node -exec chown node:node {} +
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
