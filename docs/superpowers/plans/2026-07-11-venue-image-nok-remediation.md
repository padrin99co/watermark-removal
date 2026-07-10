# Venue Image NOK Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve or precisely classify every `NOK` venue and produce a new workbook whose `action` column records verified outcomes while preserving the source workbook.

**Architecture:** A dependency-free Python utility copies and annotates the XLSX package without rewriting existing worksheets. A separate evidence inventory derives venue/category gaps from the workbook and local upload/status records; live Strapi operations remain explicit, narrowly scoped commands using the existing linker. Each resolved venue is rechecked before its action is marked `already fixed`.

**Tech Stack:** Python 3 standard library (`zipfile`, `xml.etree.ElementTree`, `csv`), Node.js Strapi linker, Make, XLSX Open XML.

## Global Constraints

- Never overwrite `rules/strapi-venue-images-20260710-235843.xlsx`.
- Never upload reference images before watermark removal.
- Never duplicate an asset already attached to an Office Venue.
- Mark `already fixed` only after fresh category-count verification.
- Keep unrelated workspace changes and debugging images untouched.

---

### Task 1: XLSX Action-Column Annotator

**Files:**
- Create: `scripts/annotate-strapi-venue-actions.py`
- Create: `tests/test_annotate_strapi_venue_actions.py`

**Interfaces:**
- Consumes: source XLSX path, output XLSX path, and JSON object mapping `buildingId` strings to action text.
- Produces: `annotate_workbook(source: Path, output: Path, actions: dict[str, str]) -> None` and a CLI with `--source`, `--output`, and `--actions-json`.

- [ ] **Step 1: Write failing preservation and annotation tests**

Create a miniature two-sheet XLSX fixture with inline strings. Assert that annotation adds `N1=action`, writes the mapped action to column N, leaves unmapped rows blank, preserves sheet 2 byte-for-byte, and refuses identical source/output paths.

```python
def test_annotates_action_and_preserves_second_sheet(self):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = build_fixture(root / "source.xlsx")
        output = root / "output.xlsx"
        annotate_workbook(source, output, {"70": "already fixed — verified Exterior reference=6 strapi=6."})
        self.assertEqual(read_cell(output, "xl/worksheets/sheet1.xml", "N1"), "action")
        self.assertTrue(read_cell(output, "xl/worksheets/sheet1.xml", "N2").startswith("already fixed"))
        self.assertEqual(zip_member(output, "xl/worksheets/sheet2.xml"), zip_member(source, "xl/worksheets/sheet2.xml"))

def test_rejects_overwriting_source(self):
    with tempfile.TemporaryDirectory() as directory:
        source = build_fixture(Path(directory) / "source.xlsx")
        with self.assertRaisesRegex(ValueError, "source workbook"):
            annotate_workbook(source, source, {})
```

- [ ] **Step 2: Run tests and verify failure**

Run: `python3 -m unittest tests/test_annotate_strapi_venue_actions.py -v`

Expected: failure because `scripts/annotate-strapi-venue-actions.py` does not exist.

- [ ] **Step 3: Implement minimal Open XML annotation**

Implement namespace-aware row/cell creation, inline-string values, dimension expansion through column N, atomic output replacement, and explicit source/output inequality. Copy every ZIP member unchanged except `xl/worksheets/sheet1.xml`.

- [ ] **Step 4: Run focused tests**

Run: `python3 -m unittest tests/test_annotate_strapi_venue_actions.py -v`

Expected: all annotator tests pass.

- [ ] **Step 5: Commit the annotator**

```bash
git add scripts/annotate-strapi-venue-actions.py tests/test_annotate_strapi_venue_actions.py
git commit -m "Add venue remediation workbook annotator"
```

### Task 2: Build the NOK Evidence Inventory

**Files:**
- Create: `scripts/inventory-strapi-venue-nok.py`
- Create: `tests/test_inventory_strapi_venue_nok.py`
- Create at runtime: `logs/strapi-venue-nok-actions.json`

**Interfaces:**
- Consumes: source XLSX, `logs/status.tsv`, and `logs/strapi-upload-reports/*.csv`.
- Produces: JSON keyed by building ID with `buildingName`, `officeVenueId`, category gaps, candidate report groups/assets, missing-status images, and initial `action`; `--print-field BUILDING_ID FIELD` prints one stored field for shell-safe linker execution.

- [ ] **Step 1: Write failing classification tests**

Cover three fixtures: a fully uploaded alias candidate, a reference filename absent from status, and a partial category match. Assert the first is `candidate_link`, the second is `download_required`, and the third contains only missing asset IDs.

```python
def test_classifies_alias_candidate():
    result = classify(venue("70", exterior=(6, 0)), reports_with_dea_assets(), done_status())
    assert result["classification"] == "candidate_link"
    assert result["candidateAssetIds"] == [56603, 56604, 56605, 56606, 56607, 56608]

def test_classifies_missing_raw_reference():
    result = classify(venue("181", floorplan=(4, 0)), [], empty_status())
    assert result["classification"] == "download_required"
```

- [ ] **Step 2: Run tests and verify failure**

Run: `python3 -m unittest tests/test_inventory_strapi_venue_nok.py -v`

Expected: failure because the inventory module is absent.

- [ ] **Step 3: Implement deterministic inventory generation**

Parse XLSX inline strings, CSV with Python's CSV parser, and TSV status rows. Match candidates by normalized filename stem and building ID before fuzzy venue-name comparison. Never classify a fuzzy match alone as safe to link.

- [ ] **Step 4: Generate and inspect the real inventory**

```bash
python3 scripts/inventory-strapi-venue-nok.py \
  --workbook rules/strapi-venue-images-20260710-235843.xlsx \
  --status logs/status.tsv \
  --reports logs/strapi-upload-reports \
  --output logs/strapi-venue-nok-actions.json
```

Expected: 78 NOK records including Menara Dea 1, with no duplicate building IDs.

- [ ] **Step 5: Commit the inventory utility**

```bash
git add scripts/inventory-strapi-venue-nok.py tests/test_inventory_strapi_venue_nok.py
git commit -m "Add venue NOK evidence inventory"
```

### Task 3: Resolve Candidate Links One Venue at a Time

**Files:**
- Modify at runtime: `logs/strapi-upload-reports/*.md`
- Modify at runtime: `logs/strapi-venue-nok-actions.json`

**Interfaces:**
- Consumes: inventory records classified `candidate_link`, explicit upload report, source office group, and Office Venue ID.
- Produces: linked Strapi components and verified `already fixed` action text.

- [ ] **Step 1: Recheck Menara Dea 1 as the known-good control**

Confirm report evidence contains six `linked_appended` rows for Office Venue 387 and fresh Strapi data reports Exterior `reference=6 strapi=6`. Set its action to:

`already fixed — linked 6 existing exterior assets to Office Venue 387; verified Exterior reference=6 strapi=6.`

- [ ] **Step 2: Resolve each unambiguous candidate**

For each candidate, run the existing linker with one exact report group and one explicit venue ID:

```bash
REPORT_PATH="$(python3 scripts/inventory-strapi-venue-nok.py --print-field "$BUILDING_ID" reportPath)"
REPORT_OFFICE="$(python3 scripts/inventory-strapi-venue-nok.py --print-field "$BUILDING_ID" reportOffice)"
VENUE_ID="$(python3 scripts/inventory-strapi-venue-nok.py --print-field "$BUILDING_ID" officeVenueId)"
make link-strapi-office-venue-images \
  STRAPI_UPLOAD_REPORT="$REPORT_PATH" \
  STRAPI_OFFICE="$REPORT_OFFICE" \
  STRAPI_OFFICE_VENUE_ID="$VENUE_ID"
```

Expected: linker verification reports every selected asset as `linked_appended` or `linked_existing`.

- [ ] **Step 3: Requery after every venue mutation**

Do not continue to the next venue until the current venue's category counts are fresh. If all counts match, set `already fixed`; otherwise record the remaining mismatch and evidence without claiming resolution.

- [ ] **Step 4: Checkpoint the action inventory**

Validate JSON syntax after every five venues:

`python3 -m json.tool logs/strapi-venue-nok-actions.json >/dev/null`

Expected: exit code 0.

### Task 4: Stage Missing Raw Images

**Files:**
- Create at runtime: `raw-images/exterior/*`, `raw-images/interior/*`, or `raw-images/floorplan/*`
- Modify at runtime: `logs/strapi-venue-nok-actions.json`

**Interfaces:**
- Consumes: inventory records classified `download_required` and reference image URLs embedded in the workbook.
- Produces: downloaded raw files with validated image signatures and actions stating that watermark processing remains required.

- [ ] **Step 1: Download one venue's missing sources at a time**

Use the exact category from the workbook and preserve the URL basename. Refuse overwrites unless the existing file has the same byte length and image dimensions.

- [ ] **Step 2: Validate every downloaded file**

Run Pillow image verification through the existing project environment:

```bash
cd apps && python3 -c "from PIL import Image; import sys; [Image.open(p).verify() for p in sys.argv[1:]]" "${DOWNLOADED_FILES[@]}"
```

Expected: exit code 0.

- [ ] **Step 3: Record pending work accurately**

Set action text such as:

`Downloaded 4 missing floor-plan reference images to raw-images/floorplan; watermark removal, upload, and linking required.`

Do not label these rows `already fixed`.

### Task 5: Produce and Verify the Annotated Workbook

**Files:**
- Create: timestamped `rules/strapi-venue-images-YYYYMMDD-HHMMSS-actions.xlsx`

**Interfaces:**
- Consumes: original workbook and final `logs/strapi-venue-nok-actions.json`.
- Produces: preserved workbook with `action` column N.

- [ ] **Step 1: Generate the output workbook**

```bash
OUTPUT_WORKBOOK="rules/strapi-venue-images-$(date +%Y%m%d-%H%M%S)-actions.xlsx"
python3 scripts/annotate-strapi-venue-actions.py \
  --source rules/strapi-venue-images-20260710-235843.xlsx \
  --output "$OUTPUT_WORKBOOK" \
  --actions-json logs/strapi-venue-nok-actions.json
```

- [ ] **Step 2: Verify workbook structure and action coverage**

Run an Open XML verification that asserts two worksheets, 614 venue data rows, `N1=action`, actions for all original NOK building IDs, and byte-identical `sheet2.xml`.

- [ ] **Step 3: Verify resolution claims**

Assert every action beginning `already fixed` has fresh equal reference/Strapi counts. Summarize totals for `already fixed`, downloaded/pending-watermark, and unresolved.

- [ ] **Step 4: Commit only durable code and the requested workbook**

```bash
git add scripts/annotate-strapi-venue-actions.py scripts/inventory-strapi-venue-nok.py \
  tests/test_annotate_strapi_venue_actions.py tests/test_inventory_strapi_venue_nok.py \
  "$OUTPUT_WORKBOOK"
git commit -m "Record venue image NOK remediation actions"
```
