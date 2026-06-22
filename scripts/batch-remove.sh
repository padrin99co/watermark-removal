#!/usr/bin/env bash
set -euo pipefail

raw_dir="${RAW_DIR:-raw-images}"
clean_dir="${CLEAN_DIR:-clean-images}"
status_log="${STATUS_LOG:-logs/status.tsv}"
code_command="${CODEX:-codex}"
image_scope="${IMAGE_SCOPE:-}"
concurrency="${CONCURRENCY:-2}"
dry_run="${DRY_RUN:-0}"
exclude_filenames="${EXCLUDE_FILENAMES:-}"

if ! [[ "$concurrency" =~ ^[0-9]+$ ]] || [ "$concurrency" -lt 1 ]; then
  echo "error: CONCURRENCY must be a positive integer" >&2
  exit 2
fi

if [ ! -d "$raw_dir" ]; then
  echo "error: raw image directory not found: $raw_dir" >&2
  exit 2
fi

search_path="$raw_dir"
if [ -n "$image_scope" ]; then
  search_path="$raw_dir/$image_scope"
fi

if [ ! -e "$search_path" ]; then
  echo "error: image or folder not found: $search_path" >&2
  exit 2
fi

if [ -f "$search_path" ]; then
  images=("${search_path#"$raw_dir"/}")
else
  mapfile -d '' images < <(
    find "$search_path" -type f \
      \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) \
      -print0 |
      sort -z |
      while IFS= read -r -d '' image_path; do
        printf '%s\0' "${image_path#"$raw_dir"/}"
      done
  )
fi

if [ -n "$exclude_filenames" ] && [ -f "$exclude_filenames" ]; then
  mapfile -d '' images < <(
    printf '%s\0' "${images[@]}" |
      python3 -c '
import sys
from pathlib import Path

exclude_file = Path(sys.argv[1])
excluded_names = set()
excluded_stems = set()
for line in exclude_file.read_text().splitlines():
    value = line.strip()
    if not value or value.startswith("#"):
        continue
    path = Path(value)
    excluded_names.add(path.name)
    excluded_stems.add(path.stem)

for raw in sys.stdin.buffer.read().split(b"\0"):
    if not raw:
        continue
    image = raw.decode()
    name = Path(image).name
    stem = Path(image).stem
    if name in excluded_names or stem in excluded_stems:
        continue
    sys.stdout.write(image)
    sys.stdout.write("\0")
' "$exclude_filenames"
  )
fi

total="${#images[@]}"
if [ "$total" -eq 0 ]; then
  echo "No images found in $search_path"
  exit 0
fi

echo "Batch watermark removal"
if [ -n "$image_scope" ]; then
  echo "Scope: $image_scope"
fi
echo "Images: $total"
echo "Concurrency: $concurrency"

if [ "$dry_run" = "1" ]; then
  printf '%s\n' "${images[@]}"
  exit 0
fi

if [ "$concurrency" -eq 1 ]; then
  for image in "${images[@]}"; do
    env -u OUTPUT -u MASK -u CODEX_LOG -u IMAGE_STEM -u IMAGE_DIR -u SAFE_IMAGE \
      PROGRESS_MODE=batch make --no-print-directory remove-one RAW_DIR="$raw_dir" CLEAN_DIR="$clean_dir" STATUS_LOG="$status_log" CODEX="$code_command" IMAGE="$image"
  done
  exit 0
fi

export raw_dir clean_dir status_log code_command
printf '%s\0' "${images[@]}" | xargs -0 -n 1 -P "$concurrency" sh -c '
  image="$1"
  env -u OUTPUT -u MASK -u CODEX_LOG -u IMAGE_STEM -u IMAGE_DIR -u SAFE_IMAGE \
    PROGRESS_MODE=batch make --no-print-directory remove-one RAW_DIR="$raw_dir" CLEAN_DIR="$clean_dir" STATUS_LOG="$status_log" CODEX="$code_command" IMAGE="$image"
' _
