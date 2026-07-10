# Venue Image NOK Remediation Design

## Objective

Resolve each `NOK` row in `rules/strapi-venue-images-20260710-235843.xlsx` so the exterior, interior, and floor-plan asset counts in Strapi match the reference counts. Record the outcome in a new `action` column while preserving the original workbook.

## Output

Create a new timestamped XLSX based on the source workbook. Add `action` as the final column of the `Venue Image Report` sheet. Preserve the `Watermark Import Status` sheet and all existing cells.

## Row-by-row workflow

For each `NOK` venue:

1. Recheck its current Strapi category counts because the source workbook is a historical snapshot.
2. If the counts now match, write `already fixed` followed by the verified category counts.
3. If assets already exist in a Strapi upload report or media folder, identify naming variations or typos, link only the missing assets to the correct Office Venue, and verify the resulting counts.
4. If reference assets are absent locally, download them into the correct `raw-images/<category>` directory. Do not upload an unclean image. Record that watermark removal, upload, and linking remain required.
5. For any other condition, record the specific evidence and blocker in `action` without claiming resolution.
6. Regenerate or requery the venue data after mutations. A row is resolved only when every category count matches its reference count.

## Action text

Resolved example:

`already fixed — linked 6 existing exterior assets to Office Venue 387; verified Exterior reference=6 strapi=6.`

Downloaded example:

`Downloaded 4 missing interior reference images to raw-images/interior; watermark removal, upload, and linking required.`

Blocked example:

`Unresolved — no uploaded asset ID found for 2 floor-plan references; source URLs returned 404.`

## Safety and error handling

- Never overwrite the source workbook.
- Never duplicate an asset already attached to the target venue.
- Limit each linking operation to one source office group and one explicit Office Venue ID.
- Preserve existing Strapi image components and append only missing media IDs.
- Treat network, authentication, missing-source, and ambiguous-match conditions as blockers and document them in `action`.
- Keep unrelated workspace changes and generated debugging images untouched.

## Verification

- Confirm the output workbook opens as a valid XLSX and has the new `action` header.
- Confirm its data-row count and second worksheet match the source.
- For every row marked `already fixed`, verify all reference and Strapi category counts are equal using fresh Strapi data.
- Summarize counts of resolved, downloaded/pending-watermark, and blocked rows at handoff.
