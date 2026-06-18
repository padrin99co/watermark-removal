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
percents=(10 25 45 65 80 95)

log_file="$(mktemp)"
trap 'rm -f "$log_file"' EXIT

"$@" >"$log_file" 2>&1 &
pid=$!

step_index=0
bar_width=24
last_log_line=""
last_wait_line=""

green=""
yellow=""
red=""
reset=""
if [ -t 1 ]; then
  green="$(printf '\033[32m')"
  yellow="$(printf '\033[33m')"
  red="$(printf '\033[31m')"
  reset="$(printf '\033[0m')"
fi

terminal_width="$(tput cols 2>/dev/null || echo 100)"
label_width=34
short_label="$label"
if [ "${#short_label}" -gt "$label_width" ]; then
  short_label="${short_label:0:$((label_width - 3))}..."
fi

render_progress() {
  local percent="$1"
  local status="$2"
  local filled empty bar line max_status_width

  filled=$(( percent * bar_width / 100 ))
  empty=$(( bar_width - filled ))
  bar="$(printf '%*s' "$filled" '' | tr ' ' '#')$(printf '%*s' "$empty" '' | tr ' ' '-')"
  max_status_width=$(( terminal_width - label_width - bar_width - 16 ))
  if [ "$max_status_width" -lt 16 ]; then
    max_status_width=16
  fi
  status="$(printf '%s' "$status" | tr '\n\r\t' '   ' | cut -c 1-"$max_status_width")"
  line="$(printf '%-*s -> %s[%s]%s %3d%% %s' "$label_width" "$short_label" "$yellow" "$bar" "$reset" "$percent" "$status")"
  printf '\r\033[K%s' "$line"
}

while kill -0 "$pid" 2>/dev/null && [ "$step_index" -lt "${#steps[@]}" ]; do
  percent="${percents[$step_index]}"
  render_progress "$percent" "${steps[$step_index]}"
  step_index=$((step_index + 1))
  sleep 5
done

while kill -0 "$pid" 2>/dev/null; do
  percent=95
  current_log_line="$(grep -E '^(codex|exec|imagegen|Done\\.|Saved|Wrote|Verified|The |I |Using |Generated)' "$log_file" | tail -n 1 || true)"
  if [ -n "$current_log_line" ]; then
    last_log_line="$(printf '%s' "$current_log_line" | tr '\n\r\t' '   ' | cut -c 1-90)"
  fi
  if [ -n "$last_log_line" ]; then
    wait_line="waiting for Codex result | ${last_log_line}"
  else
    wait_line="waiting for Codex result"
  fi
  render_progress "$percent" "$wait_line"
  sleep 5
done

set +e
wait "$pid"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  printf '\r\033[K%s[Done]%s %s\n' "$green" "$reset" "$label"
else
  printf '\r\033[K%s[Failed]%s %s\n' "$red" "$reset" "$label"
  cat "$log_file"
fi

exit "$status"
