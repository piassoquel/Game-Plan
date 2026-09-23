#!/usr/bin/env bash
# Usage: scripts/bump-build.sh fb21
# Renames the build everywhere it must match (?v= URLs, service-worker cache,
# version.json) so phones detect the new release and refetch everything.
set -euo pipefail
new="${1:?usage: bump-build.sh <new-build-name>}"
cd "$(dirname "$0")/../web"
old=$(grep -o 'v=fb[0-9]*' index.html | head -1 | cut -d= -f2)
sed -i.bak "s/v=$old/v=$new/g" index.html js/app.js js/gameplan-api.js && rm -f index.html.bak js/*.bak
sed -i.bak -E "s/^const CACHE_NAME = .*/const CACHE_NAME = \"gameplan-$new\";/" service-worker.js && rm -f service-worker.js.bak
printf '{ "build": "%s", "released": "%s" }\n' "$new" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > version.json
echo "build $old -> $new"
