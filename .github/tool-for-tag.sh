#!/usr/bin/env bash
# Prints the folder of the tool a tag like set-leveler-v0.1.0 releases. Fails if there's no such tool,
# or if the version in the tag isn't the tool's version.
set -euo pipefail

tag="$1"
name="${tag%-v*}"
version="${tag##*-v}"
if [ "$name" = "$tag" ]; then
  echo "tag $tag isn't <tool>-v<version>" >&2
  exit 1
fi

for parent in extensions max-for-live; do
  dir="$parent/$name"
  [ -f "$dir/package.json" ] || continue
  for file in package.json manifest.json; do
    [ -f "$dir/$file" ] || continue
    actual=$(node -p "require('./$dir/$file').version")
    if [ "$actual" != "$version" ]; then
      echo "tag $tag but $dir/$file says $actual" >&2
      exit 1
    fi
  done
  echo "$dir"
  exit 0
done

echo "tag $tag: no tool called $name under extensions/ or max-for-live/" >&2
exit 1
