#!/usr/bin/env bash
# Reads existing tags on stdin, one per line. Prints "<folder> <tag>" for each tool whose version has no release yet.
# Fails if a tool's manifest.json and package.json disagree, so a bad version stops the PR before it merges.
set -euo pipefail

existing=$(cat)
for dir in extensions/* max-for-live/*; do
  [ -f "$dir/package.json" ] || continue
  version=$(node -p "require('./$dir/package.json').version")
  if [ -f "$dir/manifest.json" ]; then
    manifest=$(node -p "require('./$dir/manifest.json').version")
    if [ "$manifest" != "$version" ]; then
      echo "$dir: package.json says $version but manifest.json says $manifest" >&2
      exit 1
    fi
  fi
  name=$(basename "$dir")
  tag="$name-v$version"
  grep -qxF "$tag" <<<"$existing" && continue
  # Stem Export's releases up to 0.3.0 have plain tags like v0.3.0.
  [ "$name" = "stem-export" ] && grep -qxF "v$version" <<<"$existing" && continue
  echo "$dir $tag"
done
