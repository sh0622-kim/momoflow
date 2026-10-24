#!/bin/sh
set -eu
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
symphony_root=${SYMPHONY_ROOT:-/opt/symphony}
test "$(git --git-dir="$symphony_root/.git" rev-parse HEAD)" = be10a1b79df723d6d7612b5651c8522704dafb2e
fixture_root=$(mktemp -d /tmp/momoflow-role-contract.XXXXXX)
trap 'rm -rf "$fixture_root"' EXIT
trap 'exit 130' INT TERM
mkdir -p "$fixture_root/elixir/lib/symphony_elixir_web/live" "$fixture_root/elixir/lib/symphony_elixir_web/controllers" "$fixture_root/elixir/lib/symphony_elixir/codex" "$fixture_root/elixir/lib/symphony_elixir/github"
git --git-dir="$symphony_root/.git" show HEAD:elixir/lib/symphony_elixir/github/client.ex > "$fixture_root/elixir/lib/symphony_elixir/github/client.ex"
git -C "$fixture_root" apply "$repository_root/patches/github-token-file.patch"
git --git-dir="$symphony_root/.git" show HEAD:elixir/lib/symphony_elixir/agent_runner.ex > "$fixture_root/elixir/lib/symphony_elixir/agent_runner.ex"
git --git-dir="$symphony_root/.git" show HEAD:elixir/lib/symphony_elixir/codex/app_server.ex > "$fixture_root/elixir/lib/symphony_elixir/codex/app_server.ex"
git --git-dir="$symphony_root/.git" show HEAD:elixir/lib/symphony_elixir/orchestrator.ex > "$fixture_root/elixir/lib/symphony_elixir/orchestrator.ex"
git --git-dir="$symphony_root/.git" show HEAD:elixir/lib/symphony_elixir_web/controllers/observability_api_controller.ex > "$fixture_root/elixir/lib/symphony_elixir_web/controllers/observability_api_controller.ex"
git --git-dir="$symphony_root/.git" show HEAD:elixir/lib/symphony_elixir_web/presenter.ex > "$fixture_root/elixir/lib/symphony_elixir_web/presenter.ex"
git -C "$fixture_root" apply --check "$repository_root/patches/role-flow.patch"
git -C "$fixture_root" apply "$repository_root/patches/role-flow.patch"
git -C "$fixture_root" apply --check "$repository_root/patches/admission.patch"
git -C "$fixture_root" apply "$repository_root/patches/admission.patch"
git --git-dir="$symphony_root/.git" show HEAD:elixir/lib/symphony_elixir_web/live/dashboard_live.ex > "$fixture_root/elixir/lib/symphony_elixir_web/live/dashboard_live.ex"
git -C "$fixture_root" apply --check "$repository_root/patches/work-status.patch"
git -C "$fixture_root" apply "$repository_root/patches/work-status.patch"
# Isolate mock contracts from deployment-only opt-in mounts; no running settings change.
unset MOMOFLOW_POST_PR_INBOX MOMOFLOW_LAUNCH_ROOT MOMOFLOW_ADMISSION_ROOT
elixir -pa "$symphony_root/elixir/_build/prod/lib/*/ebin" -e '
  Code.compiler_options(ignore_module_conflict: true)
  [beam_root | files] = System.argv()
  File.mkdir_p!(beam_root)
  Code.prepend_path(beam_root)
  # Persist candidate exports in the isolated path so the checker never reads stale installed beams.
  Enum.each(files, fn file ->
    Enum.each(Code.require_file(file) || [], fn {module, bytes} ->
      File.write!(Path.join(beam_root, Atom.to_string(module) <> ".beam"), bytes)
    end)
  end)
' "$fixture_root/beams" "$fixture_root/elixir/lib/symphony_elixir/github/client.ex" \
  "$repository_root/engine/role_runner.ex" \
  "$repository_root/engine/admission.ex" \
  "$repository_root/engine/work_status.ex" \
  "$fixture_root/elixir/lib/symphony_elixir/codex/app_server.ex" \
  "$fixture_root/elixir/lib/symphony_elixir/agent_runner.ex" \
  "$fixture_root/elixir/lib/symphony_elixir/orchestrator.ex" \
  "$fixture_root/elixir/lib/symphony_elixir_web/presenter.ex" \
  "$fixture_root/elixir/lib/symphony_elixir_web/controllers/observability_api_controller.ex" \
  "$fixture_root/elixir/lib/symphony_elixir_web/live/dashboard_live.ex" \
  "$repository_root/scripts/test-role-flow.exs" \
  "$repository_root/scripts/test-work-status.exs"
