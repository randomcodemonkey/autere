#!/usr/bin/env bash
# Dev build: compile frontend + backend in the repo, then copy the built
# resources into the running install's home tree:
#   ~/dist          frontend build (vite outDir is already ../../dist)
#   ~/dist-backend  compiled backend (tsc)
#   ~/pi-ext-extra  bundled custom pi extensions (repo extras/)
#
# Usage: ./build-dev.sh [--no-ext]   (skip the extensions copy)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

npm run build

# extras/ → ~/pi-ext-extra (mirrored copy: remove then copy so deletions in
# the repo propagate; rsync','=',$ semantics are the same thing).
if [[ "${1:-}" != "--no-ext" ]]; then
  rsync -a --delete extras/ ~/pi-ext-extra/
fi
# vite writes frontend to the repo's dist/ (outDir ../../dist) — copy it
# to the running install's ~/dist (tsc outDir dist-backend needs the same
# treatment). node_modules is image-baked and root-owned (rsync --delete
# cannot remove it, and must not): keep it out of the sync.
rsync -a --delete --exclude node_modules dist/ ~/dist/
rsync -a --delete dist-backend/ ~/dist-backend/

# The compiled backend resolves bare imports starting at /home/autere/dist-backend
# (chain: dist-backend/node_modules → ~/node_modules → …). The image's deps live
# in ~/dist/node_modules — NOT in that chain — so put a node_modules where the
# backend actually looks: the repo install (matches what was just built), falling
# back to the image's prod install. It sits in $HOME on purpose: rsync --delete
# on dist-backend/ would fight a link inside that tree.
if [[ -d node_modules ]]; then
  ln -sfn "$here/node_modules" "$HOME/node_modules"
elif [[ -d "$HOME/dist/node_modules" ]]; then
  ln -sfn "$HOME/dist/node_modules" "$HOME/node_modules"
fi

echo "build-dev done: dist, dist-backend, pi-ext-extra updated"
