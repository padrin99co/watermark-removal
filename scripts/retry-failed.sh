#!/usr/bin/env bash
set -euo pipefail

raw_dir="${RAW_DIR:-raw-images}"
status_log="${STATUS_LOG:-logs/status.tsv}"
concurrency="${CONCURRENCY:-2}"
dry_run="${DRY_RUN:-0}"

if ! [[ "$concurrency" =~ ^[0-9]+$ ]] || [ "$concurrency" -lt 1 ]; then
  echo "error: CONCURRENCY must be a positive integer" >&2
  exit 2
fi

if [ ! -f "$status_log" ]; then
  echo "No status log found: $status_log"
  exit 0
fi

mapfile -d '' images < <(
  python3 - "$status_log" "$raw_dir" <<'PY'
import csv
import sys
from pathlib import Path

status_log = Path(sys.argv[1])
raw_dir = Path(sys.argv[2])

with status_log.open(newline="") as file:
    for row in csv.DictReader(file, delimiter="\t"):
        if row.get("status") != "Failed":
            continue

        image = row.get("image", "")
        if not image:
            continue

        if (raw_dir / image).is_file():
            sys.stdout.write(image)
            sys.stdout.write("\0")
        else:
            print(f"warning: raw image missing, skipped: {raw_dir / image}", file=sys.stderr)
PY
)

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

printf '%s\0' "${images[@]}" | xargs -0 -n 1 -P "$concurrency" sh -c '
  image="$1"
  env -u OUTPUT -u MASK -u CODEX_LOG -u IMAGE_STEM -u IMAGE_DIR -u SAFE_IMAGE \
    PROGRESS_MODE=batch make --no-print-directory remove-one IMAGE="$image" FORCE=1
' _
