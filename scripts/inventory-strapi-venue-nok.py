#!/usr/bin/env python3
import argparse
import csv
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlparse
from zipfile import ZipFile
from xml.etree.ElementTree import iterparse


NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
SHEET = "xl/worksheets/sheet1.xml"
CATEGORIES = {"photosExterior": "exterior", "photosInterior": "interior", "photosFloorPlan": "floorplan"}
SUCCESS = {"uploaded", "skipped_existing"}


def column_index(reference):
    letters = "".join(char for char in reference if char.isalpha())
    value = 0
    for char in letters:
        value = value * 26 + ord(char.upper()) - 64
    return value - 1


def read_rows(workbook):
    with ZipFile(workbook) as archive:
        for _event, element in iterparse(archive.open(SHEET), events=("end",)):
            if element.tag != f"{NS}row":
                continue
            values = {}
            for cell in element.findall(f"{NS}c"):
                index = column_index(cell.attrib.get("r", "A1"))
                if cell.attrib.get("t") == "inlineStr":
                    value = "".join(node.text or "" for node in cell.iter(f"{NS}t"))
                else:
                    node = cell.find(f"{NS}v")
                    value = node.text if node is not None else ""
                values[index] = value
            yield values
            element.clear()


def reference_files(text):
    urls = re.findall(r"https?://[^'\s,}\]]+", text or "")
    return [Path(unquote(urlparse(url).path)).name for url in urls]


def parse_counts(text):
    counts = {}
    for category, reference, strapi in re.findall(r"(Exterior|Interior|FloorPlan): reference=(\d+) strapi=(\d+)", text or ""):
        key = {"Exterior": "exterior", "Interior": "interior", "FloorPlan": "floorplan"}[category]
        counts[key] = {"reference": int(reference), "strapi": int(strapi)}
    return counts


def load_venues(workbook):
    rows = iter(read_rows(workbook))
    header_values = next(rows)
    headers = {value: index for index, value in header_values.items()}
    venues = []
    for values in rows:
        row = {name: values.get(index, "") for name, index in headers.items()}
        if row.get("status") != "NOK":
            continue
        content_url = row.get("strapiContentUrl", "")
        match = re.search(r"/(\d+)$", content_url)
        references = {category: reference_files(row.get(column, "")) for column, category in CATEGORIES.items()}
        venues.append({
            "buildingId": str(row.get("buildingId", "")),
            "buildingName": row.get("buildingName", ""),
            "officeVenueId": int(match.group(1)) if match else None,
            "gaps": parse_counts(row.get("totalPhotos", "")),
            "references": references,
            "originalReason": row.get("reason", ""),
        })
    return venues


def load_assets(report_dir):
    assets = []
    for report in sorted(Path(report_dir).glob("strapi-upload-report-*.csv")):
        with report.open(newline="", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                if row.get("status") not in SUCCESS or not row.get("strapi_asset_id"):
                    continue
                row["report_path"] = str(report)
                assets.append(row)
    return assets


def load_status(path):
    statuses = {}
    with Path(path).open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle, delimiter="\t"):
            image = row.get("image", "")
            statuses[image] = row.get("status", "")
            statuses[Path(image).name] = row.get("status", "")
    return statuses


def classify(venue, assets, statuses):
    gap_categories = {category for category, counts in venue["gaps"].items() if counts["reference"] != counts["strapi"]}
    reference_names = {name for category, names in venue["references"].items() if category in gap_categories for name in names}
    building_prefix = f"{venue['buildingId']}_"
    matching_assets = []
    for asset in assets:
        filename = asset.get("filename", "")
        if filename not in reference_names and not filename.startswith(building_prefix):
            continue
        matching_assets.append(asset)

    groups = {}
    for asset in matching_assets:
        key = (asset["report_path"], asset.get("office_name", ""))
        groups.setdefault(key, {})[asset.get("filename", "")] = asset
    complete_groups = [
        (key, list(by_name.values()))
        for key, by_name in groups.items()
        if reference_names and reference_names.issubset(by_name)
    ]
    complete_groups.sort(key=lambda item: item[0][0])
    if complete_groups:
        (report_path, report_office), candidates = complete_groups[-1]
    else:
        report_path = report_office = ""
        candidates = []

    missing_status = sorted(name for name in reference_names if statuses.get(name) not in {"Done", "Skipped"})
    zero_gaps = all(venue["gaps"][category]["strapi"] == 0 for category in gap_categories)
    candidate_names = {asset.get("filename", "") for asset in candidates}
    all_candidates = bool(reference_names) and reference_names.issubset(candidate_names)

    if zero_gaps and all_candidates:
        classification = "candidate_link"
        action = f"Ready to sync {len(candidates)} existing Strapi assets to Office Venue {venue.get('officeVenueId')}; verification required."
    elif missing_status:
        classification = "download_required"
        report_path = report_office = ""
        action = f"Missing {len(missing_status)} image(s) from watermark status; download/reconcile raw images, remove watermark, upload, and link."
    else:
        classification = "needs_investigation"
        report_path = report_office = ""
        action = "Unresolved — category counts differ; existing attachments and upload-report assets require one-by-one comparison."

    return {
        **venue,
        "classification": classification,
        "candidateAssetIds": [int(asset["strapi_asset_id"]) for asset in candidates],
        "candidateAssets": candidates,
        "missingStatusImages": missing_status,
        "reportPath": report_path,
        "reportOffice": report_office,
        "action": action,
    }


def build_inventory(workbook, status, reports):
    assets = load_assets(reports)
    statuses = load_status(status)
    return {venue["buildingId"]: classify(venue, assets, statuses) for venue in load_venues(workbook)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workbook", type=Path)
    parser.add_argument("--status", type=Path)
    parser.add_argument("--reports", type=Path)
    parser.add_argument("--output", type=Path, default=Path("logs/strapi-venue-nok-actions.json"))
    parser.add_argument("--inventory", type=Path, default=Path("logs/strapi-venue-nok-actions.json"))
    parser.add_argument("--print-field", nargs=2, metavar=("BUILDING_ID", "FIELD"))
    args = parser.parse_args()
    if args.print_field:
        building_id, field = args.print_field
        value = json.loads(args.inventory.read_text(encoding="utf-8"))[building_id].get(field, "")
        print(value)
        return
    if not all((args.workbook, args.status, args.reports)):
        parser.error("--workbook, --status, and --reports are required")
    inventory = build_inventory(args.workbook, args.status, args.reports)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(inventory, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(inventory)} NOK records to {args.output}")


if __name__ == "__main__":
    main()
