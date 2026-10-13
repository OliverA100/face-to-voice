#!/bin/bash
# Analyses recorded runs: audio truth (aligner + landmarks), mouth from pixels, event offsets.
#   ./analyse.sh <run> [...]        (run names under out/runs, or shell globs like 'base-*')
# Steps whose output exists are skipped; FORCE=1 redoes them.
set -e
cd "$(dirname "$0")"
runs=()
for a in "$@"; do for d in out/runs/$a; do [ -f "$d/meta.json" ] && runs+=("$(basename "$d")"); done; done
need() { local f=$1; shift; local out=(); for r in "${runs[@]}"; do { [ "$FORCE" = 1 ] || [ ! -f "out/runs/$r/$f" ]; } && out+=("$r"); done; echo "${out[@]}"; }
t=$(need truth.json); [ -n "$t" ] && uv run -q truth.py $t 2>&1 | grep -v -E "UserWarning|forced_align\("
m=$(need mouth.json); [ -n "$m" ] && uv run -q mouth.py $m
uv run -q events.py "${runs[@]}"
