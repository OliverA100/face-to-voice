#!/bin/bash
# Re-records a set of replay runs on another deployment, same clips, browsers and paces, then analyses them, so
# `summary.py --compare` can put them side by side (Step 5: the production baseline "rp" against the new deploy).
#   ./rerun.sh <url> <new tag> [baseline tag, default rp] [browser …]
#   ./rerun.sh "https://facetovoice.com/?debug=1" after
# Free: replays use the saved clips (no TTS, no voice design). Safari needs Develop › Allow Remote Automation.
set -e
cd "$(dirname "$0")"
url=$1; tag=$2; base=${3:-rp}; shift 3 2>/dev/null || shift $#
only="$*"
[ -z "$url" ] || [ -z "$tag" ] && { echo "usage: ./rerun.sh <url> <new tag> [baseline] [browser …]"; exit 1; }
list=$(for d in out/runs/"$base"-*/; do
  n=$(basename "$d"); rest=${n#"$base"-}
  pace=${rest##*-}; r2=${rest%-*}; browser=${r2##*-}; clip=${r2%-*}
  [ -n "$only" ] && [[ " $only " != *" $browser "* ]] && continue
  [ -f "out/clips/$clip.ndjson" ] || { echo "skip $n: no out/clips/$clip.ndjson" >&2; continue; }
  echo "$browser $pace out/clips/$clip.ndjson"
done | sort)
for g in $(echo "$list" | cut -d' ' -f1,2 | uniq | tr ' ' :); do
  browser=${g%:*}; pace=${g#*:}
  clips=$(echo "$list" | awk -v b="$browser" -v p="$pace" '$1==b && $2==p {print $3}')
  echo "== $browser, $pace:" $clips
  node replay.mjs --browser "$browser" --pace "$pace" --url "$url" --tag "$tag" $clips
done
./analyse.sh "$tag-*"
echo "uv run summary.py --md --compare $base $tag"
