from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path
import sys


FIELDNAMES = ["status", "image", "output", "message", "updated_at"]


def main() -> int:
    if len(sys.argv) != 6:
        print("usage: status-log.py <status-file> <status> <image> <output> <message>", file=sys.stderr)
        return 2

    status_file = Path(sys.argv[1])
    status = sys.argv[2]
    image = sys.argv[3]
    output = sys.argv[4]
    message = sys.argv[5]
    updated_at = datetime.now().astimezone().isoformat(timespec="seconds")

    status_file.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    if status_file.exists():
        with status_file.open(newline="") as file:
            rows = list(csv.DictReader(file, delimiter="\t"))

    next_row = {
        "status": status,
        "image": image,
        "output": output,
        "message": message,
        "updated_at": updated_at,
    }
    rows = [row for row in rows if row.get("image") != image]
    rows.append(next_row)
    rows.sort(key=lambda row: row["image"])

    with status_file.open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=FIELDNAMES, delimiter="\t")
        writer.writeheader()
        writer.writerows(rows)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
