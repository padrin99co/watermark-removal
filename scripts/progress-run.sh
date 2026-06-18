#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <label> <command> [args...]" >&2
  exit 2
fi

label="$1"
shift

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
status_file="${STATUS_FILE:-}"
status_output="${STATUS_OUTPUT:-}"

update_status() {
  local status="$1"
  local message="$2"

  if [ -n "$status_file" ]; then
    python3 "$script_dir/status-log.py" "$status_file" "$status" "$label" "$status_output" "$message" || true
  fi
}

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

update_status "In Progress" "Codex removal started"

if [ "${PROGRESS_MODE:-}" = "batch" ]; then
  printf "[In Progress] %s\n" "$label"
  set +e
  "$@" >"$log_file" 2>&1
  status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    printf "%s[Done]%s %s\n" "$green" "$reset" "$label"
  else
    printf "%s[Failed]%s %s\n" "$red" "$reset" "$label"
    update_status "Failed" "Codex removal failed"
    cat "$log_file"
  fi

  exit "$status"
fi

"$@" >"$log_file" 2>&1 &
pid=$!

step_index=0
bar_width=24
last_log_line=""

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
  local filled empty fill remainder line max_label_width max_status_width short_label

  filled=$(( percent * bar_width / 100 ))
  empty=$(( bar_width - filled ))
  fill="$(printf '%*s' "$filled" '' | tr ' ' ' ')"
  remainder="$(printf '%*s' "$empty" '' | tr ' ' '-')"
  max_label_width=34
  short_label="$label"
  if [ "${#short_label}" -gt "$max_label_width" ]; then
    short_label="${short_label:0:$((max_label_width - 3))}..."
  fi
  max_status_width=$(( terminal_width - max_label_width - bar_width - 24 ))
  if [ "$max_status_width" -lt 16 ]; then
    max_status_width=16
  fi
  status="$(printf '%s' "$status" | tr '\n\r\t' '   ' | cut -c 1-"$max_status_width")"
  line="$(printf '%-*s [%s%s%s%s] %3d%% %s' "$max_label_width" "$short_label" "$yellow_bar" "$fill" "$reset" "$remainder" "$percent" "$status")"
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
  update_status "Failed" "Codex removal failed"
  cat "$log_file"
fi

exit "$status"
