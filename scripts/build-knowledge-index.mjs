import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ocrDirectory = path.join(root, "public", "data", "ocr");
const outputPath = path.join(root, "public", "data", "knowledge-index.json");
const manifest = JSON.parse(await readFile(path.join(root, "app", "page-manifest.json"), "utf8"));
const outline = JSON.parse(await readFile(path.join(root, "app", "outline.json"), "utf8"));

function flattenOutline(nodes, ancestors = []) {
  return nodes.flatMap((node) => [
    {
      id: node.id,
      title: node.title,
      page: node.page,
      y: node.y,
      breadcrumb: [...ancestors, node.title],
    },
    ...flattenOutline(node.children ?? [], [...ancestors, node.title]),
  ]);
}

const outlineLocations = flattenOutline(outline);

function outlineContext(page, y) {
  const candidates = outlineLocations
    .filter((item) => item.page === page)
    .sort((left, right) => {
      const leftBefore = left.y <= y ? 0 : 1;
      const rightBefore = right.y <= y ? 0 : 1;
      if (leftBefore !== rightBefore) return leftBefore - rightBefore;
      return Math.abs(left.y - y) - Math.abs(right.y - y);
    });
  return candidates[0]?.breadcrumb ?? [];
}

function markerDepth(text) {
  const normalized = text.replace(/^[！!「『◎●•\s]+/, "").replace(/\s+/g, "");
  if (/^(?:考点\d*[:：]?|[一二三四五六七八九十]+[、.．])/.test(normalized)) return 0;
  if (/^\d{1,2}[.、．]/.test(normalized)) return 1;
  if (/^[（(]\d+[）)]/.test(normalized)) return 2;
  if (/^[①②③④⑤⑥⑦⑧⑨⑩]/.test(normalized)) return 3;
  return null;
}

function findParentEntry(entry, pageEntries) {
  const entryCenterY = entry.y + entry.height / 2;
  const entryDepth = markerDepth(entry.text);
  const candidates = pageEntries
    .filter((candidate) => candidate.id !== entry.id)
    .filter((candidate) => candidate.x < entry.x - 0.018)
    .map((candidate) => {
      const centerDelta = Math.abs(candidate.y + candidate.height / 2 - entryCenterY);
      const horizontalDelta = entry.x - candidate.x;
      const candidateDepth = markerDepth(candidate.text);
      const sameOrDeeperLevelPenalty =
        entryDepth !== null && candidateDepth !== null && candidateDepth >= entryDepth
          ? 0.2
          : 0;
      const sameColumnPenalty = horizontalDelta < 0.04 ? 0.28 : 0;
      return {
        candidate,
        candidateDepth,
        centerDelta,
        horizontalDelta,
        sameOrDeeperLevelPenalty,
        sameColumnPenalty,
      };
    })
    .filter(({ centerDelta }) => centerDelta <= 0.16);
  const hasStructuredParent = candidates.some(
    ({ candidateDepth }) =>
      candidateDepth !== null && (entryDepth === null || candidateDepth < entryDepth),
  );

  return candidates
    .map((candidate) => ({
      ...candidate,
      score:
        candidate.horizontalDelta +
        candidate.centerDelta * 2.8 +
        candidate.sameOrDeeperLevelPenalty +
        candidate.sameColumnPenalty +
        (hasStructuredParent && candidate.candidateDepth === null ? 0.24 : 0),
    }))
    .sort((left, right) => left.score - right.score)[0]?.candidate;
}

function buildKnowledgeAreas(pageEntries) {
  const parentIds = new Map(
    pageEntries.map((entry) => [entry.id, findParentEntry(entry, pageEntries)?.id ?? null]),
  );
  const childrenById = new Map();
  parentIds.forEach((parentId, childId) => {
    if (!parentId) return;
    childrenById.set(parentId, [...(childrenById.get(parentId) ?? []), childId]);
  });
  const byId = new Map(pageEntries.map((entry) => [entry.id, entry]));
  const anchors = pageEntries.filter((entry) => {
    const depth = markerDepth(entry.text);
    return childrenById.has(entry.id) && depth !== null && depth <= 2;
  });

  return anchors.flatMap((anchor) => {
    const descendantIds = [];
    const queue = [...(childrenById.get(anchor.id) ?? [])];
    const visited = new Set([anchor.id]);
    while (queue.length && descendantIds.length < 96) {
      const id = queue.shift();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      descendantIds.push(id);
      queue.push(...(childrenById.get(id) ?? []));
    }
    const descendants = descendantIds.map((id) => byId.get(id)).filter(Boolean);
    if (!descendants.length) return [];

    const members = [anchor, ...descendants].sort(
      (left, right) => left.y - right.y || left.x - right.x,
    );
    const x = Math.min(...members.map((entry) => entry.x));
    const y = Math.min(...members.map((entry) => entry.y));
    const right = Math.max(...members.map((entry) => entry.x + entry.width));
    const bottom = Math.max(...members.map((entry) => entry.y + entry.height));
    const uniqueText = [...new Set(members.map((entry) => entry.text.trim()).filter(Boolean))];
    const breadcrumb = [...anchor.breadcrumb];
    if (breadcrumb.at(-1) !== anchor.text) breadcrumb.push(anchor.text);

    return [{
      id: `area-${anchor.id}`,
      kind: "area",
      page: anchor.page,
      sourcePage: anchor.sourcePage,
      title: anchor.text,
      text: uniqueText.join("\n"),
      breadcrumb,
      x: Number(x.toFixed(7)),
      y: Number(y.toFixed(7)),
      width: Number((right - x).toFixed(7)),
      height: Number((bottom - y).toFixed(7)),
      focusX: anchor.focusX,
      focusY: anchor.focusY,
      focusWidth: anchor.focusWidth,
      focusHeight: anchor.focusHeight,
    }];
  });
}

function joinSameRowFragments(lines) {
  const candidates = lines
    .map((line, lineIndex) => ({ ...line, lineIndex, text: line.text.trim() }))
    .filter((line) => line.text && line.width > 0 && line.height > 0);
  const parent = candidates.map((_, index) => index);

  const find = (index) => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      const centerDelta = Math.abs(
        left.y + left.height / 2 - (right.y + right.height / 2),
      );
      const rowTolerance = Math.min(left.height, right.height) * 0.3;
      if (centerDelta > rowTolerance) continue;

      const first = left.x <= right.x ? left : right;
      const last = left.x <= right.x ? right : left;
      const gap = last.x - (first.x + first.width);
      if (gap >= -0.006 && gap <= 0.0065) union(leftIndex, rightIndex);
    }
  }

  // Narrow branch labels are frequently wrapped vertically without a marker,
  // for example “实践是检验真 / 理的唯一标准”. Merge only tightly stacked,
  // same-column short lines so numbered sibling items remain independent.
  const startsIndependentItem = (text) =>
    /^\s*(?:\d{1,2}[.、．]|[（(]\d+[）)]|[①②③④⑤⑥⑦⑧⑨⑩]|考点\s*\d*\s*[：:])/.test(text);
  candidates.forEach((top, topIndex) => {
    if (
      top.text.replace(/\s+/g, "").length > 14 ||
      /[。！？；：.!?;:]$/.test(top.text.trim())
    ) {
      return;
    }
    const continuation = candidates
      .map((line, index) => ({ line, index }))
      .filter(({ index }) => find(index) !== find(topIndex))
      .filter(({ line }) => !startsIndependentItem(line.text))
      .filter(({ line }) => line.text.replace(/\s+/g, "").length <= 14)
      .filter(({ line }) => Math.abs(line.x - top.x) <= 0.008)
      .filter(({ line }) => {
        const gap = line.y - (top.y + top.height);
        return gap >= -0.0045 && gap <= 0.0075;
      })
      .sort((left, right) => left.line.y - right.line.y)[0];
    if (continuation) union(topIndex, continuation.index);
  });

  const groups = new Map();
  candidates.forEach((_, index) => {
    const rootIndex = find(index);
    groups.set(rootIndex, [...(groups.get(rootIndex) ?? []), index]);
  });

  return [...groups.values()].map((indexes) => {
    const groupLines = indexes.map((index) => candidates[index]);
    const ordered = [...groupLines].sort((left, right) => {
      const centerDelta =
        left.y + left.height / 2 - (right.y + right.height / 2);
      return Math.abs(centerDelta) <= Math.min(left.height, right.height) * 0.3
        ? left.x - right.x
        : left.y - right.y;
    });
    const lineIndexes = groupLines.map((line) => line.lineIndex).sort((a, b) => a - b);
    const x = Math.min(...groupLines.map((line) => line.x));
    const y = Math.min(...groupLines.map((line) => line.y));
    const right = Math.max(...groupLines.map((line) => line.x + line.width));
    const bottom = Math.max(...groupLines.map((line) => line.y + line.height));
    return {
      lineIndexes,
      text: ordered.map((line) => line.text).join(""),
      x,
      y,
      width: right - x,
      height: bottom - y,
    };
  });
}

const ocrFiles = (await readdir(ocrDirectory))
  .filter((name) => /^mindmap-\d{3}\.json$/.test(name))
  .sort();
const manifestBySourcePage = new Map(manifest.map((page) => [page.sourcePage, page]));
const entries = [];
let sourceLineCount = 0;
let indexedLineCount = 0;

for (const filename of ocrFiles) {
  const sourcePage = Number(filename.match(/\d{3}/)?.[0]);
  const page = manifestBySourcePage.get(sourcePage);
  if (!page) continue;

  const ocr = JSON.parse(await readFile(path.join(ocrDirectory, filename), "utf8"));
  const rows = joinSameRowFragments(ocr.lines);
  sourceLineCount += ocr.lines.filter(
    (line) => line.text.trim() && line.width > 0 && line.height > 0,
  ).length;
  indexedLineCount += rows.reduce((total, row) => total + row.lineIndexes.length, 0);
  const pageEntries = rows.map((row) => {
    const breadcrumb = outlineContext(page.number, row.y + row.height / 2);
    return {
      id: `knowledge-p${page.number}-l${row.lineIndexes.join("-")}`,
      kind: "line",
      page: page.number,
      sourcePage,
      title: row.text,
      text: row.text,
      breadcrumb,
      x: Number(row.x.toFixed(7)),
      y: Number(row.y.toFixed(7)),
      width: Number(row.width.toFixed(7)),
      height: Number(row.height.toFixed(7)),
      focusX: Number(row.x.toFixed(7)),
      focusY: Number(row.y.toFixed(7)),
      focusWidth: Number(row.width.toFixed(7)),
      focusHeight: Number(row.height.toFixed(7)),
    };
  });
  entries.push(...pageEntries, ...buildKnowledgeAreas(pageEntries));
}

if (indexedLineCount !== sourceLineCount) {
  throw new Error(
    `Knowledge index coverage mismatch: indexed ${indexedLineCount} of ${sourceLineCount} OCR lines`,
  );
}

const payload = {
  schemaVersion: 2,
  pageCount: manifest.length,
  entryCount: entries.length,
  sourceLineCount,
  entries,
};

await writeFile(outputPath, `${JSON.stringify(payload)}\n`);
console.log(
  `Wrote ${entries.length} searchable text entries covering ${sourceLineCount} OCR lines to ${path.relative(root, outputPath)}`,
);
