#!/usr/bin/env python3
import csv
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_INPUT = Path("logs/missing_csv_not_raw_or_status.tsv")
RAW_DIR = Path("raw-images")
LOG_DIR = Path("logs")
USER_AGENT = "Mozilla/5.0 (compatible; watermark-remover-downloader/1.0)"
TIMEOUT_SECONDS = 45
MAX_WORKERS = 12
RETRIES = 3


def download(row):
    relative_path = row["relative_path"]
    url = row["url"]
    target = RAW_DIR / relative_path
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists() and target.stat().st_size > 0:
        return "exists", relative_path, ""

    tmp = target.with_name(target.name + ".tmp")
    last_error = ""

    for attempt in range(1, RETRIES + 1):
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                data = response.read()
            if not data:
                raise ValueError("empty response")
            tmp.write_bytes(data)
            tmp.replace(target)
            return "downloaded", relative_path, ""
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as error:
            last_error = f"attempt {attempt}: {type(error).__name__}: {error}"
            if tmp.exists():
                tmp.unlink(missing_ok=True)
            time.sleep(min(attempt * 2, 10))

    return "failed", relative_path, last_error


def read_rows(path):
    with path.open(newline="", encoding="utf-8", errors="replace") as file:
        yield from csv.DictReader(file, delimiter="\t")


def main():
    input_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_INPUT
    rows = list(read_rows(input_path))
    LOG_DIR.mkdir(exist_ok=True)
    failures_path = LOG_DIR / "download-missing-raw-images-failures.tsv"
    summary_path = LOG_DIR / "download-missing-raw-images-summary.txt"

    counts = {"downloaded": 0, "exists": 0, "failed": 0}
    failures = []

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(download, row) for row in rows]
        for index, future in enumerate(as_completed(futures), 1):
            status, relative_path, error = future.result()
            counts[status] += 1
            if status == "failed":
                failures.append((relative_path, error))
            if index % 100 == 0 or index == len(rows):
                print(
                    f"processed={index}/{len(rows)} downloaded={counts['downloaded']} "
                    f"exists={counts['exists']} failed={counts['failed']}",
                    flush=True,
                )

    with failures_path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file, delimiter="\t")
        writer.writerow(["relative_path", "error"])
        writer.writerows(failures)

    summary = (
        f"input={input_path}\n"
        f"total={len(rows)}\n"
        f"downloaded={counts['downloaded']}\n"
        f"already_exists={counts['exists']}\n"
        f"failed={counts['failed']}\n"
        f"failures={failures_path}\n"
    )
    summary_path.write_text(summary, encoding="utf-8")
    print(summary, end="")
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
