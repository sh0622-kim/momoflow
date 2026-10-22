#!/bin/sh
set -eu
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
symphony_root=${SYMPHONY_ROOT:-/opt/symphony}
test "$(git --git-dir="$symphony_root/.git" rev-parse HEAD)" = be10a1b79df723d6d7612b5651c8522704dafb2e
fixture_root=$(mktemp -d /tmp/momoflow-role-contract.XXXXXX)
trap 'rm -rf "$fixture_root"' EXIT
trap 'exit 130' INT TERM
mkdir -p "$fixture_root/elixir/lib/symphony_elixir/codex"
git --git-dir="$symphony_root/.git" show HEAD:elixir/lib/symphony_elixir/agent_runner.ex > "$fixture_root/elixir/lib/symphony_elixir/agent_runner.ex"
git --git-dir="$symphony_root/.git" show HEAD:elixir/lib/symphony_elixir/codex/app_server.ex > "$fixture_root/elixir/lib/symphony_elixir/codex/app_server.ex"
git -C "$fixture_root" apply --check "$repository_root/patches/role-flow.patch"
git -C "$fixture_root" apply "$repository_root/patches/role-flow.patch"
elixir -pa "$symphony_root/elixir/_build/prod/lib/*/ebin" -e '
  Code.compiler_options(ignore_module_conflict: true)
  Enum.each(System.argv(), &Code.require_file/1)
' "$repository_root/engine/role_runner.ex" \
  "$fixture_root/elixir/lib/symphony_elixir/codex/app_server.ex" \
  "$fixture_root/elixir/lib/symphony_elixir/agent_runner.ex" \
  "$repository_root/scripts/test-role-flow.exs"
