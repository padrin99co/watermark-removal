import csv
import importlib.util
import tempfile
import unittest
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


SCRIPT = Path(__file__).parents[1] / "scripts" / "build-strapi-venue-mapping.py"


def load_module():
    spec = importlib.util.spec_from_file_location("build_mapping", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_shared_string_workbook(path):
    strings = ["buildingId", "buildingName", "status", "7", "Graha Mustika Ratu", "NOK"]
    shared = "".join(f"<si><t>{value}</t></si>" for value in strings)
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
            '<sheet name="Venue Image Report" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>',
        )
        archive.writestr(
            "xl/sharedStrings.xml",
            f'<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{shared}</sst>',
        )
        archive.writestr(
            "xl/worksheets/sheet1.xml",
            '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
            '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row>'
            '</sheetData></worksheet>',
        )
    return path


class MappingTests(unittest.TestCase):
    def test_reads_shared_string_workbook(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            rows = module.read_xlsx_rows(build_shared_string_workbook(Path(directory) / "fixture.xlsx"))
        self.assertEqual(rows[0]["buildingId"], "7")
        self.assertEqual(rows[0]["buildingName"], "Graha Mustika Ratu")
        self.assertEqual(rows[0]["status"], "NOK")

    def test_prefers_exact_case_filename_over_case_variant(self):
        module = load_module()
        clean = ["sample.JPG", "sample.jpg"]
        assets = [
            {"filename": "sample.JPG", "local_category": "exterior", "strapi_asset_id": "10", "status": "uploaded", "strapi_asset_name": "sample.JPG"},
            {"filename": "sample.jpg", "local_category": "exterior", "strapi_asset_id": "11", "status": "uploaded", "strapi_asset_name": "sample.jpg"},
        ]
        result = module.select_reference_asset("sample.JPG", "exterior", clean, assets)
        self.assertEqual(result["assetId"], 10)
        self.assertEqual(result["cleanFilename"], "sample.JPG")
        self.assertEqual(result["match"], "exact")

    def test_maps_extensionless_reference_to_unique_image_extension(self):
        module = load_module()
        assets = [{"filename": "plan.jpg", "local_category": "floorplan", "strapi_asset_id": "12", "status": "skipped_existing", "strapi_asset_name": "plan.jpg"}]
        result = module.select_reference_asset("plan", "floorplan", ["plan.jpg"], assets)
        self.assertEqual(result["assetId"], 12)
        self.assertEqual(result["match"], "normalized_stem")

    def test_extensionless_reference_with_dots_is_not_treated_as_an_extension(self):
        module = load_module()
        reference = "-the-st.-regis-office-tower-exterior-1670811793076-0"
        clean = f"{reference}.jpg"
        assets = [{"filename": clean, "local_category": "exterior", "strapi_asset_id": "13", "status": "uploaded", "strapi_asset_name": clean}]
        result = module.select_reference_asset(reference, "exterior", [clean], assets)
        self.assertEqual(result["assetId"], 13)
        self.assertEqual(result["match"], "normalized_stem")

    def test_rejects_cross_venue_asset_reuse(self):
        module = load_module()
        manifest = {
            "venues": [
                {"officeVenueId": 1, "assets": [{"assetId": 99}]},
                {"officeVenueId": 2, "assets": [{"assetId": 99}]},
            ]
        }
        with self.assertRaisesRegex(ValueError, "multiple Office Venues"):
            module.validate_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
