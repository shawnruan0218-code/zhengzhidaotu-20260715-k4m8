#!/usr/bin/env python3
"""Build the three-level navigation outline from the OCR map pages."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


CHINESE_NUMERALS = "一二三四五六七八九十"
SECOND_LEVEL = re.compile(rf"^[（(][{CHINESE_NUMERALS}]+[）)]")
POINT_LEVEL = re.compile(r"^[^\u4e00-\u9fff]{0,3}考点\s*\d*\s*[：:]")


@dataclass(frozen=True)
class RootSpec:
    title: str
    first_source_page: int
    last_source_page: int
    anchor_y: float = 0.48


# The first level is printed vertically and is therefore not reliably preserved
# by the horizontal OCR layer. Keep its wording here, while the second and third
# levels are read directly from every page's OCR JSON.
ROOT_SPECS = [
    RootSpec("导论", 6, 6),
    RootSpec("一 唯物论", 7, 9),
    RootSpec("二 唯物辩证法", 10, 13),
    RootSpec("三 认识论", 14, 18),
    RootSpec("四 唯物史观", 19, 24),
    RootSpec("一 商品经济理论", 25, 26),
    RootSpec("二 剩余价值理论", 27, 30),
    RootSpec("三 资本理论", 31, 33),
    RootSpec("四 垄断理论", 34, 37),
    RootSpec("五 社会主义的发展及其规律", 38, 39),
    RootSpec("六 共产主义崇高理想及其最终实现", 40, 40),
    RootSpec("导论 马克思主义中国化时代化的历史进程与理论成果", 41, 41),
    RootSpec("一 毛泽东思想及其历史地位", 42, 43),
    RootSpec("二 新民主义革命理论", 44, 47),
    RootSpec("三 社会主义改造理论", 48, 49),
    RootSpec("四 社会主义建设道路初步探索的理论成果", 50, 50),
    RootSpec("五 中国特色社会主义理论体系的形成发展", 51, 52),
    RootSpec("六 邓小平理论", 53, 55),
    RootSpec("七 “三个代表”重要思想", 56, 56),
    RootSpec("八 科学发展观", 57, 57),
    RootSpec("导论 习近平新时代中国特色社会主义思想", 58, 59),
    RootSpec("一 新时代坚持和发展中国特色社会主义", 60, 61),
    RootSpec("二 以中国式现代化全面推进中华民族伟大复兴", 62, 63),
    RootSpec("三 坚持党的全面领导", 64, 64),
    RootSpec("四 坚持以人民为中心", 65, 66),
    RootSpec("五 全面深化改革开放", 67, 68),
    RootSpec("六 推动高质量发展", 69, 71),
    RootSpec("七 社会主义现代化建设的教育、科技、人才战略", 72, 73),
    RootSpec("八 发展全过程人民民主", 74, 77),
    RootSpec("九 全面依法治国", 78, 78),
    RootSpec("十 建设社会主义文化强国", 79, 80),
    RootSpec("十一 以保障和改善民生为重点加强社会建设", 81, 82),
    RootSpec("十二 建设社会主义生态文明", 83, 84),
    RootSpec("十三 维护和塑造国家安全", 85, 85),
    RootSpec("十四 建设巩固国防和强大人民军队", 86, 86),
    RootSpec("十五 坚持“一国两制”和推进祖国完全统一", 87, 88),
    RootSpec("十六 中国特色大国外交和推动构建人类命运共同体", 89, 90),
    RootSpec("十七 全面从严治党", 91, 92),
    RootSpec("中国近现代史纲要总框架", 93, 96),
    RootSpec("一 进入近代后中华民族的磨难与抗争", 97, 98),
    RootSpec("二 不同社会力量对国家出路的早期探索", 99, 101),
    RootSpec("三 辛亥革命与君主专制制度的终结", 102, 104),
    RootSpec("一 中国共产党成立和中国革命新局面", 105, 108, 0.28),
    RootSpec("二 中国革命的新道路", 108, 110, 0.7),
    RootSpec("三 中华民族的抗日战争", 111, 114),
    RootSpec("四 为建立新中国而奋斗", 115, 117),
    RootSpec("五 重要总结", 118, 119),
    RootSpec("一 中华人民共和国的成立与中国社会主义建设道路的探索", 120, 121),
    RootSpec("二 改革开放与中国特色社会主义的开创和发展", 122, 122),
    RootSpec("思想道德与法治总框架", 123, 123),
    RootSpec("绪论 担当复兴大任 成就时代新人", 124, 124),
    RootSpec("一 领悟人生真谛 把握人生方向", 125, 125),
    RootSpec("二 追求远大理想 坚定崇高信念", 126, 126),
    RootSpec("三 继承优良传统 弘扬中国精神", 127, 128),
    RootSpec("四 明确价值要求 践行价值准则", 129, 129),
    RootSpec("五 遵守道德规范 锤炼道德品格", 130, 132),
    RootSpec("六 学习法治思想 提升法治素养", 133, 137),
]


@dataclass
class VerticalTitle:
    x: int
    top: int
    bottom: int
    bands: list[tuple[int, int]]


def split_groups(values: np.ndarray, maximum_gap: int) -> list[np.ndarray]:
    if not values.size:
        return []
    return list(np.split(values, np.flatnonzero(np.diff(values) > maximum_gap) + 1))


def find_vertical_title(image: Image.Image) -> VerticalTitle | None:
    array = np.asarray(image.convert("RGB"))
    height, width = array.shape[:2]
    black = array[:, : int(width * 0.18)].max(axis=2) < 125
    black[: int(height * 0.08)] = False
    black[int(height * 0.94) :] = False
    column_counts = black.sum(axis=0)
    column_groups = split_groups(np.flatnonzero(column_counts > 10), 2)
    candidates: list[tuple[float, VerticalTitle]] = []

    for columns in column_groups:
        if not columns.size:
            continue
        left, right = int(columns[0]), int(columns[-1])
        column_width = right - left + 1
        if column_width < 7 or column_width > 58 or right > width * 0.15:
            continue
        row_counts = black[:, max(0, left - 4) : right + 5].sum(axis=1)
        row_groups = [
            group
            for group in split_groups(np.flatnonzero(row_counts > 2), 3)
            if group.size >= 4
        ]
        if len(row_groups) < 2:
            continue

        sequences: list[list[np.ndarray]] = []
        current: list[np.ndarray] = []
        for group in row_groups:
            if current and int(group[0]) - int(current[-1][-1]) > 72:
                sequences.append(current)
                current = []
            current.append(group)
        if current:
            sequences.append(current)

        for sequence in sequences:
            if len(sequence) < 2:
                continue
            top, bottom = int(sequence[0][0]), int(sequence[-1][-1])
            span = bottom - top + 1
            if span < 42:
                continue
            band_heights = [int(group[-1] - group[0] + 1) for group in sequence]
            if np.median(band_heights) < 8:
                continue
            title = VerticalTitle(
                x=round((left + right) / 2),
                top=top,
                bottom=bottom,
                bands=[(int(group[0]), int(group[-1])) for group in sequence],
            )
            # True outline titles form a long, regular stack near the left edge.
            score = len(sequence) * 120 + span - left * 0.18
            candidates.append((score, title))

    # The first outline level is the left-most vertical box. Nearby second-level
    # boxes can contain more characters, so length alone would select the wrong
    # node on dense pages.
    return min(candidates, key=lambda item: (item[1].x, -item[0]))[1] if candidates else None


def title_montage(image: Image.Image, title: VerticalTitle) -> Image.Image:
    array = np.asarray(image.convert("RGB"))
    height, width = array.shape[:2]
    half_width = max(20, int(width * 0.013))
    glyphs: list[Image.Image] = []
    for top, bottom in title.bands:
        padding = 5
        left = max(0, title.x - half_width)
        right = min(width, title.x + half_width)
        source = array[max(0, top - padding) : min(height, bottom + padding + 1), left:right]
        spread = source.max(axis=2).astype(np.int16) - source.min(axis=2).astype(np.int16)
        minimum = source.min(axis=2)
        neutral_ink = (spread < 30) & (minimum < 215)
        cleaned = np.full_like(source, 255)
        cleaned[neutral_ink] = np.repeat(minimum[neutral_ink, None], 3, axis=1)
        ink_y, ink_x = np.nonzero(neutral_ink)
        if ink_x.size:
            crop_padding = 4
            cleaned = cleaned[
                max(0, int(ink_y.min()) - crop_padding) : min(cleaned.shape[0], int(ink_y.max()) + crop_padding + 1),
                max(0, int(ink_x.min()) - crop_padding) : min(cleaned.shape[1], int(ink_x.max()) + crop_padding + 1),
            ]
        crop = Image.fromarray(cleaned)
        target_height = 72
        target_width = max(30, round(crop.width * target_height / crop.height))
        glyphs.append(crop.resize((target_width, target_height), Image.Resampling.LANCZOS))

    gap = 3
    canvas = Image.new("RGB", (sum(glyph.width for glyph in glyphs) + gap * (len(glyphs) + 1), 88), "white")
    cursor = gap
    for glyph in glyphs:
        canvas.paste(glyph, (cursor, (canvas.height - glyph.height) // 2))
        cursor += glyph.width + gap
    return canvas


def prepare_title_images(pages: list[Path], output: Path, manifest_path: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict[str, float | str]] = {}
    for index, page_path in enumerate(pages, start=1):
        image = Image.open(page_path)
        title = find_vertical_title(image)
        if title:
            destination = output / f"outline-{page_path.stem}.png"
            title_montage(image, title).save(destination)
            source_page = int(page_path.stem.rsplit("-", 1)[1])
            manifest[str(source_page - 5)] = {
                "image": destination.name,
                "x": title.x / image.width,
                "y": title.top / image.height,
            }
        print(f"[{index}/{len(pages)}] {page_path.name}: {'prepared' if title else 'missing'}")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


def compact_text(value: str) -> str:
    text = re.sub(r"\s+", "", value).replace("(", "（").replace(")", "）")
    return text.replace("形咸和发展", "形成和发展")


def heading_text(lines: list[dict], index: int, pattern: re.Pattern[str]) -> str:
    base = lines[index]
    pieces = [compact_text(base.get("text", ""))]
    last_bottom = float(base["y"]) + float(base["height"])
    base_x = float(base["x"])

    for candidate in sorted(lines[index + 1 :], key=lambda line: (line["y"], line["x"])):
        candidate_text = compact_text(candidate.get("text", ""))
        if not candidate_text:
            continue
        if not re.search(r"[0-9A-Za-z\u4e00-\u9fff]", candidate_text):
            continue
        candidate_y = float(candidate["y"])
        if candidate_y > last_bottom + 0.031:
            break
        if pattern.match(candidate_text) or SECOND_LEVEL.match(candidate_text) or POINT_LEVEL.match(candidate_text):
            continue
        if candidate_y + float(candidate["height"]) < float(base["y"]):
            continue
        if abs(float(candidate["x"]) - base_x) > 0.032:
            continue
        if len(candidate_text) > 22 or float(candidate.get("width", 0)) > 0.2:
            continue
        pieces.append(candidate_text)
        last_bottom = max(last_bottom, candidate_y + float(candidate["height"]))
        if len(pieces) == 4:
            break
    return compact_text("".join(pieces))


def roots_for_position(source_page: int, y: float) -> list[int]:
    candidates = [
        index
        for index, root in enumerate(ROOT_SPECS)
        if root.first_source_page <= source_page <= root.last_source_page
    ]
    if source_page == 108 and len(candidates) == 2:
        return [candidates[1] if y >= 0.56 else candidates[0]]
    return candidates[:1]


def make_node_id(prefix: str, *values: object) -> str:
    suffix = "-".join(re.sub(r"[^0-9a-z]+", "-", str(value).lower()).strip("-") for value in values)
    return f"{prefix}-{suffix}"


def build_outline(ocr_directory: Path, destination: Path) -> None:
    outline: list[dict] = []
    sections_by_root: list[list[dict]] = [[] for _ in ROOT_SPECS]
    section_lookup: list[dict[str, dict]] = [{} for _ in ROOT_SPECS]

    for root_index, root in enumerate(ROOT_SPECS):
        outline.append(
            {
                "id": make_node_id("outline", root_index + 1),
                "title": root.title,
                "page": root.first_source_page - 5,
                "y": root.anchor_y,
                "children": sections_by_root[root_index],
            }
        )

    for source_page in range(6, 138):
        path = ocr_directory / f"mindmap-{source_page:03d}.json"
        if not path.exists():
            continue
        payload = json.loads(path.read_text())
        lines = sorted(payload.get("lines", []), key=lambda line: (line["y"], line["x"]))
        second_headings: list[dict] = []
        point_headings: list[dict] = []

        for index, line in enumerate(lines):
            text = compact_text(line.get("text", ""))
            if SECOND_LEVEL.match(text):
                title = heading_text(lines, index, SECOND_LEVEL)
                embedded_point = re.search(r"考点\s*\d*\s*[：:]", title)
                if embedded_point:
                    prefix = SECOND_LEVEL.match(title).group(0) if SECOND_LEVEL.match(title) else ""
                    section_title = prefix + title[embedded_point.end() :]
                    point_headings.append({**line, "title": title[embedded_point.start() :]})
                else:
                    section_title = title
                second_headings.append({**line, "title": section_title})
            elif POINT_LEVEL.match(text):
                point_headings.append({**line, "title": heading_text(lines, index, POINT_LEVEL)})

        page_sections: dict[int, list[dict]] = {}
        for heading_index, heading in enumerate(second_headings):
            root_candidates = roots_for_position(source_page, float(heading["y"]))
            if not root_candidates:
                continue
            root_index = root_candidates[0]
            title = heading["title"][:70]
            normalized = re.sub(r"[\s：:]+", "", title)
            section = section_lookup[root_index].get(normalized)
            if section is None:
                section = {
                    "id": make_node_id("section", source_page, heading_index + 1),
                    "title": title,
                    "page": source_page - 5,
                    "y": round(float(heading["y"]), 5),
                    "children": [],
                }
                section_lookup[root_index][normalized] = section
                sections_by_root[root_index].append(section)
            page_sections.setdefault(root_index, []).append(section)

        for point_index, heading in enumerate(point_headings):
            root_candidates = roots_for_position(source_page, float(heading["y"]))
            if not root_candidates:
                continue
            root_index = root_candidates[0]
            candidates = page_sections.get(root_index, [])
            section = min(
                candidates,
                key=lambda candidate: abs(float(candidate["y"]) - float(heading["y"])),
            ) if candidates else None
            if section is None:
                fallback_title = "本页考点"
                section = section_lookup[root_index].get(fallback_title)
                if section is None:
                    section = {
                        "id": make_node_id("section", source_page, "fallback"),
                        "title": fallback_title,
                        "page": source_page - 5,
                        "y": round(float(heading["y"]), 5),
                        "children": [],
                    }
                    section_lookup[root_index][fallback_title] = section
                    sections_by_root[root_index].append(section)
            section["children"].append(
                {
                    "id": make_node_id("point", source_page, point_index + 1),
                    "title": heading["title"][:90],
                    "page": source_page - 5,
                    "y": round(float(heading["y"]), 5),
                }
            )

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(outline, ensure_ascii=False, indent=2) + "\n")
    section_count = sum(len(root["children"]) for root in outline)
    point_count = sum(len(section["children"]) for root in outline for section in root["children"])
    print(f"Wrote {len(outline)} roots, {section_count} sections and {point_count} points to {destination}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pages", nargs="*", type=Path)
    parser.add_argument("--prepare-titles", action="store_true")
    parser.add_argument("--title-images", type=Path, default=Path("/private/tmp/politics-outline-titles"))
    parser.add_argument("--title-manifest", type=Path, default=Path("/private/tmp/politics-outline-title-manifest.json"))
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--ocr-directory", type=Path, default=Path("public/data/ocr"))
    parser.add_argument("--output", type=Path, default=Path("app/outline.json"))
    args = parser.parse_args()
    if args.prepare_titles:
        prepare_title_images(args.pages, args.title_images, args.title_manifest)
        return
    if args.build:
        build_outline(args.ocr_directory, args.output)
        return
    parser.error("Choose --prepare-titles or --build")


if __name__ == "__main__":
    main()
