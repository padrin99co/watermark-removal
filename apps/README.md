# Watermark Remover

Local, mask-based image inpainting CLI for removing unwanted marks or objects from images you own, created, or are explicitly authorized to edit.

This project does not determine rights or permissions for you. Do not use it to remove attribution, ownership marks, licensing marks, or provenance indicators from third-party images without permission.

## Install

```bash
cd apps
python -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## Repository layout

```text
raw-images/      original images
apps/            watermark removal tools
clean-images/    processed images after removal
```

## Usage

From the repository root, the shortest workflow is:

```bash
make install
make remove
make open
```

`make remove` uses the local Codex CLI with `CODEX_MODEL` and Codex image editing. It writes the cleaned image with the same filename and extension as the raw image:

```text
raw-images/example.jpeg
clean-images/example.jpeg
```

If the cleaned output already exists and matches the source dimensions, `make remove` skips the image instead of retrying.

Processing status is written to:

```text
logs/status.tsv
```

View the summary with:

```bash
make status
```

During removal, the terminal shows progress like:

```text
example.jpeg                       [##########--------------]  45% editing watermark
```

## Batch Processing

Process every image in `raw-images/`:

```bash
make batch
```

Run in parallel:

```bash
make batch CONCURRENCY=2
```

For 10K images, start with `CONCURRENCY=2` and increase carefully only if your machine, Codex account, and network remain stable. Reruns skip images that already have valid output in `clean-images/`.

Preview the batch list without processing:

```bash
make batch DRY_RUN=1
```

If you prefer direct OpenAI API usage instead of Codex CLI, configure `.env`:

```bash
cp .env.example .env
# edit .env and set OPENAI_API_KEY
make remove-api
```

Create a rectangular mask:

```bash
watermark-remover --i-understand mask-rect \
  ../raw-images/input.jpg \
  ../clean-images/input-mask.png \
  --rect 20,30,180,60
```

Remove the masked region:

```bash
watermark-remover --i-understand remove \
  ../raw-images/input.jpg \
  ../clean-images/input-mask.png \
  ../clean-images/input-clean.jpg
```

White pixels in the mask are inpainted. Black pixels are preserved.

High-quality AI removal:

```bash
watermark-remover --i-understand remove-ai \
  ../raw-images/input.jpg \
  ../clean-images/input-clean-ai.png
```

## Options

```bash
watermark-remover --i-understand remove ../raw-images/input.jpg ../clean-images/input-mask.png ../clean-images/input-clean.jpg \
  --method telea \
  --radius 3 \
  --expand 2 \
  --feather 3
```

- `--method`: `telea` is fast and usually works well; `ns` can work better on some textures.
- `--radius`: larger values blend from a wider neighborhood.
- `--expand`: grows the mask so edges are fully covered.
- `--feather`: smooths mask edges before thresholding.

## Notes

Results depend heavily on the mask and image texture. Simple backgrounds usually work well; complex text, faces, and repeated patterns may require manual retouching after inpainting.
