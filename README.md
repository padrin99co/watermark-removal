# Watermark Remover

Workflow for cleaning Office Venue images, uploading the cleaned files to Strapi Media Library, and linking those media files to Office Venue content.

## Overview and Flow

1. Remove watermarks from raw images.

   ```bash
   make remove CONCURRENCY=4
   ```

   Source images are read from `raw-images/`, and cleaned images are written to `clean-images/`.

2. Upload cleaned images to Strapi.

   ```bash
   export STRAPI_ADMIN_JWT='<admin-jwt>'
   make upload-strapi-images
   ```

   A successful upload also updates:

   ```text
   rules/strapi-office-venue-existing-filenames.txt
   ```

   That rules file is used by the watermark-removal batch flow, so images already uploaded or already found in Strapi are ignored by later `make remove`, `make retry-failed`, and `make continue-progress` runs.

3. Link uploaded images to Strapi Office Venue content.

   This runs automatically after `make upload-strapi-images`.

   You can also run it manually for images that were already uploaded:

   ```bash
   make link-strapi-office-venue-images
   ```

The link step reads the latest upload report, groups rows by `office_name`, matches each group to Office Venue content by `slug`, and links the media assets into the Office Venue `image` component field.

Existing links are checked by media ID:

```text
image[] -> imageUrl[] -> id
```

If a media ID is already present, the content entry is not updated.

Image `subType` is based on source category:

| Source category | Strapi `subType` |
| --- | --- |
| `interior` | `Foto Lainnya` |
| `exterior` | `Fasad Gedung` |
| `floorplan` | `Denah Ruang` |

## Common Command

Full production flow:

```bash
export STRAPI_ADMIN_JWT='<admin-jwt>'

make remove CONCURRENCY=4
make upload-strapi-images STRAPI_EXTRA_ARGS=--confirm-production
```

Upload automatically runs the content-link step after the upload report is written.

Link one Office Venue slug from the latest report:

```bash
make link-strapi-office-venue-images \
  STRAPI_OFFICE=graha-cimb-niaga \
  STRAPI_EXTRA_ARGS=--confirm-production
```

Preview upload without changing Strapi:

```bash
make upload-strapi-images-dry-run
```

## Report Folder Structure

| Path | Purpose |
| --- | --- |
| `raw-images/` | Source images before watermark removal. |
| `clean-images/` | Cleaned images produced by `make remove`. |
| `logs/strapi-upload-reports/` | Upload and content-link reports. |
| `rules/strapi-office-venue-existing-filenames.txt` | Uploaded/existing filenames skipped by later watermark-removal runs. |

Each upload writes reports like:

```text
logs/strapi-upload-reports/strapi-upload-report-<timestamp>.csv
logs/strapi-upload-reports/strapi-upload-report-<timestamp>.md
```

The CSV report is used by `make link-strapi-office-venue-images`. The Markdown report is for human review and includes media URLs, content URLs, and relation status after linking.

Future upload reports include:

```text
relative_path
local_category
```

Those fields make the `interior` / `exterior` / `floorplan` to `subType` mapping explicit.

## Available Command

| Command | Purpose |
| --- | --- |
| `make remove CONCURRENCY=4` | Remove watermarks from raw images and write cleaned images. |
| `make upload-strapi-images` | Upload cleaned images to Strapi, update uploaded filename rules, and link content. |
| `make upload-strapi-images-dry-run` | Preview which images would upload. |
| `make link-strapi-office-venue-images` | Link uploaded media from the latest report to Office Venue content. |
| `make link-strapi-office-venue-images STRAPI_OFFICE=graha-cimb-niaga` | Link only one Office Venue slug. |
| `make retry-failed CONCURRENCY=4` | Retry images marked failed in `logs/status.tsv`. |
| `make continue-progress CONCURRENCY=4` | Continue images marked in progress in `logs/status.tsv`. |
| `make status` | Show watermark-removal status summary. |
| `make clean` | Remove generated cleaned images and temporary logs. |

Production Strapi defaults to:

```text
STRAPI_BASE_URL=https://cms.rumah123.com
STRAPI_ROOT_FOLDER_PATH=Media Library/Office Venue
STRAPI_IMAGE_DIR=clean-images
```

Production access requires confirmation. In an interactive shell, type `production` when prompted. For non-interactive runs, pass:

```bash
STRAPI_EXTRA_ARGS=--confirm-production
```
