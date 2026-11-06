#!/usr/bin/env bash
# Reads existing tags on stdin, one per line. Prints "<folder> <tag>" for each tool whose version has no release yet.
set -euo pipefail

existing=$(cat)
for dir in extensions/* max-for-live/*; do
  [ -f "$dir/package.json" ] || continue
  version=$(node -p "require('./$dir/package.json').version")
  name=$(basename "$dir")
  tag="$name-v$version"
  grep -qxF "$tag" <<<"$existing" && continue
  # Stem Export's releases up to 0.3.0 have plain tags like v0.3.0.
  [ "$name" = "stem-export" ] && grep -qxF "v$version" <<<"$existing" && continue
  echo "$dir $tag"
done
