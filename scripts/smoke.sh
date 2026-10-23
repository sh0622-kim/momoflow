#!/bin/sh
set -eu
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
container_name="momoflow-smoke-$$"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
fail() {
  echo "FAIL: $1" >&2
  docker logs --tail 60 "$container_name" || echo 'FAIL: container logs unavailable' >&2
  exit 1
}
docker run --detach --name "$container_name" --network none \
  --cap-drop ALL --security-opt no-new-privileges \
  --security-opt "seccomp=$repository_root/security/codex-seccomp.json" \
  --mount "type=bind,src=$repository_root/scripts/smoke-sandbox.mjs,dst=/checks/smoke-sandbox.mjs,readonly" \
  --mount "type=bind,src=$repository_root/scripts,dst=/checks/scripts,readonly" \
  --mount "type=bind,src=$repository_root/engine,dst=/checks/engine,readonly" \
  --mount "type=bind,src=$repository_root/patches,dst=/checks/patches,readonly" \
  --mount "type=bind,src=$repository_root/WORKFLOW.md,dst=/config/WORKFLOW.md,readonly" \
  --env GITHUB_REPO=smoke/fixture --env GITHUB_TOKEN=smoke-not-a-credential \
  "${MOMOFLOW_IMAGE:-momoflow-symphony}" >/dev/null || fail "startup: docker run exited $? (see command error above)"
docker exec "$container_name" node /checks/scripts/smoke-readiness.mjs \
  || fail "readiness command: docker exec/node exited $? (see probe diagnostic or launch error above)"
docker exec "$container_name" codex --version
docker exec "$container_name" node /checks/smoke-sandbox.mjs

docker exec "$container_name" sh /checks/scripts/test-role-flow.sh
