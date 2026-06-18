from __future__ import annotations

import argparse
from pathlib import Path

from watermark_remover.core import (
    DEFAULT_AI_PROMPT,
    RemovalOptions,
    make_rectangle_mask,
    remove_with_ai,
    remove_with_mask,
)


AUTHORIZED_USE_NOTICE = (
    "Use this tool only on images you own, created, or are explicitly authorized to edit."
)


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if not args.i_understand:
        parser.error(f"{AUTHORIZED_USE_NOTICE} Pass --i-understand to continue.")

    try:
        if args.command == "mask-rect":
            make_rectangle_mask(args.image, args.output, [_parse_rect(rect) for rect in args.rect])
            return

        if args.command == "remove-ai":
            remove_with_ai(args.image, args.output, model=args.model, prompt=args.prompt)
            return

        options = RemovalOptions(
            radius=args.radius,
            method=args.method,
            feather=args.feather,
            expand=args.expand,
        )
        remove_with_mask(args.image, args.mask, args.output, options)
    except (FileNotFoundError, ValueError) as error:
        parser.exit(2, f"error: {error}\n")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="watermark-remover",
        description="Authorized-use mask-based watermark/object removal for local images.",
    )
    parser.add_argument(
        "--i-understand",
        action="store_true",
        help=AUTHORIZED_USE_NOTICE,
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    mask_parser = subparsers.add_parser("mask-rect", help="Create a mask from one or more rectangles.")
    mask_parser.add_argument("image", type=Path, help="Source image path.")
    mask_parser.add_argument("output", type=Path, help="Output mask path.")
    mask_parser.add_argument(
        "--rect",
        action="append",
        required=True,
        metavar="X,Y,WIDTH,HEIGHT",
        help="Rectangle to mask. Can be passed multiple times.",
    )

    remove_parser = subparsers.add_parser("remove", help="Remove masked image regions with inpainting.")
    remove_parser.add_argument("image", type=Path, help="Source image path.")
    remove_parser.add_argument("mask", type=Path, help="Black/white mask path. White pixels are removed.")
    remove_parser.add_argument("output", type=Path, help="Output image path.")
    remove_parser.add_argument("--radius", type=float, default=3.0, help="Inpainting radius. Default: 3.0.")
    remove_parser.add_argument(
        "--method",
        choices=("telea", "ns"),
        default="telea",
        help="OpenCV inpainting algorithm. Default: telea.",
    )
    remove_parser.add_argument("--expand", type=int, default=2, help="Pixels to dilate mask. Default: 2.")
    remove_parser.add_argument("--feather", type=int, default=3, help="Mask blur threshold size. Default: 3.")

    ai_parser = subparsers.add_parser("remove-ai", help="Remove watermark with OpenAI image editing.")
    ai_parser.add_argument("image", type=Path, help="Source image path.")
    ai_parser.add_argument("output", type=Path, help="Output PNG path.")
    ai_parser.add_argument(
        "--model",
        default="gpt-image-2",
        help="OpenAI image model. Default: gpt-image-2.",
    )
    ai_parser.add_argument(
        "--prompt",
        default=DEFAULT_AI_PROMPT,
        help="Image edit prompt.",
    )

    return parser


def _parse_rect(value: str) -> tuple[int, int, int, int]:
    parts = value.split(",")
    if len(parts) != 4:
        raise ValueError(f"Rectangle must be X,Y,WIDTH,HEIGHT: {value}")

    try:
        return tuple(int(part) for part in parts)
    except ValueError as error:
        raise ValueError(f"Rectangle values must be integers: {value}") from error


if __name__ == "__main__":
    main()
