#!/usr/bin/env bash
set -euo pipefail

raw_dir="${RAW_DIR:-raw-images}"
clean_dir="${CLEAN_DIR:-clean-images}"
status_log="${STATUS_LOG:-logs/status.tsv}"
code_command="${CODEX:-codex}"
concurrency="${CONCURRENCY:-2}"
dry_run="${DRY_RUN:-0}"
exclude_filenames="${EXCLUDE_FILENAMES:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
status_writer="$script_dir/status-log.py"
skipped_file="$(mktemp)"
trap 'rm -f "$skipped_file"' EXIT

if ! [[ "$concurrency" =~ ^[0-9]+$ ]] || [ "$concurrency" -lt 1 ]; then
  echo "error: CONCURRENCY must be a positive integer" >&2
  exit 2
fi

if [ ! -f "$status_log" ]; then
  echo "No status log found: $status_log"
  exit 0
fi

mapfile -d '' images < <(
  python3 - "$status_log" "$raw_dir" "$exclude_filenames" "$skipped_file" <<'PY'
import csv
import sys
from pathlib import Path

status_log = Path(sys.argv[1])
raw_dir = Path(sys.argv[2])
exclude_file = Path(sys.argv[3]) if sys.argv[3] else None
skipped_file = Path(sys.argv[4])
excluded_names = set()
excluded_stems = set()

if exclude_file and exclude_file.is_file():
    for line in exclude_file.read_text().splitlines():
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        path = Path(value)
        excluded_names.add(path.name)
        excluded_stems.add(path.stem)

with status_log.open(newline="") as file:
    for row in csv.DictReader(file, delimiter="\t"):
        if row.get("status") != "Failed":
            continue

        image = row.get("image", "")
        if not image:
            continue

        path = Path(image)
        if path.name in excluded_names or path.stem in excluded_stems:
            print(f"warning: excluded by rules, skipped failed image: {image}", file=sys.stderr)
            output = row.get("output", "")
            with skipped_file.open("a") as skipped:
                skipped.write(f"{image}\t{output}\n")
            continue

        if (raw_dir / image).is_file():
            sys.stdout.write(image)
            sys.stdout.write("\0")
        else:
            print(f"warning: raw image missing, skipped: {raw_dir / image}", file=sys.stderr)
PY
)

update_skipped_statuses() {
  local image output
  while IFS=$'\t' read -r image output; do
    [ -n "$image" ] || continue
    python3 "$status_writer" "$status_log" "Skipped" "$image" "$output" "Excluded by rules" || true
  done <"$skipped_file"
}

if [ "$dry_run" != "1" ]; then
  update_skipped_statuses
fi

total="${#images[@]}"
if [ "$total" -eq 0 ]; then
  echo "No failed images to retry"
  exit 0
fi

echo "Retry failed watermark removal"
echo "Images: $total"
echo "Concurrency: $concurrency"

if [ "$dry_run" = "1" ]; then
  printf '%s\n' "${images[@]}"
  exit 0
fi

export raw_dir clean_dir status_log code_command
printf '%s\0' "${images[@]}" | xargs -0 -n 1 -P "$concurrency" sh -c '
  image="$1"
  env -u OUTPUT -u MASK -u CODEX_LOG -u IMAGE_STEM -u IMAGE_DIR -u SAFE_IMAGE \
    PROGRESS_MODE=batch make --no-print-directory remove-one RAW_DIR="$raw_dir" CLEAN_DIR="$clean_dir" STATUS_LOG="$status_log" CODEX="$code_command" IMAGE="$image" FORCE=1
' _
