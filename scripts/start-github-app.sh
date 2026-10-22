#!/bin/sh
set +x
set -eu
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"
export COMPOSE_FILE=compose.yaml:compose.github-app.yaml
unset GITHUB_TOKEN GH_TOKEN
docker compose config --quiet
sh scripts/init-codex.sh
docker compose up -d --wait --wait-timeout 120
printf '%s\n' 'momoflow is running with GitHub App authentication.'
