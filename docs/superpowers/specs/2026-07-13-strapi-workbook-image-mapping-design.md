# Strapi Workbook Image Mapping Design

## Goal

Make every clean reference image link to the correct Strapi Office Venue image category even when its upload-report `office_name` was derived incorrectly from a filename. The operation must preserve every existing Strapi relation and must never delete assets or components.

## Source of Truth

`rules/strapi-venue-images-20260713-155536.xlsx` is authoritative for:

- Office Venue content ID from `strapiContentUrl`.
- Reference filenames from `photosExterior`, `photosInterior`, and `photosFloorPlan`.
- Expected per-category counts.

The latest successful upload report is authoritative for Strapi asset IDs. `clean-images` is authoritative for whether a processed local image exists.

## Mapping Architecture

Add a dependency-free Python manifest generator that reads XLSX Open XML, the clean-image tree, and one upload-report CSV. It emits one record per unique reference image with building ID, Office Venue ID, category, reference filename, clean filename, selected Strapi asset ID, and match evidence.

Matching is deterministic and ordered:

1. Exact case-sensitive filename and category.
2. Exact case-insensitive filename and category when only one candidate exists.
3. Exact normalized stem and category when only one candidate exists, covering extensionless references and converted extensions.
4. A duplicate set is accepted only when every candidate represents the same normalized reference; select one asset deterministically, preferring the exact-case filename, then the upload-report row whose Strapi asset name matches it, then the lowest asset ID.
5. Ambiguous or unmatched references are excluded from production linking and reported for investigation.

The linker receives the manifest instead of inferring Office Venue identity from `office_name`. Assets are grouped by explicit Office Venue ID and category. Existing component media IDs are loaded before mutation; only selected IDs that are not already attached are appended. Existing components remain unchanged except for the serialization required by the current Strapi API.

## Safety and Data Flow

The command defaults to dry-run. Production mode requires the existing explicit confirmation flags and JWT environment variable. It processes one Office Venue at a time, re-fetches the venue after each update, and stops on verification failure. No API DELETE request is implemented.

The workflow is:

1. Generate and validate the manifest.
2. Dry-run all deterministic mappings and record unmatched or ambiguous references.
3. Append missing relations venue by venue.
4. Verify every appended asset ID from fresh Strapi content data.
5. Generate a new audit workbook and compare reference and Strapi category counts.

## Category Components

New relations use the existing component conventions:

- Exterior: `subType=Fasad Gedung`.
- Interior: `subType=Foto Lainnya`.
- Floorplan: `subType=Denah Ruang`.
- All categories: `source=Rumah123`, `type=Top Preview`.

## Error Handling

The manifest command fails before any mutation if the workbook lacks an Office Venue ID, an asset ID is assigned to multiple venues, or a selected clean file is absent. Individual unmatched and ambiguous references remain report entries but are never linked automatically.

The production linker stops immediately when an update fails or when fresh verification cannot find every selected asset. Successfully verified earlier venues remain recorded in an append-only report so a retry can resume safely without duplicating relations.

## Testing and Acceptance

Unit tests cover XLSX shared and inline strings, exact matches, extension conversion, `.JPG`/`.jpg` duplicate selection, ambiguity rejection, category assignment, and prevention of cross-venue asset reuse. Linker tests cover dry-run behavior, append-only payloads, already-linked assets, and failed post-update verification.

Acceptance requires:

- No existing relation or Strapi asset is deleted.
- Every automatic link has deterministic workbook-to-clean-to-asset evidence.
- Every appended asset is confirmed by a fresh Strapi read.
- A fresh audit reports the remaining category mismatches accurately; no `OK` claim is made for unresolved or over-counted categories.
