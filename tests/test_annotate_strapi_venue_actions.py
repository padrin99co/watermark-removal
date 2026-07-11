import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from xml.etree import ElementTree as ET


SCRIPT = Path(__file__).parents[1] / "scripts" / "annotate-strapi-venue-actions.py"
SPEC = importlib.util.spec_from_file_location("annotate_actions", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def build_fixture(path):
    sheet1 = f'''<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="{NS}"><dimension ref="A1:M3"/><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>buildingId</t></is></c><c r="L1" t="inlineStr"><is><t>status</t></is></c><c r="M1" t="inlineStr"><is><t>reason</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>70</t></is></c><c r="L2" t="inlineStr"><is><t>NOK</t></is></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>71</t></is></c><c r="L3" t="inlineStr"><is><t>INFO</t></is></c></row>
</sheetData></worksheet>'''.encode()
    sheet2 = f'''<?xml version="1.0"?><worksheet xmlns="{NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>status</t></is></c></row></sheetData></worksheet>'''.encode()
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", sheet1)
        archive.writestr("xl/worksheets/sheet2.xml", sheet2)
    return path


def member(path, name):
    with ZipFile(path) as archive:
        return archive.read(name)


def cell(path, reference):
    root = ET.fromstring(member(path, "xl/worksheets/sheet1.xml"))
    node = root.find(f".//{{{NS}}}c[@r='{reference}']")
    if node is None:
        return None
    return "".join(item.text or "" for item in node.iter(f"{{{NS}}}t"))


class AnnotateWorkbookTests(unittest.TestCase):
    def test_annotates_action_and_preserves_second_sheet(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = build_fixture(root / "source.xlsx")
            output = root / "output.xlsx"
            original_sheet2 = member(source, "xl/worksheets/sheet2.xml")
            MODULE.annotate_workbook(source, output, {"70": "already fixed — verified 6/6"})
            self.assertEqual(cell(output, "N1"), "action")
            self.assertEqual(cell(output, "N2"), "already fixed — verified 6/6")
            self.assertIsNone(cell(output, "N3"))
            self.assertEqual(member(output, "xl/worksheets/sheet2.xml"), original_sheet2)

    def test_rejects_overwriting_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = build_fixture(Path(directory) / "source.xlsx")
            with self.assertRaisesRegex(ValueError, "source workbook"):
                MODULE.annotate_workbook(source, source, {})

    def test_loads_nested_action_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "actions.json"
            path.write_text(json.dumps({"70": {"action": "already fixed"}}))
            self.assertEqual(MODULE.load_actions(path), {"70": {"action": "already fixed"}})

    def test_updates_status_and_reason_from_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = build_fixture(root / "source.xlsx")
            output = root / "output.xlsx"
            MODULE.annotate_workbook(source, output, {"70": {"status": "OK", "reason": "Counts match", "action": "already fixed"}})
            self.assertEqual(cell(output, "L2"), "OK")
            self.assertEqual(cell(output, "M2"), "Counts match")
            self.assertEqual(cell(output, "N2"), "already fixed")


if __name__ == "__main__":
    unittest.main()
