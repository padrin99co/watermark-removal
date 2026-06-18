from pathlib import Path

import numpy as np
from PIL import Image

from watermark_remover.core import RemovalOptions, make_rectangle_mask, remove_with_mask


def test_make_rectangle_mask(tmp_path: Path) -> None:
    image_path = tmp_path / "input.png"
    mask_path = tmp_path / "mask.png"
    Image.new("RGB", (10, 8), "white").save(image_path)

    make_rectangle_mask(image_path, mask_path, [(2, 3, 4, 2)])

    mask = np.array(Image.open(mask_path))
    assert mask.shape == (8, 10)
    assert mask[3:5, 2:6].min() == 255
    assert mask[:3].max() == 0


def test_remove_with_mask_writes_output(tmp_path: Path) -> None:
    image_path = tmp_path / "input.png"
    mask_path = tmp_path / "mask.png"
    output_path = tmp_path / "output.png"

    image = np.full((20, 20, 3), 255, dtype=np.uint8)
    image[8:12, 8:12] = 0
    mask = np.zeros((20, 20), dtype=np.uint8)
    mask[8:12, 8:12] = 255

    Image.fromarray(image).save(image_path)
    Image.fromarray(mask).save(mask_path)

    remove_with_mask(
        image_path,
        mask_path,
        output_path,
        RemovalOptions(radius=3, expand=1, feather=0),
    )

    assert output_path.exists()
    result = np.array(Image.open(output_path))
    assert result.shape == image.shape
