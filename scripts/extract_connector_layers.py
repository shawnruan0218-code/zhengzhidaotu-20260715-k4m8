#!/usr/bin/env python3
"""Extract transparent branch-line layers from the mind-map page images."""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def extract_connector_layer(source_path: Path, destination_path: Path) -> None:
    source = np.asarray(Image.open(source_path).convert("RGB"))
    maximum = source.max(axis=2).astype(np.int16)
    minimum = source.min(axis=2).astype(np.int16)
    colored = ((maximum - minimum) >= 12) & (minimum <= 246)
    colored_bytes = colored.astype(np.uint8) * 255

    # Mind-map branches are long horizontal/vertical colored strokes. Opening
    # the color mask in both directions removes ordinary printed glyphs while
    # retaining the original line colour and anti-aliasing around each branch.
    horizontal = cv2.morphologyEx(
        colored_bytes,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (17, 1)),
    )
    vertical = cv2.morphologyEx(
        colored_bytes,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (1, 17)),
    )
    line_core = cv2.bitwise_or(horizontal, vertical)
    nearby = cv2.dilate(
        line_core,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)),
    ) > 0
    mask = colored & nearby

    rgba = np.zeros((*source.shape[:2], 4), dtype=np.uint8)
    rgba[:, :, :3] = np.where(mask[:, :, None], source, 0)
    rgba[:, :, 3] = np.where(mask, 255, 0).astype(np.uint8)
    image = Image.fromarray(rgba, "RGBA").quantize(
        colors=32,
        method=Image.Quantize.FASTOCTREE,
        dither=Image.Dither.NONE,
    )
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination_path, optimize=True, compress_level=9)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("sources", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, default=Path("public/connectors"))
    args = parser.parse_args()

    sources = [path for path in args.sources if "@2x" not in path.stem]
    for index, source in enumerate(sources, start=1):
        destination = args.output / source.name
        extract_connector_layer(source, destination)
        print(f"[{index}/{len(sources)}] {destination}")


if __name__ == "__main__":
    main()
