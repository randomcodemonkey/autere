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
# vite already writes the frontend to ~/dist (outDir ../../dist); backend
# needs an explicit copy (tsc outDir is the repo's dist-backend).
rsync -a --delete dist-backend/ ~/dist-backend/

echo "build-dev done: dist, dist-backend, pi-ext-extra updated"
