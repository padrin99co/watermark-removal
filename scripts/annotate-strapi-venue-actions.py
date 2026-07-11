#!/usr/bin/env python3
import argparse
import json
import os
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from xml.etree import ElementTree as ET


NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
SHEET = "xl/worksheets/sheet1.xml"
ET.register_namespace("", NS)


def q(name):
    return f"{{{NS}}}{name}"


def inline_cell(reference, value):
    cell = ET.Element(q("c"), {"r": reference, "t": "inlineStr"})
    inline = ET.SubElement(cell, q("is"))
    text = ET.SubElement(inline, q("t"))
    text.text = str(value)
    return cell


def set_inline_text(cell, value):
    for child in list(cell):
        cell.remove(child)
    cell.set("t", "inlineStr")
    inline = ET.SubElement(cell, q("is"))
    text = ET.SubElement(inline, q("t"))
    text.text = str(value)


def cell_text(cell):
    return "".join(node.text or "" for node in cell.iter(q("t")))


def annotate_sheet(data, actions):
    root = ET.fromstring(data)
    sheet_data = root.find(q("sheetData"))
    if sheet_data is None:
        raise ValueError("Venue Image Report has no sheetData")

    for row in sheet_data.findall(q("row")):
        row_number = row.attrib.get("r", "")
        first = row.find(f"{q('c')}[@r='A{row_number}']")
        if row_number == "1":
            value = "action"
        elif first is not None:
            value = actions.get(cell_text(first))
        else:
            value = None
        if value is None:
            continue
        if isinstance(value, dict):
            for column, field in (("L", "status"), ("M", "reason")):
                replacement = value.get(field)
                if replacement is None:
                    continue
                existing = row.find(f"{q('c')}[@r='{column}{row_number}']")
                if existing is None:
                    existing = inline_cell(f"{column}{row_number}", replacement)
                    row.append(existing)
                else:
                    set_inline_text(existing, replacement)
            value = value.get("action", "")
        existing = row.find(f"{q('c')}[@r='N{row_number}']")
        if existing is not None:
            row.remove(existing)
        row.append(inline_cell(f"N{row_number}", value))

    dimension = root.find(q("dimension"))
    if dimension is not None:
        ref = dimension.attrib.get("ref", "A1")
        end = ref.split(":")[-1]
        digits = "".join(char for char in end if char.isdigit()) or "1"
        dimension.set("ref", f"A1:N{digits}")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def annotate_workbook(source, output, actions):
    source = Path(source).resolve()
    output = Path(output).resolve()
    if source == output:
        raise ValueError("output must not overwrite the source workbook")
    if not source.is_file():
        raise FileNotFoundError(source)
    output.parent.mkdir(parents=True, exist_ok=True)

    with ZipFile(source) as input_archive:
        annotated = annotate_sheet(input_archive.read(SHEET), actions)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
        os.close(fd)
        try:
            with ZipFile(temporary_name, "w", ZIP_DEFLATED) as output_archive:
                for info in input_archive.infolist():
                    output_archive.writestr(info, annotated if info.filename == SHEET else input_archive.read(info.filename))
            os.replace(temporary_name, output)
        except BaseException:
            Path(temporary_name).unlink(missing_ok=True)
            raise


def load_actions(path):
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    actions = {}
    for building_id, value in payload.items():
        if isinstance(value, dict):
            actions[str(building_id)] = {
                key: str(value[key]) for key in ("status", "reason", "action") if value.get(key) is not None
            }
        else:
            actions[str(building_id)] = str(value)
    return actions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--actions-json", required=True, type=Path)
    args = parser.parse_args()
    annotate_workbook(args.source, args.output, load_actions(args.actions_json))
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
