#!/bin/sh
set +x
set -eu
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"
export COMPOSE_FILE=compose.yaml
GITHUB_TOKEN=${GITHUB_TOKEN:-${GH_TOKEN:-$(gh auth token --hostname github.com)}}
GITHUB_REPO=${GITHUB_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
export GITHUB_TOKEN GITHUB_REPO
gh api "repos/$GITHUB_REPO" --silent
docker compose config --quiet
sh scripts/init-codex.sh
docker compose up -d --wait --wait-timeout 90
printf '%s\n' 'momoflow is running. Use docker compose ps to see the local port.'
