#!/usr/bin/env python3
"""Detect the pink dashed summary/callout boxes in the extracted map pages."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image


def row_segments(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Return consolidated horizontal dashed-line candidates."""
    candidates: list[tuple[int, int, int, int]] = []
    for y in range(mask.shape[0]):
        xs = np.flatnonzero(mask[y])
        if xs.size < 18:
            continue
        breaks = np.flatnonzero(np.diff(xs) > 26) + 1
        for group in np.split(xs, breaks):
            if group.size < 18:
                continue
            left, right = int(group[0]), int(group[-1])
            span = right - left + 1
            if span >= 140 and group.size / span >= 0.11:
                candidates.append((y, left, right, int(group.size)))

    # The printed border is several pixels thick. Keep its strongest row.
    consolidated: list[tuple[int, int, int, int]] = []
    for candidate in candidates:
        y, left, right, ink = candidate
        match = next(
            (
                index
                for index, existing in enumerate(consolidated)
                if abs(existing[0] - y) <= 6
                and min(existing[2], right) - max(existing[1], left)
                >= min(existing[2] - existing[1], right - left) * 0.75
            ),
            None,
        )
        if match is None:
            consolidated.append(candidate)
        elif ink > consolidated[match][3]:
            consolidated[match] = candidate
    return consolidated


def detect(image_path: Path) -> list[dict[str, float | str]]:
    image = np.asarray(Image.open(image_path).convert("RGB"))
    red = image[:, :, 0].astype(np.int16)
    green = image[:, :, 1].astype(np.int16)
    blue = image[:, :, 2].astype(np.int16)
    # Pink border ink; this excludes teal branches and blue year labels.
    mask = (red >= 170) & (red - green >= 38) & (red - blue >= 12)
    segments = row_segments(mask)
    pairs: list[tuple[int, int, int, int, float]] = []

    for top_index, top in enumerate(segments):
        top_y, top_left, top_right, _ = top
        top_width = top_right - top_left
        if top_width < 140:
            continue
        for bottom in segments[top_index + 1 :]:
            bottom_y, bottom_left, bottom_right, _ = bottom
            height = bottom_y - top_y
            if height < 35 or height > 620:
                continue
            overlap = min(top_right, bottom_right) - max(top_left, bottom_left)
            bottom_width = bottom_right - bottom_left
            if overlap < min(top_width, bottom_width) * 0.82:
                continue
            if abs(top_width - bottom_width) > max(top_width, bottom_width) * 0.18:
                continue

            left = round((top_left + bottom_left) / 2)
            right = round((top_right + bottom_right) / 2)
            y_slice = slice(max(0, top_y - 2), min(mask.shape[0], bottom_y + 3))
            def strongest_vertical(center: int) -> float:
                start = max(0, center - 34)
                stop = min(mask.shape[1], center + 35)
                return max(
                    mask[y_slice, max(0, x - 5) : min(mask.shape[1], x + 6)].mean()
                    for x in range(start, stop, 3)
                )

            vertical_density = min(strongest_vertical(left), strongest_vertical(right))
            if vertical_density < 0.018:
                continue
            pairs.append((top_y, bottom_y, left, right, float(vertical_density)))

    # Prefer the tightest/highest-confidence rectangle when several border rows pair.
    selected: list[tuple[int, int, int, int, float]] = []
    for pair in sorted(pairs, key=lambda item: (-item[4], item[1] - item[0])):
        top, bottom, left, right, _ = pair
        duplicate = any(
            abs(top - old_top) <= 12
            and abs(bottom - old_bottom) <= 12
            and abs(left - old_left) <= 20
            and abs(right - old_right) <= 20
            for old_top, old_bottom, old_left, old_right, _ in selected
        )
        if not duplicate:
            selected.append(pair)

    height, width = mask.shape
    selected.sort()
    return [
        {
            "id": f"{image_path.stem}-summary-{index + 1}",
            "x": max(0, (left - 5) / width),
            "y": max(0, (top - 5) / height),
            "width": min(width, right + 6) / width - max(0, (left - 5) / width),
            "height": min(height, bottom + 6) / height - max(0, (top - 5) / height),
        }
        for index, (top, bottom, left, right, _) in enumerate(selected)
    ]


# Vision occasionally adds a brace/bullet/Latin character immediately before
# the printed heading. Accept that small OCR artefact and numbered summaries.
HEADING = re.compile(
    r"^[^\u4e00-\u9fff]{0,3}(?:总结\d*|易错点|易错提醒|注意|特别提醒|补充)[：:]?"
)


def retain_labeled_boxes(
    regions: list[dict[str, float | str]], ocr_path: Path
) -> list[dict[str, float | str]]:
    if not ocr_path.exists():
        return []
    page = json.loads(ocr_path.read_text())
    headings = [line for line in page["lines"] if HEADING.search(line["text"].strip())]
    labeled: list[tuple[dict[str, float | str], set[int]]] = []
    for region in regions:
        x = float(region["x"])
        y = float(region["y"])
        width = float(region["width"])
        height = float(region["height"])
        top_band = min(height * 0.42, 0.042)
        matched = {
            index
            for index, line in enumerate(headings)
            if x - 0.045 <= line["x"] + line["width"] / 2 <= x + width + 0.045
            and y <= line["y"] + line["height"] / 2 <= y + top_band
        }
        if matched:
            expanded = dict(region)
            heading_left = min(headings[index]["x"] for index in matched) - 0.006
            heading_right = max(
                headings[index]["x"] + headings[index]["width"] for index in matched
            ) + 0.006
            new_left = max(0.0, min(x, heading_left))
            new_right = min(1.0, max(x + width, heading_right))
            expanded["x"] = new_left
            expanded["width"] = new_right - new_left
            labeled.append((expanded, matched))

    # A top edge can accidentally pair with a later box's bottom edge. Both
    # rectangles contain the same heading, so keep the tighter one.
    retained: list[tuple[dict[str, float | str], set[int]]] = []
    for region, matched in sorted(
        labeled, key=lambda item: float(item[0]["width"]) * float(item[0]["height"])
    ):
        if any(matched & old_matched for _, old_matched in retained):
            continue
        retained.append((region, matched))
    return sorted((region for region, _ in retained), key=lambda item: float(item["y"]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, default=Path("app/summary-regions.json"))
    parser.add_argument("--ocr-directory", type=Path, default=Path("public/data/ocr"))
    args = parser.parse_args()

    result: dict[str, list[dict[str, float | str]]] = {}
    for index, image_path in enumerate(args.images, start=1):
        regions = retain_labeled_boxes(
            detect(image_path), args.ocr_directory / f"{image_path.stem}.json"
        )
        page_number = int(image_path.stem.rsplit("-", 1)[1]) - 5
        if regions:
            result[str(page_number)] = regions
        print(f"[{index}/{len(args.images)}] {image_path.name}: {len(regions)} box(es)")
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
