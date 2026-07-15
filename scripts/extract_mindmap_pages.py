#!/usr/bin/env python3
"""Extract the study pages from the source PDF and prepare web images.

The first five PDF pages are cover/front matter. Website page 1 therefore maps
to PDF page 6, preserving the numbering and saved highlights from the test
version of the reader.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from pypdf import PdfReader
import pypdf.filters as pdf_filters


DEFAULT_WIDTH = 2824
SHARP_WIDTH = DEFAULT_WIDTH * 2


def clean_faint_watermark(image: Image.Image) -> Image.Image:
    """Whiten only very light neutral pixels, preserving coloured map content."""

    rgb = image.convert("RGB")
    pixels = np.asarray(rgb).copy()
    minimum = pixels.min(axis=2)
    # The source watermark is very pale but multi-coloured, so a grey-only
    # filter leaves parts of it behind. Its pixels are lighter than the map's
    # real ink and background fills; normalise that near-white band instead.
    watermark = (minimum >= 185) & (minimum < 255)
    pixels[watermark] = 255
    return Image.fromarray(pixels, mode="RGB")


def normalize_image(image: Image.Image, width: int, sharpen: bool = False) -> Image.Image:
    if image.mode == "RGBA":
        background = Image.new("RGB", image.size, "white")
        background.paste(image, mask=image.getchannel("A"))
        image = background
    else:
        image = image.convert("RGB")

    height = round(image.height * width / image.width)
    if image.size != (width, height):
        image = image.resize((width, height), Image.Resampling.LANCZOS)
    image = clean_faint_watermark(image)
    if sharpen:
        image = image.filter(ImageFilter.UnsharpMask(radius=1.1, percent=105, threshold=3))
    return image


def save_webp(image: Image.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="WEBP", quality=92, method=6)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output", type=Path, default=Path("public/pages"))
    parser.add_argument("--manifest", type=Path, default=Path("app/page-manifest.json"))
    parser.add_argument("--first", type=int, default=6)
    parser.add_argument("--last", type=int)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    # The final source page contains a much larger image than the default pypdf
    # safety limit. Processing is sequential and bounded to one page in memory.
    pdf_filters.ZLIB_MAX_OUTPUT_LENGTH = 0
    pdf_filters.MAX_DECLARED_STREAM_LENGTH = 1_000_000_000
    pdf_filters.MAX_ARRAY_BASED_STREAM_OUTPUT_LENGTH = 1_000_000_000

    reader = PdfReader(str(args.pdf))
    last_page = min(args.last or len(reader.pages), len(reader.pages))
    if args.first < 1 or args.first > last_page:
        raise SystemExit("Invalid page range")

    args.output.mkdir(parents=True, exist_ok=True)
    total = last_page - args.first + 1

    for sequence, source_page in enumerate(range(args.first, last_page + 1), start=1):
        base_path = args.output / f"mindmap-{source_page:03d}.webp"
        sharp_path = args.output / f"mindmap-{source_page:03d}@2x.webp"
        needs_base = args.force or not base_path.exists()
        needs_sharp = args.force or not sharp_path.exists()

        if not needs_base and not needs_sharp:
            print(f"[{sequence}/{total}] PDF {source_page}: already prepared", flush=True)
            continue

        page_images = list(reader.pages[source_page - 1].images)
        if len(page_images) != 1:
            raise RuntimeError(f"PDF page {source_page} has {len(page_images)} images")
        source = page_images[0].image

        if needs_base:
            save_webp(normalize_image(source, DEFAULT_WIDTH), base_path)
        if needs_sharp:
            save_webp(normalize_image(source, SHARP_WIDTH, sharpen=True), sharp_path)

        print(f"[{sequence}/{total}] PDF {source_page}: prepared", flush=True)

    manifest = []
    for website_page, source_page in enumerate(range(args.first, last_page + 1), start=1):
        base_path = args.output / f"mindmap-{source_page:03d}.webp"
        sharp_path = args.output / f"mindmap-{source_page:03d}@2x.webp"
        if not base_path.exists() or not sharp_path.exists():
            raise RuntimeError(f"Missing generated image for PDF page {source_page}")
        with Image.open(base_path) as image:
            width, height = image.size
        manifest.append(
            {
                "number": website_page,
                "sourcePage": source_page,
                "src": f"/pages/{base_path.name}",
                "sharpSrc": f"/pages/{sharp_path.name}",
                "width": width,
                "height": height,
            }
        )

    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote {len(manifest)} pages to {args.manifest}", flush=True)


if __name__ == "__main__":
    main()
