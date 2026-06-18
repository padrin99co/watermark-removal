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
bar_width=40
last_log_line=""
last_wait_line=""
rendered_once=0

green=""
yellow=""
red=""
green_bar=""
yellow_bar=""
red_bar=""
reset=""
if [ -t 1 ]; then
  green="$(printf '\033[32m')"
  yellow="$(printf '\033[33m')"
  red="$(printf '\033[31m')"
  green_bar="$(printf '\033[42m')"
  yellow_bar="$(printf '\033[43m')"
  red_bar="$(printf '\033[41m')"
  reset="$(printf '\033[0m')"
fi

terminal_width="$(tput cols 2>/dev/null || echo 100)"

render_progress() {
  local percent="$1"
  local status="$2"
  local filled empty fill remainder line max_status_width

  filled=$(( percent * bar_width / 100 ))
  empty=$(( bar_width - filled ))
  fill="$(printf '%*s' "$filled" '' | tr ' ' ' ')"
  remainder="$(printf '%*s' "$empty" '' | tr ' ' '-')"
  max_status_width=$(( terminal_width - 8 ))
  if [ "$max_status_width" -lt 16 ]; then
    max_status_width=16
  fi
  status="$(printf '%s' "$status" | tr '\n\r\t' '   ' | cut -c 1-"$max_status_width")"
  if [ "$rendered_once" -eq 1 ]; then
    printf '\033[2A'
  fi
  printf '\r\033[K%s\n' "$status"
  line="$(printf 'Progress: [%s%s%s%s] %d%%' "$yellow_bar" "$fill" "$reset" "$remainder" "$percent")"
  printf '\r\033[K%s\n' "$line"
  rendered_once=1
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
  if [ "$rendered_once" -eq 1 ]; then
    printf '\033[2A'
  fi
  printf '\r\033[K%s[Done]%s %s\n' "$green" "$reset" "$label"
  printf '\r\033[KProgress: [%s%s%s] 100%%\n' "$green_bar" "$(printf '%*s' "$bar_width" '' | tr ' ' ' ')" "$reset"
else
  if [ "$rendered_once" -eq 1 ]; then
    printf '\033[2A'
  fi
  printf '\r\033[K%s[Failed]%s %s\n' "$red" "$reset" "$label"
  printf '\r\033[KProgress: [%s%s%s] failed\n' "$red_bar" "$(printf '%*s' "$bar_width" '' | tr ' ' ' ')" "$reset"
  cat "$log_file"
fi

exit "$status"
