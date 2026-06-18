from __future__ import annotations

from dataclasses import dataclass
import base64
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


@dataclass(frozen=True)
class RemovalOptions:
    radius: float = 3.0
    method: str = "telea"
    feather: int = 3
    expand: int = 2


DEFAULT_AI_PROMPT = (
    "Remove only the visible semi-transparent watermark/logo from this image. "
    "Preserve the original photo composition, building facade line pattern, "
    "streetlight, sky, colors, contrast, perspective, and dimensions. "
    "Do not crop, zoom, add objects, add text, or stylize the image. "
    "Reconstruct the covered pixels naturally so the image looks unchanged except "
    "that the watermark is gone."
)


def remove_with_mask(
    image_path: Path,
    mask_path: Path,
    output_path: Path,
    options: RemovalOptions | None = None,
) -> None:
    options = options or RemovalOptions()
    image = _read_rgb_image(image_path)
    mask = _read_mask(mask_path, image.shape[:2])
    prepared_mask = _prepare_mask(mask, options.expand, options.feather)
    inpaint_method = _inpaint_method(options.method)

    result = cv2.inpaint(image, prepared_mask, options.radius, inpaint_method)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(result).save(output_path)


def remove_with_ai(
    image_path: Path,
    output_path: Path,
    *,
    model: str = "gpt-image-2",
    prompt: str = DEFAULT_AI_PROMPT,
) -> None:
    if not os.getenv("OPENAI_API_KEY"):
        raise ValueError("OPENAI_API_KEY is required for AI watermark removal.")

    try:
        from openai import OpenAI
    except ImportError as error:
        raise ValueError(
            "The openai package is required for AI watermark removal. Run `make install`."
        ) from error

    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    with Image.open(image_path) as source_image:
        source_size = source_image.size

    client = OpenAI()
    with image_path.open("rb") as image_file:
        response = client.images.edit(
            model=model,
            image=image_file,
            prompt=prompt,
            quality="high",
            size="auto",
            output_format="png",
        )

    image_data = response.data[0].b64_json
    if not image_data:
        raise ValueError("AI image edit returned no image data.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    decoded = base64.b64decode(image_data)
    temporary_path = output_path.with_suffix(".tmp.png")
    temporary_path.write_bytes(decoded)

    with Image.open(temporary_path) as edited:
        edited = edited.convert("RGB")
        if edited.size != source_size:
            edited = edited.resize(source_size, Image.Resampling.LANCZOS)
        edited.save(output_path)

    temporary_path.unlink(missing_ok=True)


def make_rectangle_mask(
    image_path: Path,
    output_path: Path,
    rectangles: list[tuple[int, int, int, int]],
) -> None:
    image = _read_rgb_image(image_path)
    height, width = image.shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)

    for x, y, rect_width, rect_height in rectangles:
        if rect_width <= 0 or rect_height <= 0:
            raise ValueError("Rectangle width and height must be positive.")

        left = max(0, x)
        top = max(0, y)
        right = min(width, x + rect_width)
        bottom = min(height, y + rect_height)
        if left >= right or top >= bottom:
            raise ValueError(f"Rectangle is outside image bounds: {x},{y},{rect_width},{rect_height}")

        mask[top:bottom, left:right] = 255

    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(mask, mode="L").save(output_path)


def _read_rgb_image(path: Path) -> np.ndarray:
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {path}")

    with Image.open(path) as image:
        return np.array(image.convert("RGB"))


def _read_mask(path: Path, image_shape: tuple[int, int]) -> np.ndarray:
    if not path.exists():
        raise FileNotFoundError(f"Mask not found: {path}")

    with Image.open(path) as mask_image:
        mask = np.array(mask_image.convert("L"))

    if mask.shape != image_shape:
        raise ValueError(
            f"Mask size {mask.shape[::-1]} must match image size {image_shape[::-1]}."
        )

    return np.where(mask > 0, 255, 0).astype(np.uint8)


def _prepare_mask(mask: np.ndarray, expand: int, feather: int) -> np.ndarray:
    if expand < 0:
        raise ValueError("Mask expansion must be zero or positive.")
    if feather < 0:
        raise ValueError("Mask feather must be zero or positive.")

    prepared = mask
    if expand:
        kernel_size = expand * 2 + 1
        kernel = np.ones((kernel_size, kernel_size), np.uint8)
        prepared = cv2.dilate(prepared, kernel, iterations=1)

    if feather:
        kernel_size = feather * 2 + 1
        prepared = cv2.GaussianBlur(prepared, (kernel_size, kernel_size), 0)
        prepared = np.where(prepared > 8, 255, 0).astype(np.uint8)

    return prepared


def _inpaint_method(method: str) -> int:
    normalized = method.lower()
    if normalized == "telea":
        return cv2.INPAINT_TELEA
    if normalized == "ns":
        return cv2.INPAINT_NS
    raise ValueError("Method must be either 'telea' or 'ns'.")
