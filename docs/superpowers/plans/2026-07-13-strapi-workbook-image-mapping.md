# Strapi Workbook Image Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministically map clean reference images to their XLSX Office Venue IDs, append missing Strapi relations without deletion, and verify that a fresh deficit audit contains zero `NOK` venues.

**Architecture:** A Python manifest builder joins workbook references, `clean-images`, and successful upload-report assets by category and normalized filename. The Node linker consumes the manifest, groups exact asset IDs by Office Venue ID, preserves existing components, appends missing relations, and writes fresh per-category verification evidence.

**Tech Stack:** Python 3 standard library, XLSX Open XML, CSV/JSON, Node.js ESM and built-in test runner, Strapi Content Manager API.

## Global Constraints

- Never delete a Strapi asset, component, or existing relation.
- Never store the JWT in a repository file or generated report.
- Default every new production-capable command to dry-run.
- Exclude ambiguous or unmatched images from automatic linking.
- Claim zero `NOK` only from fresh post-update Strapi reads.

---

### Task 1: Deterministic Mapping Manifest

**Files:**
- Create: `scripts/build-strapi-venue-mapping.py`
- Create: `tests/test_build_strapi_venue_mapping.py`

**Interfaces:**
- Consumes: `build_manifest(workbook: Path, clean_dir: Path, report_paths: list[Path]) -> dict`.
- Produces: JSON with `venues`, selected `assets`, expected category counts, and `unresolved` evidence.

- [ ] **Step 1: Write failing tests** for shared-string XLSX rows, exact filename mapping, extensionless-to-image-extension mapping, `.JPG`/`.jpg` deduplication, and ambiguity rejection.
- [ ] **Step 2: Run** `python3 -m unittest tests/test_build_strapi_venue_mapping.py -v` and confirm failure because the module is absent.
- [ ] **Step 3: Implement** Open XML parsing, reference URL extraction, category-scoped clean/report indexes, deterministic asset selection, and cross-venue asset-ID validation.
- [ ] **Step 4: Re-run** the focused tests and the existing Python suite; require zero failures.
- [ ] **Step 5: Generate** `logs/strapi-venue-image-mapping.json` and require `unresolved=[]` before production linking.

### Task 2: Manifest-Aware Append-Only Linker

**Files:**
- Modify: `scripts/link-strapi-office-venue-images.mjs`
- Create: `tests/link-strapi-office-venue-images.test.mjs`

**Interfaces:**
- Consumes: `--mapping-manifest <json>` and the manifest schema from Task 1.
- Produces: append-only Office Venue updates plus `logs/strapi-venue-image-link-verification.json`.

- [ ] **Step 1: Write failing Node tests** proving manifest grouping uses explicit venue IDs, already-linked IDs are not appended, existing components remain in the payload, and no delete request exists.
- [ ] **Step 2: Run** `node --test tests/link-strapi-office-venue-images.test.mjs` and confirm the expected missing-feature failure.
- [ ] **Step 3: Implement** manifest loading and validation, explicit venue grouping, category component construction, post-update asset verification, and JSON evidence output while preserving the legacy CSV path.
- [ ] **Step 4: Re-run** Node tests and `node --check scripts/link-strapi-office-venue-images.mjs`; require zero failures.
- [ ] **Step 5: Run a production read-only dry run** with the JWT environment variable and inspect every unresolved or missing relation before mutation.

### Task 3: Reconcile Missing Extensionless References

**Files:**
- Modify at runtime: `raw-images/{exterior,floorplan}` and `clean-images/{exterior,floorplan}`
- Create at runtime: a timestamped Strapi upload report

**Interfaces:**
- Consumes: manifest `unresolved` entries whose source exists as a valid extensionless raw image.
- Produces: readable, properly extended raw/clean images and successful Strapi asset IDs.

- [ ] **Step 1: Validate** each extensionless source by image signature and choose `.jpg` or `.png` from decoded content.
- [ ] **Step 2: Create properly extended raw copies without overwriting existing files**, then run the existing watermark-removal command only for these unresolved files.
- [ ] **Step 3: Verify** each clean output is readable and dimension-matched to its raw source.
- [ ] **Step 4: Upload** only the newly produced clean images and require zero upload failures.
- [ ] **Step 5: Regenerate** the manifest from all relevant reports and require no unresolved references.

### Task 4: Production Linking and Fresh Audit

**Files:**
- Create at runtime: `logs/strapi-venue-image-link-verification.json`
- Create at runtime: a timestamped post-link audit report/workbook when the existing audit command is available

**Interfaces:**
- Consumes: validated manifest and JWT supplied only through `STRAPI_ADMIN_JWT`.
- Produces: fresh Office Venue relations and category-count evidence.

- [ ] **Step 1: Execute** the manifest linker with production confirmation, one venue at a time, stopping on the first failed verification.
- [ ] **Step 2: Re-fetch** all affected Office Venues and compare `Exterior`, `Interior`, and `FloorPlan` counts with workbook references.
- [ ] **Step 3: Retry** only deterministic missing relations; never resolve overcounts by deletion.
- [ ] **Step 4: Run** the full Python and Node test suites plus mapping validation.
- [ ] **Step 5: Report** fresh status totals and list any non-`NOK` overcount (`INFO`) rows separately.
