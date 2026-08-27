#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
asset_directory="$repository_root/docs/assets"
cast_path="$asset_directory/localhost2137-slack-demo.cast"
gif_path="$asset_directory/localhost2137-slack-demo.gif"
session_root="/tmp/localhost2137-readme-demo"
owner_marker="$session_root/.localhost2137-readme-demo-owner"
session_created=false

for command_name in agg asciinema node pnpm; do
	if ! command -v "$command_name" >/dev/null; then
		printf 'Missing required command: %s\n' "$command_name" >&2
		exit 1
	fi
done

assert_port_available() {
	local port="$1"
	node --input-type=module -e '
		import { createServer } from "node:net";
		const port = Number(process.argv[1]);
		const server = createServer();
		server.unref();
		server.once("error", () => process.exit(1));
		server.listen({ host: "127.0.0.1", port }, () => server.close());
	' "$port" || {
		printf 'Port %s is unavailable. Stop its listener before recording.\n' "$port" >&2
		exit 1
	}
}

cleanup() {
	if [[ "$session_created" == true && -f "$owner_marker" ]]; then
		rm -rf -- "$session_root"
	fi
}
trap cleanup EXIT HUP INT TERM

assert_port_available 2137
assert_port_available 3000

if [[ -e "$session_root" ]]; then
	printf 'Refusing to replace existing recording directory: %s\n' "$session_root" >&2
	exit 1
fi

mkdir -p "$asset_directory" "$session_root"
printf 'owned by scripts/record-readme-demo.sh\n' >"$owner_marker"
session_created=true

cat <<'INSTRUCTIONS'
Record these commands in order. Wait for `localhost2137 ready` and the `bot:` line
before continuing; do not use sleeps. After the final JSON result, press Ctrl+\ to
pause capture, terminate both recorded background jobs, wait for them, and exit.

  pnpm dlx localhost2137 demo clone slack-ping-bot
  cd slack-ping-bot
  sed -n '1,19p' localhost.config.ts
  sed -n '15,26p' src/bot.ts
  pnpm exec localhost dev &
  runtime_pid=$!
  pnpm exec localhost seed
  pnpm exec localhost run -- pnpm start &
  bot_pid=$!
  pnpm exec localhost exec slack send-message \
    --channel general --from Ada --text ping --json
  pnpm exec localhost exec slack list-messages --channel general

Paused cleanup:

  kill -TERM "$bot_pid" "$runtime_pid"
  wait "$bot_pid" "$runtime_pid" || true
  exit
INSTRUCTIONS

cd "$session_root"
asciinema record \
	--command "env -u INIT_CWD -u PNPM_PACKAGE_NAME -u PNPM_SCRIPT_SRC_DIR BASH_SILENCE_DEPRECATION_WARNING=1 NO_COLOR=1 PS1='$ ' PROMPT_COMMAND= pnpm_config_minimum_release_age=0 pnpm_config_store_dir='$session_root/.pnpm-store' bash --noprofile --norc -i" \
	--idle-time-limit 2 \
	--overwrite \
	--quiet \
	--return \
	--title "localhost2137: local Slack ping-pong" \
	--window-size 92x28 \
	"$cast_path"

if LC_ALL=C grep -aEq '/Users/|/home/|sk_live_|ghp_' "$cast_path"; then
	printf 'Recording contains a machine path or credential-shaped value; refusing to render.\n' >&2
	exit 1
fi

agg \
	--fps-cap 20 \
	--font-size 14 \
	--idle-time-limit 5 \
	--last-frame-duration 3 \
	--line-height 1.25 \
	--no-loop \
	--quiet \
	--speed 1.25 \
	--theme github-dark \
	"$cast_path" \
	"$gif_path"

gif_bytes="$(wc -c <"$gif_path" | tr -d '[:space:]')"
if ((gif_bytes > 4 * 1024 * 1024)); then
	printf 'Rendered GIF exceeds the 4 MiB limit: %s bytes\n' "$gif_bytes" >&2
	exit 1
fi
if ((gif_bytes > 2 * 1024 * 1024)); then
	printf 'Rendered GIF exceeds the 2 MiB target: %s bytes\n' "$gif_bytes" >&2
	exit 1
fi

printf 'Recorded %s\nRendered %s (%s bytes)\n' "$cast_path" "$gif_path" "$gif_bytes"
