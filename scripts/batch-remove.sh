#!/usr/bin/env bash
set -euo pipefail

raw_dir="${RAW_DIR:-raw-images}"
concurrency="${CONCURRENCY:-2}"
dry_run="${DRY_RUN:-0}"

if ! [[ "$concurrency" =~ ^[0-9]+$ ]] || [ "$concurrency" -lt 1 ]; then
  echo "error: CONCURRENCY must be a positive integer" >&2
  exit 2
fi

if [ ! -d "$raw_dir" ]; then
  echo "error: raw image directory not found: $raw_dir" >&2
  exit 2
fi

mapfile -d '' images < <(
  find "$raw_dir" -maxdepth 1 -type f \
    \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) \
    -printf '%f\0' | sort -z
)

total="${#images[@]}"
if [ "$total" -eq 0 ]; then
  echo "No images found in $raw_dir"
  exit 0
fi

echo "Batch watermark removal"
echo "Images: $total"
echo "Concurrency: $concurrency"

if [ "$dry_run" = "1" ]; then
  printf '%s\n' "${images[@]}"
  exit 0
fi

printf '%s\0' "${images[@]}" | xargs -0 -n 1 -P "$concurrency" sh -c '
  image="$1"
  PROGRESS_MODE=batch make --no-print-directory remove IMAGE="$image"
' _
