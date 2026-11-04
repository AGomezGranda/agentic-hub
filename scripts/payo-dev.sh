#!/usr/bin/env bash
# Start the Payo server and web UI, then print the token to paste into the UI.
# Runs the real server by default; PAYO_DEV_FAKES=1 uses offline fakes (no logins needed).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/payo"

log="$(mktemp -t payo-server.XXXXXX)"
server_pid=""

cleanup() {
	if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
		kill "$server_pid" 2>/dev/null || true
		wait "$server_pid" 2>/dev/null || true
	fi
}
trap cleanup EXIT INT TERM

if [[ "${PAYO_DEV_FAKES:-0}" == "1" ]]; then
	node apps/server/src/main.ts --dev-fakes >"$log" 2>&1 &
else
	node apps/server/src/main.ts >"$log" 2>&1 &
fi
server_pid=$!

# Wait for "payo server ready"; fail fast if the server exits first.
for _ in $(seq 1 60); do
	grep -q "payo server ready" "$log" && break
	if ! kill -0 "$server_pid" 2>/dev/null; then
		cat "$log" >&2
		echo "payo: server exited during startup (log: $log)" >&2
		exit 1
	fi
	sleep 0.5
done
if ! grep -q "payo server ready" "$log"; then
	cat "$log" >&2
	echo "payo: server not ready after 30s (log: $log)" >&2
	exit 1
fi

token="$(node apps/cli/src/index.ts token)"
echo "Payo server log: $log"
echo "Web UI:          http://127.0.0.1:5173/"
echo "Token:           $token"

pnpm web:dev
