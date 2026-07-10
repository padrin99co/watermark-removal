import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "inventory-strapi-venue-nok.py"
SPEC = importlib.util.spec_from_file_location("inventory_nok", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class InventoryTests(unittest.TestCase):
    def test_matches_assets_by_building_id_and_category(self):
        venue = {
            "buildingId": "70",
            "gaps": {"exterior": {"reference": 2, "strapi": 0}},
            "references": {"exterior": ["70_menara-dea-a.jpg", "70_menara-dea-b.jpg"]},
        }
        assets = [
            {"office_name": "menara-dea-i", "local_category": "exterior", "filename": "70_menara-dea-a.jpg", "status": "uploaded", "strapi_asset_id": "10", "report_path": "report.csv"},
            {"office_name": "menara-dea-i", "local_category": "exterior", "filename": "70_menara-dea-b.jpg", "status": "skipped_existing", "strapi_asset_id": "11", "report_path": "report.csv"},
        ]
        result = MODULE.classify(venue, assets, {})
        self.assertEqual(result["classification"], "candidate_link")
        self.assertEqual(result["candidateAssetIds"], [10, 11])
        self.assertEqual(result["reportOffice"], "menara-dea-i")

    def test_missing_status_requires_download_or_reconciliation(self):
        venue = {
            "buildingId": "181",
            "gaps": {"floorplan": {"reference": 1, "strapi": 0}},
            "references": {"floorplan": ["181_plan.jpg"]},
        }
        result = MODULE.classify(venue, [], {})
        self.assertEqual(result["classification"], "download_required")
        self.assertEqual(result["missingStatusImages"], ["181_plan.jpg"])

    def test_partial_candidates_are_not_claimed_fixed(self):
        venue = {
            "buildingId": "95",
            "gaps": {"interior": {"reference": 2, "strapi": 1}},
            "references": {"interior": ["95_a.jpg", "95_b.jpg"]},
        }
        assets = [{"office_name": "gedung-bni", "local_category": "interior", "filename": "95_a.jpg", "status": "uploaded", "strapi_asset_id": "20", "report_path": "r.csv"}]
        result = MODULE.classify(venue, assets, {"95_a.jpg": "Done", "95_b.jpg": "Done"})
        self.assertEqual(result["classification"], "needs_investigation")
        self.assertNotIn("already fixed", result["action"])


if __name__ == "__main__":
    unittest.main()
