#!/usr/bin/env python3
import argparse
import ast
import csv
import json
import re
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from urllib.parse import unquote, urlparse
from zipfile import ZipFile
from xml.etree import ElementTree as ET


NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
CATEGORY_COLUMNS = {
    "exterior": "photosExterior",
    "interior": "photosInterior",
    "floorplan": "photosFloorPlan",
}
SUCCESS = {"uploaded", "skipped_existing"}


def column_index(reference):
    match = re.match(r"([A-Z]+)", reference or "")
    if not match:
        return 0
    value = 0
    for char in match.group(1):
        value = value * 26 + ord(char) - 64
    return value - 1


def read_xlsx_rows(workbook, sheet_name="Venue Image Report"):
    with ZipFile(workbook) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(node.text or "" for node in item.iter(f"{NS}t")) for item in root.findall(f"{NS}si")]

        workbook_xml = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships_xml = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relationships = {item.attrib["Id"]: item.attrib["Target"] for item in relationships_xml.findall(f"{PKG_NS}Relationship")}
        sheet = next((item for item in workbook_xml.find(f"{NS}sheets") if item.attrib.get("name") == sheet_name), None)
        if sheet is None:
            raise ValueError(f"Workbook has no sheet named {sheet_name}")
        target = relationships[sheet.attrib[f"{REL_NS}id"]].lstrip("/")
        sheet_path = target if target.startswith("xl/") else f"xl/{target}"
        sheet_xml = ET.fromstring(archive.read(sheet_path))

        raw_rows = []
        for row in sheet_xml.iter(f"{NS}row"):
            values = {}
            for cell in row.findall(f"{NS}c"):
                index = column_index(cell.attrib.get("r", "A1"))
                value_node = cell.find(f"{NS}v")
                cell_type = cell.attrib.get("t")
                if cell_type == "inlineStr":
                    value = "".join(node.text or "" for node in cell.iter(f"{NS}t"))
                elif value_node is None:
                    value = ""
                elif cell_type == "s":
                    value = shared[int(value_node.text)]
                else:
                    value = value_node.text or ""
                values[index] = value
            raw_rows.append(values)

    if not raw_rows:
        return []
    headers = {index: value for index, value in raw_rows[0].items()}
    return [{name: values.get(index, "") for index, name in headers.items()} for values in raw_rows[1:]]


def parse_photo_filenames(value):
    try:
        parsed = ast.literal_eval(value or "{}")
    except (SyntaxError, ValueError):
        return []
    photos = parsed.get("photos", []) if isinstance(parsed, dict) else parsed if isinstance(parsed, list) else []
    return [unquote(Path(urlparse(str(url)).path).name) for url in photos if url]


def parse_counts(value):
    result = {}
    names = {"Exterior": "exterior", "Interior": "interior", "FloorPlan": "floorplan"}
    for category, reference, strapi in re.findall(r"(Exterior|Interior|FloorPlan):\s*reference=(\d+)\s+strapi=(\d+)", value or ""):
        result[names[category]] = {"reference": int(reference), "strapi": int(strapi)}
    return result


@lru_cache(maxsize=None)
def normalize_filename(value):
    return unquote(Path(str(value or "")).name).casefold()


@lru_cache(maxsize=None)
def normalize_stem(value):
    return Path(normalize_filename(value)).stem


def select_reference_asset(reference_filename, category, clean_filenames, assets):
    clean = list(clean_filenames)
    exact_clean = [name for name in clean if name == reference_filename]
    folded_clean = [name for name in clean if normalize_filename(name) == normalize_filename(reference_filename)]
    stem_clean = [name for name in clean if normalize_stem(name) == normalize_stem(reference_filename)]

    if exact_clean:
        clean_filename = sorted(exact_clean)[0]
        match_kind = "exact"
    elif len(folded_clean) == 1:
        clean_filename = folded_clean[0]
        match_kind = "case_insensitive"
    elif stem_clean:
        distinct_stems = {normalize_stem(name) for name in stem_clean}
        if len(distinct_stems) != 1:
            raise ValueError(f"Ambiguous clean files for {category}/{reference_filename}")
        clean_filename = sorted(stem_clean, key=lambda name: (Path(name).suffix.lower() not in {".jpg", ".jpeg", ".png"}, name.casefold(), name))[0]
        match_kind = "normalized_stem"
    else:
        raise ValueError(f"No clean image for {category}/{reference_filename}")

    candidates = [row for row in assets if row.get("status") in SUCCESS and row.get("local_category") == category and row.get("strapi_asset_id")]
    exact_assets = [row for row in candidates if row.get("filename") == clean_filename]
    folded_assets = [row for row in candidates if normalize_filename(row.get("filename")) == normalize_filename(clean_filename)]
    stem_assets = [row for row in candidates if normalize_stem(row.get("filename")) == normalize_stem(clean_filename)]
    selected = exact_assets or folded_assets or stem_assets
    if not selected:
        raise ValueError(f"No uploaded Strapi asset for {category}/{clean_filename}")
    if len({normalize_stem(row.get("filename")) for row in selected}) != 1:
        raise ValueError(f"Ambiguous uploaded assets for {category}/{clean_filename}")

    selected.sort(key=lambda row: (
        row.get("filename") != clean_filename,
        row.get("strapi_asset_name") != clean_filename,
        int(row.get("strapi_asset_id")),
    ))
    asset = selected[0]
    return {
        "assetId": int(asset["strapi_asset_id"]),
        "referenceFilename": reference_filename,
        "cleanFilename": clean_filename,
        "strapiFilename": asset.get("strapi_asset_name") or asset.get("filename") or "",
        "category": category,
        "match": match_kind,
        "reportPath": asset.get("report_path", ""),
    }


def load_report_assets(report_paths):
    assets_by_id = {}
    for report in sorted(map(Path, report_paths)):
        with report.open(newline="", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                if row.get("status") not in SUCCESS or not row.get("strapi_asset_id"):
                    continue
                row["report_path"] = str(report)
                assets_by_id[int(row["strapi_asset_id"])] = row
    return list(assets_by_id.values())


def load_clean_filenames(clean_dir):
    result = defaultdict(list)
    for category in CATEGORY_COLUMNS:
        directory = Path(clean_dir) / category
        if directory.is_dir():
            result[category].extend(path.name for path in directory.iterdir() if path.is_file())
    return result


def build_manifest(workbook, clean_dir, report_paths):
    clean = load_clean_filenames(clean_dir)
    assets = load_report_assets(report_paths)
    venues = []
    unresolved = []
    for row in read_xlsx_rows(workbook):
        if str(row.get("status", "")).upper() != "NOK":
            continue
        id_match = re.search(r"/(\d+)$", row.get("strapiContentUrl", ""))
        office_venue_id = int(id_match.group(1)) if id_match else None
        counts = parse_counts(row.get("totalPhotos", ""))
        deficit_categories = {category for category, value in counts.items() if value["strapi"] < value["reference"]}
        venue = {
            "buildingId": str(row.get("buildingId", "")),
            "buildingName": row.get("buildingName", ""),
            "officeVenueId": office_venue_id,
            "expected": {category: value["reference"] for category, value in counts.items()},
            "before": {category: value["strapi"] for category, value in counts.items()},
            "assets": [],
        }
        if office_venue_id is None:
            unresolved.append({"buildingId": venue["buildingId"], "reason": "missing Office Venue ID"})
            venues.append(venue)
            continue
        seen_asset_ids = set()
        for category in sorted(deficit_categories):
            for reference in parse_photo_filenames(row.get(CATEGORY_COLUMNS[category], "")):
                try:
                    mapping = select_reference_asset(reference, category, clean[category], assets)
                except ValueError as error:
                    unresolved.append({
                        "buildingId": venue["buildingId"],
                        "buildingName": venue["buildingName"],
                        "officeVenueId": office_venue_id,
                        "category": category,
                        "referenceFilename": reference,
                        "reason": str(error),
                    })
                    continue
                if mapping["assetId"] not in seen_asset_ids:
                    venue["assets"].append(mapping)
                    seen_asset_ids.add(mapping["assetId"])
        venues.append(venue)

    manifest = {
        "sourceWorkbook": str(workbook),
        "cleanDirectory": str(clean_dir),
        "reports": [str(path) for path in report_paths],
        "venues": venues,
        "unresolved": unresolved,
    }
    validate_manifest(manifest)
    return manifest


def validate_manifest(manifest):
    owners = {}
    for venue in manifest.get("venues", []):
        venue_id = int(venue["officeVenueId"]) if venue.get("officeVenueId") is not None else None
        for asset in venue.get("assets", []):
            asset_id = int(asset["assetId"])
            previous = owners.setdefault(asset_id, venue_id)
            if previous != venue_id:
                raise ValueError(f"Strapi asset {asset_id} is assigned to multiple Office Venues: {previous}, {venue_id}")
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workbook", type=Path, required=True)
    parser.add_argument("--clean-dir", type=Path, default=Path("clean-images"))
    parser.add_argument("--reports", type=Path, required=True, help="Upload report CSV or directory containing reports")
    parser.add_argument("--output", type=Path, default=Path("logs/strapi-venue-image-mapping.json"))
    parser.add_argument("--allow-unresolved", action="store_true")
    args = parser.parse_args()
    report_paths = sorted(args.reports.glob("strapi-upload-report-*.csv")) if args.reports.is_dir() else [args.reports]
    manifest = build_manifest(args.workbook, args.clean_dir, report_paths)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    asset_count = sum(len(venue["assets"]) for venue in manifest["venues"])
    print(f"Wrote {len(manifest['venues'])} venue mappings with {asset_count} assets to {args.output}")
    print(f"Unresolved references: {len(manifest['unresolved'])}")
    if manifest["unresolved"] and not args.allow_unresolved:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
