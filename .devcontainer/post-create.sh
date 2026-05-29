#!/bin/sh
set -eu

# Docker named volumes are created as root-owned mountpoints. Fix ownership
# before the first install so pnpm and node_modules caches are writable.
for path in \
  /home/node/.local/share/pnpm \
  /workspaces/readest/node_modules \
  /workspaces/readest/apps/readest-app/node_modules
do
  sudo mkdir -p "$path"
  sudo chown -R node:node "$path"
done

cd /workspaces/readest
pnpm install
