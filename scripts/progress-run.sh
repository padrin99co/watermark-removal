#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <label> <command> [args...]" >&2
  exit 2
fi

label="$1"
shift

steps=(
  "preparing image"
  "sending to Codex"
  "editing watermark"
  "reconstructing pixels"
  "saving output"
  "verifying result"
)

log_file="$(mktemp)"
trap 'rm -f "$log_file"' EXIT

"$@" >"$log_file" 2>&1 &
pid=$!

step_index=0
bar_width=24

while kill -0 "$pid" 2>/dev/null; do
  percent=$(( (step_index + 1) * 100 / ${#steps[@]} ))
  filled=$(( percent * bar_width / 100 ))
  empty=$(( bar_width - filled ))
  bar="$(printf '%*s' "$filled" '' | tr ' ' '#')$(printf '%*s' "$empty" '' | tr ' ' '-')"
  printf '\r%s -> [%s] %3d%% (%s)' "$label" "$bar" "$percent" "${steps[$step_index]}"
  sleep 2
  if [ "$step_index" -lt $((${#steps[@]} - 1)) ]; then
    step_index=$((step_index + 1))
  fi
done

set +e
wait "$pid"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  bar="$(printf '%*s' "$bar_width" '' | tr ' ' '#')"
  printf '\r%s -> [%s] 100%% (done)\n' "$label" "$bar"
else
  printf '\n%s -> failed\n' "$label"
  cat "$log_file"
fi

exit "$status"
