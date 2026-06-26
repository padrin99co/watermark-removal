# Watermark Remover

Workflow for cleaning Office Venue images, uploading the cleaned files to Strapi Media Library, and linking those media files to Office Venue content.

## Main Flow

1. Remove watermarks from raw images:

   ```bash
   make remove CONCURRENCY=4
   ```

2. Upload cleaned images to Strapi:

   ```bash
   export STRAPI_ADMIN_JWT='<admin-jwt>'
   make upload-strapi-images
   ```

3. Link uploaded images to Strapi Office Venue content:

   This runs automatically after `make upload-strapi-images`.

   You can also run it manually for images that are already uploaded:

   ```bash
   make link-strapi-office-venue-images
   ```

## Directories

| Path | Purpose |
| --- | --- |
| `raw-images/` | Source images before watermark removal. |
| `clean-images/` | Cleaned images produced by `make remove`. |
| `logs/strapi-upload-reports/` | Upload and content-link reports. |
| `rules/strapi-office-venue-existing-filenames.txt` | Filenames already uploaded or found in Strapi, skipped by later watermark-removal runs. |

## Strapi Upload

Default target:

```text
STRAPI_BASE_URL=https://cms.rumah123.com
STRAPI_ROOT_FOLDER_PATH=Media Library/Office Venue
STRAPI_IMAGE_DIR=clean-images
```

Production Strapi requires confirmation. In an interactive shell, the script asks you to type `production`. For non-interactive runs:

```bash
make upload-strapi-images STRAPI_EXTRA_ARGS=--confirm-production
```

Upload behavior:

- Uploads cleaned files from `clean-images/`.
- Creates missing Media Library office folders.
- Skips files already present in the target Strapi folder.
- Writes Markdown and CSV reports to `logs/strapi-upload-reports/`.
- Adds `uploaded` and `skipped_existing` filenames to `rules/strapi-office-venue-existing-filenames.txt`.
- Automatically runs `make link-strapi-office-venue-images` after upload succeeds.

## Content Linking

The link step reads the latest CSV report from:

```text
logs/strapi-upload-reports/
```

It groups report rows by `office_name`, matches each group to Office Venue content by:

```text
Office Venue slug = report office_name
```

Then it links each Strapi media asset to the Office Venue `image` component field.

The script checks existing links by media ID using:

```text
image[] -> imageUrl[] -> id
```

If the media ID is already present, it does not update the content entry.

## Link One Venue

To link only one slug from the latest report:

```bash
make link-strapi-office-venue-images STRAPI_OFFICE=graha-cimb-niaga
```

For production non-interactive runs:

```bash
make link-strapi-office-venue-images \
  STRAPI_OFFICE=graha-cimb-niaga \
  STRAPI_EXTRA_ARGS=--confirm-production
```

## Image subType Mapping

New Office Venue image components use `subType` based on the image source category:

| Source category | Strapi `subType` |
| --- | --- |
| `interior` | `Foto Lainnya` |
| `exterior` | `Fasad Gedung` |
| `floorplan` | `Denah Ruang` |

Future upload reports include `relative_path` and `local_category` to make this mapping explicit.

## Useful Commands

Preview upload:

```bash
make upload-strapi-images-dry-run
```

Retry failed watermark removals:

```bash
make retry-failed CONCURRENCY=4
```

Continue in-progress watermark removals:

```bash
make continue-progress CONCURRENCY=4
```

Show status:

```bash
make status
```
