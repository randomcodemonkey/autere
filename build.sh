#!/usr/bin/env bash
# Build (and optionally release) the autere image.
#
# Usage:
#   ./build.sh [options]
#     -i bugfix|minor|major   increment version.txt (and package.json) before
#                            building (default: build the current version.txt)
#     -r                      release: increment (bugfix unless -i given) and
#                            commit version.txt + package.json with
#                            "version: <new version>"
#     -v  <version>           override the version for this build
#     -a  <architectures>     buildx platform list (default: linux/arm64 on
#                            aarch64 machines, else linux/amd64)
#     -n  <image>             image name (default: randomcodemonkey.org/autere)
#     -t  <t1,t2,...>         tags (default: latest and the version)
#
# Legacy positional form still works (version arch image [tags...]).
#
# Examples:
#   ./build.sh
#   ./build.sh -r                 # next bugfix version, built, released
#   ./build.sh -i minor -a linux/amd64,linux/arm64 -t 0.1.0,latest
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

increment=""
release=0
version=""
arch=""
image=""
tags=""

# Legacy positional passthrough: version arch image [tags...]
if [[ $# -gt 0 && $1 != -* ]]; then
  version="$1"; shift || true
  arch="${1:-}"; shift || true
  image="${1:-}"; shift || true
  tags="$*"
else
  while getopts "i:rv:a:n:t:h" opt; do
    case "$opt" in
      i) increment="$OPTARG" ;;
      r) release=1 ;;
      v) version="$OPTARG" ;;
      a) arch="$OPTARG" ;;
      n) image="$OPTARG" ;;
      t) tags="$OPTARG" ;;
      h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) exit 2 ;;
    esac
  done
fi

bump_field() {
  local file="$1" field="$2" v a b c
  v="$(tr -d '[:space:]' < "$file")"
  [[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version.txt has no semver: '$v'" >&2; exit 1; }
  IFS=. read -r a b c <<<"$v"
  case "$field" in
    major) a=$((a + 1)); b=0; c=0 ;;
    minor) b=$((b + 1));     c=0 ;;
    *)     c=$((c + 1)) ;;
  esac
  echo "$a.$b.$c"
}

if [[ $release -eq 1 ]]; then
  increment="${increment:-bugfix}"
fi

if [[ -n $increment ]]; then
  version="$(bump_field "$here/version.txt" "$increment")"
  echo "$version" > "$here/version.txt"
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.version='$version';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');"
fi

version_file="$(cat "$here/version.txt")"
version="${version:-$version_file}"
arch="${arch:-$( case "$(uname -m)" in aarch64|arm64) echo linux/arm64 ;; *) echo linux/amd64 ;; esac )}"
image="${image:-randomcodemonkey.org/autere}"
tags="${tags:-latest,$version}"

args=()
IFS=',' read -ra tag_list <<<"$tags"
for tag in "${tag_list[@]}"; do
  args+=("-t" "$image:${tag//$ /}")
done
args+=("--platform" "$arch")
args+=("-f" "$here/docker/Dockerfile")

if [[ $release -eq 1 ]]; then
  git add "$here/version.txt" "$here/package.json"
  git commit -m "version: $version"
fi

if docker buildx version >/dev/null 2>&1; then
  docker buildx build "${args[@]}" "$here"
else
  # old docker CLI without buildx — plain build supports the same args here
  docker build "${args[@]}" "$here"
fi
