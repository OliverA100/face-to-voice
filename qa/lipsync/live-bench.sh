#!/bin/bash
# Runs live-bench.ts with the web app's own modules (jiti resolves "@/" to web/src). Arguments as bench.ts.
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$HERE/../../web"
export INIT_CWD="$PWD"; cd "$WEB" && JITI_FS_CACHE=false JITI_ALIAS="{\"@/\":\"$WEB/src/\"}" exec ./node_modules/.bin/jiti "$HERE/live-bench.ts" "$@"
