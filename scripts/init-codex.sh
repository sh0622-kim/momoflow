#!/bin/sh
set +x
set -eu
codex_auth_file="${CODEX_HOME:-$HOME/.codex}/auth.json"
if [ ! -r "$codex_auth_file" ]; then
  printf '%s\n' 'Codex auth.json is unavailable. Run codex login on this machine first.' >&2
  exit 1
fi
docker compose run --rm --no-deps -T symphony node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const content = fs.readFileSync(0);
  const auth = JSON.parse(content);
  if (!auth.tokens && !auth.OPENAI_API_KEY) throw new Error("Unsupported authentication cache");
  const directory = process.env.CODEX_HOME;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  try {
    fs.writeFileSync(path.join(directory, "auth.json"), content, { mode: 0o600, flag: "wx" });
    console.log("Codex authentication initialized in the Docker volume.");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log("Existing container authentication preserved.");
  }
' < "$codex_auth_file"
docker compose run --rm --no-deps -T symphony codex login status
