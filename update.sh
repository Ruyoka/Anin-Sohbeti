#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR"
LOGDIR="$REPO/.logs"
LOGFILE="$LOGDIR/update_$(date +%F).log"

mkdir -p "$LOGDIR"
exec > >(tee -a "$LOGFILE") 2>&1

echo "=== $(date -Is) update start ==="
echo "user=$(id -un) host=$(hostname)"
echo "repo=$REPO"

cd "$REPO"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: burasi bir git repo degil"
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [ -z "${BRANCH:-}" ]; then
  echo "ERROR: aktif branch bulunamadi"
  exit 1
fi

UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null || true)"
if [ -z "${UPSTREAM:-}" ]; then
  echo "ERROR: upstream tanimli degil"
  echo "git branch --set-upstream-to=origin/$BRANCH $BRANCH"
  exit 1
fi

echo
echo "=== git fetch ==="
git fetch --all --prune

echo
echo "=== git status ==="
git status -sb

CHANGED=0
if [ -n "$(git status --porcelain)" ]; then
  CHANGED=1
  echo
  echo "=== local changes detected ==="
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "update: sync local changes"
  fi
fi

AHEAD_BEHIND="$(git rev-list --left-right --count "${UPSTREAM}...HEAD" 2>/dev/null || echo "0 0")"
BEHIND="$(awk '{print $1}' <<< "$AHEAD_BEHIND")"
AHEAD="$(awk '{print $2}' <<< "$AHEAD_BEHIND")"

echo
echo "=== repo state ==="
echo "branch=$BRANCH"
echo "upstream=$UPSTREAM"
echo "ahead=$AHEAD behind=$BEHIND changed=$CHANGED"

if [ "${BEHIND:-0}" -gt 0 ]; then
  CHANGED=1
  echo
  echo "=== git pull --rebase ==="
  git pull --rebase
fi

AHEAD_BEHIND="$(git rev-list --left-right --count "${UPSTREAM}...HEAD" 2>/dev/null || echo "0 0")"
BEHIND="$(awk '{print $1}' <<< "$AHEAD_BEHIND")"
AHEAD="$(awk '{print $2}' <<< "$AHEAD_BEHIND")"

if [ "${AHEAD:-0}" -gt 0 ]; then
  CHANGED=1
  echo
  echo "=== git push ==="
  git push
fi

AHEAD_BEHIND="$(git rev-list --left-right --count "${UPSTREAM}...HEAD" 2>/dev/null || echo "0 0")"
BEHIND="$(awk '{print $1}' <<< "$AHEAD_BEHIND")"
AHEAD="$(awk '{print $2}' <<< "$AHEAD_BEHIND")"

echo
echo "=== final repo state ==="
echo "branch=$BRANCH"
echo "upstream=$UPSTREAM"
echo "ahead=$AHEAD behind=$BEHIND changed=$CHANGED"

if [ "${AHEAD:-0}" -ne 0 ] || [ "${BEHIND:-0}" -ne 0 ]; then
  echo "ERROR: repo sync tamamlanmadi"
  exit 1
fi

if [ "$CHANGED" -eq 0 ]; then
  echo
  echo "=== no git changes; docker compose skipped ==="
  echo "=== $(date -Is) update done ==="
  exit 0
fi

if [ -f docker-compose.yml ] || [ -f compose.yml ] || [ -f docker-compose.yaml ] || [ -f compose.yaml ]; then
  echo
  echo "=== docker compose up ==="
  docker compose up -d --build --force-recreate
else
  echo
  echo "=== docker compose skipped ==="
fi

echo "=== $(date -Is) update done ==="

