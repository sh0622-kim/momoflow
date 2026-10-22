#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*)
    if [ -n "${GITHUB_TOKEN_FILE:-}" ]; then
      exec node /opt/momoflow/github-app-auth.mjs --print-token
    fi
    printf '%s\n' "$GITHUB_TOKEN"
    ;;
  *) exit 1 ;;
esac
