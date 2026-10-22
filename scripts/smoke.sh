#!/bin/sh
set -eu
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
container_name="momoflow-smoke-$$"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
docker run --detach --name "$container_name" --network none \
  --cap-drop ALL --security-opt no-new-privileges \
  --security-opt "seccomp=$repository_root/security/codex-seccomp.json" \
  --mount "type=bind,src=$repository_root/scripts/smoke-sandbox.mjs,dst=/checks/smoke-sandbox.mjs,readonly" \
  --mount "type=bind,src=$repository_root/scripts,dst=/checks/scripts,readonly" \
  --mount "type=bind,src=$repository_root/engine,dst=/checks/engine,readonly" \
  --mount "type=bind,src=$repository_root/patches,dst=/checks/patches,readonly" \
  --mount "type=bind,src=$repository_root/WORKFLOW.md,dst=/config/WORKFLOW.md,readonly" \
  --env GITHUB_REPO=smoke/fixture --env GITHUB_TOKEN=smoke-not-a-credential \
  "${MOMOFLOW_IMAGE:-momoflow-symphony}" >/dev/null
docker exec "$container_name" node --input-type=module -e '
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:4000/api/v1/state", { signal: AbortSignal.timeout(2000) });
      const state = await response.json();
      if (!response.ok || state.error || !Array.isArray(state.running) || !Array.isArray(state.retrying)) throw new Error("Invalid state");
      if (state.running.length || state.retrying.length) throw new Error("Unexpected work");
      const page = await fetch("http://127.0.0.1:4000/", { signal: AbortSignal.timeout(2000) });
      if (!page.ok || !(await page.text()).includes("Symphony")) throw new Error("Dashboard unavailable");
      ready = true;
      console.log("PASS: Symphony state API and dashboard; no running tasks; network disabled.");
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!ready) process.exit(1);
' || { docker logs --tail 60 "$container_name"; exit 1; }
docker exec "$container_name" codex --version
docker exec "$container_name" node /checks/smoke-sandbox.mjs

docker exec "$container_name" sh /checks/scripts/test-role-flow.sh
