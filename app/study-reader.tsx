"use client";

import {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AccountControls } from "./account-controls";
import { APP_NAMESPACE, STORAGE_KEYS, VERSION_ID_PREFIX, withBasePath } from "./lib/app-config";
import {
  EPOCH_TIMESTAMP,
  nextIsoTimestamp,
  type StoredLibrary,
  type StoredSettings,
  type StudyVersion,
} from "./lib/study-types";
import { useCloudSync } from "./lib/use-cloud-sync";
import pageManifest from "./page-manifest.json";
import detectedSummaryRegions from "./summary-regions.json";
import outlineData from "./outline.json";

type OCRLine = {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  glyphs: OCRGlyph[];
};

type OCRGlyph = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type OCRPage = {
  image: string;
  width: number;
  height: number;
  lines: OCRLine[];
};

type ReadingMode = "scroll" | "page";
type InteractionMode = "highlight" | "entry";

type EntrySegment = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type EntryBlock = {
  id: string;
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  segments: EntrySegment[];
  lineIndexes: number[];
  isSummary: boolean;
};

type SummaryRegion = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type StateUpdate<T> = T | ((current: T) => T);

type PageMetadata = {
  number: number;
  sourcePage: number;
  src: string;
  sharpSrc: string;
  width: number;
  height: number;
};

type OutlineNode = {
  id: string;
  title: string;
  page: number;
  y: number;
  children?: OutlineNode[];
};

const PAGES = (pageManifest as PageMetadata[]).map((page) => ({
  ...page,
  src: withBasePath(page.src),
  sharpSrc: withBasePath(page.sharpSrc),
}));
const OUTLINE = outlineData as OutlineNode[];
const NO_FOCUS_HIGHLIGHT_LINES = new Set<string>();
const DEFAULT_VERSION_ID = `${APP_NAMESPACE}-default`;
const INITIAL_UPDATED_AT = EPOCH_TIMESTAMP;

function createVersionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${APP_NAMESPACE}-version-${crypto.randomUUID()}`;
  }
  return `${APP_NAMESPACE}-version-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStoredVersion(value: unknown): StudyVersion | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StudyVersion>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return null;
  if (!candidate.id.startsWith(VERSION_ID_PREFIX)) return null;

  const notes =
    candidate.notes && typeof candidate.notes === "object" && !Array.isArray(candidate.notes)
      ? Object.fromEntries(
          Object.entries(candidate.notes).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};

  return {
    id: candidate.id,
    name: candidate.name.trim() || "未命名版本",
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
    updatedAt:
      typeof candidate.updatedAt === "string" && !Number.isNaN(Date.parse(candidate.updatedAt))
        ? candidate.updatedAt
        : INITIAL_UPDATED_AT,
    highlights: Array.isArray(candidate.highlights)
      ? candidate.highlights.filter((id): id is string => typeof id === "string")
      : [],
    notes,
    highlightHistory: Array.isArray(candidate.highlightHistory)
      ? candidate.highlightHistory
          .filter((batch): batch is string[] => Array.isArray(batch))
          .map((batch) => batch.filter((id): id is string => typeof id === "string"))
          .filter((batch) => batch.length > 0)
      : [],
    emphasizedEntries: Array.isArray(candidate.emphasizedEntries)
      ? candidate.emphasizedEntries.filter((id): id is string => typeof id === "string")
      : [],
  };
}

// Independent red callout cards are detected across the full book. The two
// original test pages keep their hand-tuned regions so existing entry IDs and
// saved notes remain stable.
const SUMMARY_REGIONS: Record<number, SummaryRegion[]> = {
  ...(detectedSummaryRegions as Record<number, SummaryRegion[]>),
  1: [
    { id: "p1-summary-1", x: 0.472, y: 0.185, width: 0.25, height: 0.055 },
    { id: "p1-summary-2", x: 0.621, y: 0.456, width: 0.158, height: 0.045 },
    { id: "p1-summary-3", x: 0.608, y: 0.596, width: 0.25, height: 0.078 },
    { id: "p1-summary-4", x: 0.644, y: 0.764, width: 0.205, height: 0.055 },
    { id: "p1-summary-5", x: 0.579, y: 0.903, width: 0.224, height: 0.064 },
  ],
  2: [
    { id: "p2-summary-callout", x: 0.122, y: 0.151, width: 0.101, height: 0.043 },
    { id: "p2-summary-1", x: 0.771, y: 0.136, width: 0.197, height: 0.198 },
    { id: "p2-summary-2", x: 0.487, y: 0.337, width: 0.251, height: 0.079 },
    { id: "p2-summary-3", x: 0.483, y: 0.44, width: 0.254, height: 0.07 },
    { id: "p2-summary-4", x: 0.758, y: 0.51, width: 0.206, height: 0.058 },
    { id: "p2-summary-5", x: 0.661, y: 0.766, width: 0.249, height: 0.066 },
  ],
};

function isInsideRegion(line: OCRLine, region: SummaryRegion) {
  const centerX = line.x + line.width / 2;
  const centerY = line.y + line.height / 2;
  return (
    centerX >= region.x &&
    centerX <= region.x + region.width &&
    centerY >= region.y &&
    centerY <= region.y + region.height
  );
}

function buildEntryBlocks(
  page: OCRPage,
  pageNumber: number,
  shouldInclude: (line: OCRLine, lineIndex: number) => boolean = () => true,
): EntryBlock[] {
  const candidates = page.lines
    .map((line, lineIndex) => ({ ...line, lineIndex, text: line.text.trim() }))
    .filter(
      (line) =>
        line.text && line.width > 0 && line.height > 0 && shouldInclude(line, line.lineIndex),
    );
  const parent = candidates.map((_, index) => index);

  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  // Vision may split one printed sentence into several lines when its ink colour changes.
  // Only join fragments that are on the same baseline and almost touch horizontally.
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      const centerDelta = Math.abs(
        left.y + left.height / 2 - (right.y + right.height / 2),
      );
      const rowTolerance = Math.min(left.height, right.height) * 0.3;
      if (centerDelta > rowTolerance) continue;

      const leftFirst = left.x <= right.x ? left : right;
      const rightLast = left.x <= right.x ? right : left;
      const gap = rightLast.x - (leftFirst.x + leftFirst.width);
      if (gap >= -0.006 && gap <= 0.0065) union(leftIndex, rightIndex);
    }
  }

  // Structural parent labels are often wrapped into two short lines in the
  // map (for example “2.中国共产党争取 / 和平民主的方针”). Join those lines
  // before building the ancestry graph, otherwise focus mode can reveal only
  // the first half of the parent node.
  const startsStructuralParent = (text: string) => /^\s*\d{1,2}[.、．]/.test(text);
  const startsAnotherMarker = (text: string) =>
    /^\s*(?:\d{1,2}[.、．]|[（(]\d+[）)]|[①②③④⑤⑥⑦⑧⑨⑩]|考点\s*\d*\s*[：:])/.test(text);

  candidates.forEach((heading, headingIndex) => {
    if (!startsStructuralParent(heading.text) || heading.width > 0.18) return;
    let groupBottom = heading.y + heading.height;

    for (let continuationIndex = 0; continuationIndex < 2; continuationIndex += 1) {
      const continuation = candidates
        .map((line, index) => ({ line, index }))
        .filter(({ index }) => find(index) !== find(headingIndex))
        .filter(({ line }) => !startsAnotherMarker(line.text))
        .filter(({ line }) => Math.abs(line.x - heading.x) <= 0.018)
        .filter(({ line }) => line.width <= 0.18)
        .filter(({ line }) => line.y + line.height / 2 > groupBottom - heading.height / 2)
        .filter(({ line }) => line.y - groupBottom >= -0.006 && line.y - groupBottom <= 0.012)
        .sort((left, right) => left.line.y - right.line.y)[0];

      if (!continuation) break;
      union(headingIndex, continuation.index);
      groupBottom = Math.max(groupBottom, continuation.line.y + continuation.line.height);
    }
  });

  const groups = new Map<number, number[]>();
  candidates.forEach((_, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  });

  // A “考点” heading and its tightly attached subtitle are one logical parent node.
  // Some pages use a parenthesised subtitle, while others print a short title below it.
  for (const [root, indexes] of Array.from(groups.entries())) {
    const lines = indexes.map((index) => candidates[index]);
    const heading = lines.find((line) => /考点\s*\d*\s*[：:]/.test(line.text));
    if (!heading) continue;
    const headingTail = heading.text.split(/[：:]/).slice(1).join("").trim();
    let groupBottom = Math.max(...lines.map((line) => line.y + line.height));
    let lastCenterY = Math.max(...lines.map((line) => line.y + line.height / 2));
    const maximumSubtitleLines = headingTail ? 1 : 3;

    for (let subtitleIndex = 0; subtitleIndex < maximumSubtitleLines; subtitleIndex += 1) {
      const subtitle = candidates
        .map((line, index) => ({ line, index }))
        .filter(({ index }) => find(index) !== find(root))
        .filter(({ line }) =>
          headingTail
            ? /^[（(]/.test(line.text)
            : line.text.replace(/\s+/g, "").length <= 18,
        )
        .filter(({ line }) => line.y + line.height / 2 > lastCenterY + 0.004)
        .filter(({ line }) => line.y - groupBottom <= 0.009)
        .filter(({ line }) => Math.abs(line.x - heading.x) <= 0.04)
        .sort((left, right) => left.line.y - right.line.y)[0];

      if (!subtitle) break;
      union(root, subtitle.index);
      groupBottom = Math.max(groupBottom, subtitle.line.y + subtitle.line.height);
      lastCenterY = subtitle.line.y + subtitle.line.height / 2;
    }
  }

  const finalGroups = new Map<number, number[]>();
  candidates.forEach((_, index) => {
    const root = find(index);
    finalGroups.set(root, [...(finalGroups.get(root) ?? []), index]);
  });

  return Array.from(finalGroups.values()).map((indexes) => {
    const lines = indexes.map((index) => candidates[index]);
    const orderedLines = [...lines].sort((a, b) => {
      const rowDelta = a.y + a.height / 2 - (b.y + b.height / 2);
      return Math.abs(rowDelta) <= Math.min(a.height, b.height) * 0.3 ? a.x - b.x : a.y - b.y;
    });
    const left = Math.min(...lines.map((line) => line.x));
    const top = Math.min(...lines.map((line) => line.y));
    const right = Math.max(...lines.map((line) => line.x + line.width));
    const bottom = Math.max(...lines.map((line) => line.y + line.height));

    const segments: EntrySegment[] = [];
    orderedLines.forEach((line) => {
      const matchingRow = segments.find(
        (segment) =>
          Math.abs(segment.y + segment.height / 2 - (line.y + line.height / 2)) <=
          Math.min(segment.height, line.height) * 0.3,
      );
      if (!matchingRow) {
        segments.push({ x: line.x, y: line.y, width: line.width, height: line.height });
        return;
      }
      const segmentRight = Math.max(matchingRow.x + matchingRow.width, line.x + line.width);
      matchingRow.x = Math.min(matchingRow.x, line.x);
      matchingRow.y = Math.min(matchingRow.y, line.y);
      matchingRow.width = segmentRight - matchingRow.x;
      matchingRow.height = Math.max(matchingRow.height, line.height);
    });

    const lineIndexes = lines.map((line) => line.lineIndex).sort((a, b) => a - b);
    return {
      id: `entry-p${pageNumber}-l${lineIndexes.join("-")}`,
      page: pageNumber,
      text: orderedLines.map((line) => line.text).join(""),
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      segments,
      lineIndexes,
      isSummary: false,
    };
  });
}

function combineSummaryBlocks(
  blocks: EntryBlock[],
  pageNumber: number,
  region: SummaryRegion,
  itemIndex: number,
): EntryBlock {
  const ordered = [...blocks].sort((left, right) => {
    const centerDelta = left.y + left.height / 2 - (right.y + right.height / 2);
    const rowTolerance = Math.max(left.height, right.height) * 0.65;
    return Math.abs(centerDelta) <= rowTolerance ? left.x - right.x : left.y - right.y;
  });
  const left = Math.min(...blocks.map((block) => block.x));
  const top = Math.min(...blocks.map((block) => block.y));
  const right = Math.max(...blocks.map((block) => block.x + block.width));
  const bottom = Math.max(...blocks.map((block) => block.y + block.height));
  const lineIndexes = Array.from(new Set(blocks.flatMap((block) => block.lineIndexes))).sort(
    (a, b) => a - b,
  );

  return {
    id: `summary-${region.id}-item-${itemIndex}-l${lineIndexes.join("-")}`,
    page: pageNumber,
    text: ordered.map((block) => block.text).join(""),
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    segments: ordered.flatMap((block) => block.segments),
    lineIndexes,
    isSummary: true,
  };
}

function buildSummaryEntries(page: OCRPage, pageNumber: number): EntryBlock[] {
  return (SUMMARY_REGIONS[pageNumber] ?? []).flatMap((region) => {
    const regionBlocks = buildEntryBlocks(
      page,
      pageNumber,
      (line) => isInsideRegion(line, region),
    ).sort((left, right) => {
      const centerDelta = left.y + left.height / 2 - (right.y + right.height / 2);
      const rowTolerance = Math.max(left.height, right.height) * 0.65;
      return Math.abs(centerDelta) <= rowTolerance ? left.x - right.x : left.y - right.y;
    });
    const itemGroups: EntryBlock[][] = [];
    let currentGroup: EntryBlock[] | null = null;

    regionBlocks.forEach((block) => {
      const normalizedText = block.text.replace(/\s+/g, "");
      const headingOnly = /^[！!「]?\s*(?:总结|易错点)(?:（[^）]*）)?[：:]?\s*$/.test(
        normalizedText,
      );
      if (headingOnly) {
        currentGroup = null;
        return;
      }

      const startsNumberedItem = /^[！!「]?\s*(?:\d{1,2}[.、．]|\d{1,2}(?=[\u4e00-\u9fff])|[①②③④⑤⑥⑦⑧⑨⑩]|[（(]\d+[）)])/.test(
        normalizedText,
      );
      const currentBottom = currentGroup
        ? Math.max(...currentGroup.map((entry) => entry.y + entry.height))
        : -1;

      if (startsNumberedItem || !currentGroup || block.y - currentBottom > 0.028) {
        currentGroup = [block];
        itemGroups.push(currentGroup);
      } else {
        currentGroup.push(block);
      }
    });

    return itemGroups.map((blocks, itemIndex) =>
      combineSummaryBlocks(blocks, pageNumber, region, itemIndex + 1),
    );
  });
}

function entryMarkerDepth(text: string) {
  const normalized = text.replace(/^[！!「『\s]+/, "").replace(/\s+/g, "");
  if (/^(?:考点\d*[:：]?|[一二三四五六七八九十]+[、.．])/.test(normalized)) return 0;
  if (/^\d{1,2}[.、．]/.test(normalized)) return 1;
  if (/^[（(]\d+[）)]/.test(normalized)) return 2;
  if (/^[①②③④⑤⑥⑦⑧⑨⑩]/.test(normalized)) return 3;
  return null;
}

function findParentEntry(entry: EntryBlock, entries: EntryBlock[]) {
  const entryCenterY = entry.y + entry.height / 2;
  const entryDepth = entryMarkerDepth(entry.text);
  const candidates = entries
    .filter((candidate) => !candidate.isSummary && candidate.id !== entry.id)
    .filter((candidate) => candidate.x < entry.x - 0.018)
    .map((candidate) => {
      const centerDelta = Math.abs(candidate.y + candidate.height / 2 - entryCenterY);
      const horizontalDelta = entry.x - candidate.x;
      const candidateDepth = entryMarkerDepth(candidate.text);
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
    .filter(({ centerDelta }) => centerDelta <= 0.145);
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

function expandedEntryRect(entry: EntryBlock): SummaryRegion {
  const isMultiLineNode = entry.segments.length > 1;
  const x = Math.max(0, entry.x - (isMultiLineNode ? 0.0055 : 0.0045));
  const y = Math.max(0, entry.y - (isMultiLineNode ? 0.0045 : 0.0035));
  const right = Math.min(1, entry.x + entry.width + (isMultiLineNode ? 0.0065 : 0.0055));
  const bottom = Math.min(1, entry.y + entry.height + (isMultiLineNode ? 0.007 : 0.0045));
  return { id: `reveal-${entry.id}`, x, y, width: right - x, height: bottom - y };
}

function buildConnectorRevealRegions(
  entries: EntryBlock[],
  parentIds: Map<string, string | null>,
  visibleIds: Set<string>,
): SummaryRegion[] {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

  return entries.flatMap((child) => {
    if (child.isSummary || !visibleIds.has(child.id)) return [];
    const parentId = parentIds.get(child.id);
    const parent = parentId ? entriesById.get(parentId) : null;
    if (!parent || parent.isSummary || !visibleIds.has(parent.id)) return [];

    // Reveal a narrow parent-to-child corridor from the transparent line-only
    // page layer. It is intentionally wider than a synthetic elbow so the
    // source map's exact coloured route survives, including vertical trunks.
    const x = Math.max(0, Math.min(parent.x, child.x) - 0.035);
    const right = Math.min(1, child.x + 0.027);
    const y = Math.max(0, Math.min(parent.y, child.y) - 0.012);
    const bottom = Math.min(
      1,
      Math.max(parent.y + parent.height, child.y + child.height) + 0.012,
    );
    if (right <= x || bottom <= y) return [];

    return [
      {
        id: `connector-${parent.id}-${child.id}`,
        x,
        y,
        width: right - x,
        height: bottom - y,
      },
    ];
  });
}

function clampPage(value: number) {
  return Math.min(PAGES.length, Math.max(1, value));
}

function clampZoom(value: number) {
  return Math.min(2.5, Math.max(0.65, Math.round(value * 1000) / 1000));
}

function applyViewerZoom(viewer: HTMLElement | null, value: number) {
  if (!viewer) return;
  viewer.style.setProperty("--page-sheet-width", `${Math.round(1400 * value)}px`);
  viewer.style.setProperty("--page-sheet-max-width", `${Math.round(92 * value)}vw`);
}

function parseGlyphId(id: string) {
  const match = /^p(\d+)-l(\d+)-g(\d+)$/.exec(id);
  if (!match) return null;
  return { page: Number(match[1]), line: Number(match[2]), glyph: Number(match[3]) };
}

type SelectableTextLayerProps = {
  pageNumber: number;
  ocr: OCRPage;
  visibleLineIndexes: Set<number>;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
};

const SelectableTextLayer = memo(function SelectableTextLayer({
  pageNumber,
  ocr,
  visibleLineIndexes,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: SelectableTextLayerProps) {
  return (
    <div
      className="text-layer"
      aria-label={`第 ${pageNumber} 页可选择文字层`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {ocr.lines.flatMap((line, lineIndex) => {
        if (!visibleLineIndexes.has(lineIndex)) return [];
        return line.glyphs.map((glyph, glyphIndex) => {
          const id = `p${pageNumber}-l${lineIndex}-g${glyphIndex}`;
          return (
            <span
              className="ocr-glyph"
              data-highlight-id={id}
              key={id}
              style={{
                left: `${glyph.x * 100}%`,
                top: `${glyph.y * 100}%`,
                width: `${Math.max(glyph.width, 0.0028) * 100}%`,
                height: `${Math.max(glyph.height * 1.12, 0.0065) * 100}%`,
                fontSize: `${Math.max(glyph.height * 94, 0.42)}cqh`,
              }}
            >
              {glyph.text}
            </span>
          );
        });
      })}
    </div>
  );
});

export function StudyReader() {
  const [mode, setMode] = useState<ReadingMode>("scroll");
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("highlight");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [zoomMode, setZoomMode] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [ocrPages, setOcrPages] = useState<Array<OCRPage | null>>(() =>
    Array.from({ length: PAGES.length }, () => null),
  );
  const [versions, setVersions] = useState<StudyVersion[]>([]);
  const [activeVersionId, setActiveVersionId] = useState("");
  const [activeVersionUpdatedAt, setActiveVersionUpdatedAt] = useState(INITIAL_UPDATED_AT);
  const [versionsHydrated, setVersionsHydrated] = useState(false);
  const [versionDialog, setVersionDialog] = useState<"create" | "delete" | null>(null);
  const [versionNameDraft, setVersionNameDraft] = useState("");
  const [pendingSelection, setPendingSelection] = useState<string[]>([]);
  const [focusOnly, setFocusOnly] = useState(false);
  const [showSummaries, setShowSummaries] = useState(true);
  const [summaryOnly, setSummaryOnly] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [expandedOutlineRoots, setExpandedOutlineRoots] = useState<Set<string>>(() => new Set());
  const [expandedOutlineSections, setExpandedOutlineSections] = useState<Set<string>>(() => new Set());
  const [hoveredEntryId, setHoveredEntryId] = useState<string | null>(null);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [floatingNoteEntryId, setFloatingNoteEntryId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [toast, setToast] = useState("");
  const viewerRef = useRef<HTMLElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLElement | null>>({});
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ocrRequests = useRef(new Set<number>());
  const zoomRef = useRef(1);
  const renderedZoomRef = useRef(1);
  const wheelZoomFrame = useRef<number | null>(null);
  const wheelZoomEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelZoomAnchor = useRef<{
    viewer: HTMLElement;
    sheet: HTMLElement | null;
    clientX: number;
    clientY: number;
    cursorX: number;
    cursorY: number;
    normalizedX: number;
    normalizedY: number;
    contentX: number;
    contentY: number;
    previousZoom: number;
    nextZoom: number;
  } | null>(null);
  const dragSelection = useRef<{
    pointerId: number;
    startId: string;
    lastId: string;
  } | null>(null);

  const cloud = useCloudSync({
    versions,
    activeVersionId,
    activeVersionUpdatedAt,
    hydrated: versionsHydrated,
    setVersions,
    setActiveVersionId,
    setActiveVersionUpdatedAt,
  });

  const activeVersion = versions.find((version) => version.id === activeVersionId) ?? null;
  const highlights = activeVersion?.highlights ?? [];
  const notes = activeVersion?.notes ?? {};
  const highlightHistory = activeVersion?.highlightHistory ?? [];
  const emphasizedEntries = activeVersion?.emphasizedEntries ?? [];

  const updateActiveVersion = useCallback(
    (updater: (version: StudyVersion) => StudyVersion) => {
      setVersions((current) =>
        current.map((version) =>
          version.id === activeVersionId
            ? { ...updater(version), updatedAt: nextIsoTimestamp(version.updatedAt) }
            : version,
        ),
      );
    },
    [activeVersionId],
  );

  const setHighlights = useCallback(
    (update: StateUpdate<string[]>) => {
      updateActiveVersion((version) => ({
        ...version,
        highlights: typeof update === "function" ? update(version.highlights) : update,
      }));
    },
    [updateActiveVersion],
  );

  const setHighlightHistory = useCallback(
    (update: StateUpdate<string[][]>) => {
      updateActiveVersion((version) => ({
        ...version,
        highlightHistory:
          typeof update === "function" ? update(version.highlightHistory) : update,
      }));
    },
    [updateActiveVersion],
  );

  const setNotes = useCallback(
    (update: StateUpdate<Record<string, string>>) => {
      updateActiveVersion((version) => ({
        ...version,
        notes: typeof update === "function" ? update(version.notes) : update,
      }));
    },
    [updateActiveVersion],
  );

  const setEmphasizedEntries = useCallback(
    (update: StateUpdate<string[]>) => {
      updateActiveVersion((version) => ({
        ...version,
        emphasizedEntries:
          typeof update === "function" ? update(version.emphasizedEntries) : update,
      }));
    },
    [updateActiveVersion],
  );

  const loadOcrPage = useCallback((pageNumber: number) => {
    const page = PAGES[pageNumber - 1];
    if (!page || ocrRequests.current.has(pageNumber)) return;
    ocrRequests.current.add(pageNumber);
    const sourceId = String(page.sourcePage).padStart(3, "0");

    fetch(withBasePath(`/data/ocr/mindmap-${sourceId}.json`))
      .then((response) => {
        if (!response.ok) throw new Error(`OCR page ${pageNumber} is unavailable`);
        return response.json() as Promise<OCRPage>;
      })
      .then((data) => {
        setOcrPages((current) => {
          const next = [...current];
          next[pageNumber - 1] = data;
          return next;
        });
      })
      .catch(() => {
        ocrRequests.current.delete(pageNumber);
      });
  }, []);

  useEffect(() => {
    loadOcrPage(1);
    loadOcrPage(2);

    let loadedVersions: StudyVersion[] = [];
    let loadedActiveVersionId = "";
    let loadedActiveVersionUpdatedAt = INITIAL_UPDATED_AT;

    try {
      const storedLibrary = window.localStorage.getItem(STORAGE_KEYS.library);
      if (storedLibrary) {
        const parsed = JSON.parse(storedLibrary) as Partial<StoredLibrary>;
        loadedVersions = Array.isArray(parsed.versions)
          ? parsed.versions
              .map((version) => normalizeStoredVersion(version))
              .filter((version): version is StudyVersion => Boolean(version))
          : [];
      }
      const storedSettings = window.localStorage.getItem(STORAGE_KEYS.settings);
      if (storedSettings) {
        const parsed = JSON.parse(storedSettings) as Partial<StoredSettings>;
        loadedActiveVersionId =
          typeof parsed.activeVersionId === "string" ? parsed.activeVersionId : "";
        loadedActiveVersionUpdatedAt =
          typeof parsed.updatedAt === "string" && !Number.isNaN(Date.parse(parsed.updatedAt))
            ? parsed.updatedAt
            : INITIAL_UPDATED_AT;
      }
    } catch {
      // A damaged project-scoped payload falls back to a fresh local version.
    }

    if (!loadedVersions.length) {
      loadedVersions = [
        {
          id: DEFAULT_VERSION_ID,
          name: "默认版本",
          createdAt: 0,
          updatedAt: INITIAL_UPDATED_AT,
          highlights: [],
          notes: {},
          highlightHistory: [],
          emphasizedEntries: [],
        },
      ];
      loadedActiveVersionId = DEFAULT_VERSION_ID;
      loadedActiveVersionUpdatedAt = INITIAL_UPDATED_AT;
    }

    const activeVersionExists = loadedVersions.some(
      (version) => version.id === loadedActiveVersionId,
    );
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setVersions(loadedVersions);
      setActiveVersionId(activeVersionExists ? loadedActiveVersionId : loadedVersions[0].id);
      setActiveVersionUpdatedAt(loadedActiveVersionUpdatedAt);
      setVersionsHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadOcrPage]);

  useEffect(() => {
    if (!versionsHydrated || !activeVersionId || !versions.length) return;
    try {
      window.localStorage.setItem(
        STORAGE_KEYS.library,
        JSON.stringify({ schemaVersion: 1, versions } satisfies StoredLibrary),
      );
      window.localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          schemaVersion: 1,
          activeVersionId,
          updatedAt: activeVersionUpdatedAt,
        } satisfies StoredSettings),
      );
    } catch {
      // Versions still work for the current session if local storage is unavailable.
    }
  }, [activeVersionId, activeVersionUpdatedAt, versions, versionsHydrated]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register(withBasePath("/sw.js"), {
      scope: `${withBasePath("/")}`,
    });
  }, []);

  useEffect(() => {
    zoomRef.current = zoom;
    renderedZoomRef.current = zoom;
    applyViewerZoom(viewerRef.current, zoom);
  }, [zoom]);

  useEffect(
    () => () => {
      if (wheelZoomFrame.current !== null) cancelAnimationFrame(wheelZoomFrame.current);
      if (wheelZoomEndTimer.current) clearTimeout(wheelZoomEndTimer.current);
      viewerRef.current?.classList.remove("wheel-zooming");
    },
    [],
  );

  useEffect(() => {
    const clearPendingOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest(".ocr-glyph")) setPendingSelection([]);
    };
    window.addEventListener("pointerdown", clearPendingOnOutsideClick, true);
    return () => window.removeEventListener("pointerdown", clearPendingOnOutsideClick, true);
  }, []);

  useEffect(() => {
    loadOcrPage(currentPage);
    loadOcrPage(currentPage - 1);
    loadOcrPage(currentPage + 1);
    loadOcrPage(currentPage - 2);
    loadOcrPage(currentPage + 2);
  }, [currentPage, loadOcrPage]);

  useEffect(() => {
    if (mode !== "scroll" || !viewerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        const page = Number((visible.target as HTMLElement).dataset.pageNumber);
        if (page) {
          loadOcrPage(page);
          setCurrentPage(page);
          setPageDraft(String(page));
        }
      },
      { root: viewerRef.current, threshold: [0.12, 0.3, 0.55] },
    );

    Object.values(pageRefs.current).forEach((page) => page && observer.observe(page));
    return () => observer.disconnect();
  }, [loadOcrPage, mode]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 1800);
  }, []);

  const commitZoom = useCallback((value: number) => {
    const nextZoom = clampZoom(value);
    zoomRef.current = nextZoom;
    renderedZoomRef.current = nextZoom;
    applyViewerZoom(viewerRef.current, nextZoom);
    setZoom((current) => (current === nextZoom ? current : nextZoom));
  }, []);

  const clearTransientStudyState = useCallback(() => {
    setPendingSelection([]);
    setHoveredEntryId(null);
    setFloatingNoteEntryId(null);
    setActiveEntryId(null);
    setNoteDraft("");
    window.getSelection()?.removeAllRanges();
  }, []);

  const selectVersion = useCallback(
    (versionId: string) => {
      if (versionId === activeVersionId) return;
      const nextVersion = versions.find((version) => version.id === versionId);
      if (!nextVersion) return;
      clearTransientStudyState();
      setActiveVersionId(nextVersion.id);
      setActiveVersionUpdatedAt((current) => nextIsoTimestamp(current));
      showToast(`已切换到「${nextVersion.name}」`);
    },
    [activeVersionId, clearTransientStudyState, showToast, versions],
  );

  const openCreateVersion = useCallback(() => {
    const nextIndex = versions.length + 1;
    setVersionNameDraft(`复习版本 ${nextIndex}`);
    setVersionDialog("create");
  }, [versions.length]);

  const createVersion = useCallback(() => {
    const name = versionNameDraft.trim();
    if (!name) return;
    const timestamp = nextIsoTimestamp();
    const nextVersion: StudyVersion = {
      id: createVersionId(),
      name,
      createdAt: Date.now(),
      updatedAt: timestamp,
      highlights: [],
      notes: {},
      highlightHistory: [],
      emphasizedEntries: [],
    };
    clearTransientStudyState();
    setVersions((current) => [...current, nextVersion]);
    setActiveVersionId(nextVersion.id);
    setActiveVersionUpdatedAt((current) => nextIsoTimestamp(current));
    setVersionDialog(null);
    setVersionNameDraft("");
    showToast(`已新建并切换到「${nextVersion.name}」`);
  }, [clearTransientStudyState, showToast, versionNameDraft]);

  const deleteActiveVersion = useCallback(() => {
    if (!activeVersion || versions.length <= 1) return;
    const remainingVersions = versions.filter((version) => version.id !== activeVersion.id);
    cloud.markVersionDeleted(activeVersion.id);
    clearTransientStudyState();
    setVersions(remainingVersions);
    setActiveVersionId(remainingVersions[0].id);
    setActiveVersionUpdatedAt((current) => nextIsoTimestamp(current));
    setVersionDialog(null);
    showToast(`已删除「${activeVersion.name}」`);
  }, [activeVersion, clearTransientStudyState, cloud, showToast, versions]);

  const entryPages = useMemo(
    () =>
      PAGES.map((_, pageIndex) => {
        const page = ocrPages[pageIndex];
        if (!page) return [];
        const pageNumber = pageIndex + 1;
        const summaryRegions = SUMMARY_REGIONS[pageNumber] ?? [];
        const regularEntries = buildEntryBlocks(
          page,
          pageNumber,
          (line) => !summaryRegions.some((region) => isInsideRegion(line, region)),
        );
        return [...regularEntries, ...buildSummaryEntries(page, pageNumber)];
      }),
    [ocrPages],
  );
  const parentEntryIdsByPage = useMemo(
    () =>
      entryPages.map(
        (entries) =>
          new Map(
            entries.map((entry) => [entry.id, findParentEntry(entry, entries)?.id ?? null]),
          ),
      ),
    [entryPages],
  );
  const entriesById = useMemo(
    () => new Map(entryPages.flat().map((entry) => [entry.id, entry])),
    [entryPages],
  );
  const emphasizedEntrySet = useMemo(
    () => new Set(emphasizedEntries),
    [emphasizedEntries],
  );
  const emphasizedGlyphIds = useMemo(
    () =>
      emphasizedEntries.flatMap((entryId) => {
        const entry = entriesById.get(entryId);
        const page = entry ? ocrPages[entry.page - 1] : null;
        if (!entry || !page) return [];
        return entry.lineIndexes.flatMap((lineIndex) =>
          (page.lines[lineIndex]?.glyphs ?? []).map(
            (_, glyphIndex) => `p${entry.page}-l${lineIndex}-g${glyphIndex}`,
          ),
        );
      }),
    [emphasizedEntries, entriesById, ocrPages],
  );
  const effectiveHighlights = useMemo(
    () => Array.from(new Set([...highlights, ...emphasizedGlyphIds])),
    [emphasizedGlyphIds, highlights],
  );
  const activeEntry = activeEntryId ? entriesById.get(activeEntryId) ?? null : null;

  const toggleEntryEmphasis = useCallback(
    (entryId: string) => {
      const isEmphasized = emphasizedEntries.includes(entryId);
      setEmphasizedEntries((current) =>
        isEmphasized ? current.filter((id) => id !== entryId) : [...current, entryId],
      );
      showToast(isEmphasized ? "已撤回整条划线和高亮" : "已整条划线并高亮");
    },
    [emphasizedEntries, setEmphasizedEntries, showToast],
  );

  const openAnnotation = useCallback(
    (entry: EntryBlock) => {
      setFloatingNoteEntryId(null);
      setActiveEntryId(entry.id);
      setNoteDraft(notes[entry.id] ?? "");
    },
    [notes],
  );

  const closeAnnotation = useCallback(() => {
    setActiveEntryId(null);
    setNoteDraft("");
  }, []);

  const saveAnnotation = useCallback(() => {
    if (!activeEntryId || !noteDraft.trim()) return;
    setNotes((existing) => ({ ...existing, [activeEntryId]: noteDraft.trim() }));
    closeAnnotation();
    showToast("批注已保存，条目下方已加下划线");
  }, [activeEntryId, closeAnnotation, noteDraft, showToast]);

  const deleteAnnotation = useCallback(() => {
    if (!activeEntryId) return;
    setNotes((existing) => {
      const next = { ...existing };
      delete next[activeEntryId];
      return next;
    });
    setFloatingNoteEntryId(null);
    closeAnnotation();
    showToast("批注已删除");
  }, [activeEntryId, closeAnnotation, showToast]);

  const goToPage = useCallback(
    (requestedPage: number, behavior: ScrollBehavior = "smooth") => {
      const page = clampPage(requestedPage);
      setCurrentPage(page);
      setPageDraft(String(page));
      if (mode === "scroll") {
        requestAnimationFrame(() => {
          pageRefs.current[page]?.scrollIntoView({ behavior, block: "center" });
        });
      }
    },
    [mode],
  );

  const activeOutlineRoot = useMemo(() => {
    let active = OUTLINE[0];
    OUTLINE.forEach((root) => {
      if (root.page <= currentPage) active = root;
    });
    return active;
  }, [currentPage]);

  const openOutline = useCallback(() => {
    setExpandedOutlineRoots((existing) => {
      const next = new Set(existing);
      if (activeOutlineRoot) next.add(activeOutlineRoot.id);
      return next;
    });
    setOutlineOpen(true);
  }, [activeOutlineRoot]);

  const toggleOutlineGroup = useCallback(
    (id: string, level: 1 | 2) => {
      const update = level === 1 ? setExpandedOutlineRoots : setExpandedOutlineSections;
      update((existing) => {
        const next = new Set(existing);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [],
  );

  const jumpToOutlineNode = useCallback(
    (node: OutlineNode) => {
      setOutlineOpen(false);
      goToPage(node.page, "auto");

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const viewer = viewerRef.current;
          const article = pageRefs.current[node.page];
          const sheet = article?.querySelector<HTMLElement>(".page-sheet");
          if (!viewer || !sheet) return;

          const viewerRect = viewer.getBoundingClientRect();
          const sheetRect = sheet.getBoundingClientRect();
          const targetTop =
            viewer.scrollTop +
            sheetRect.top -
            viewerRect.top +
            sheetRect.height * node.y -
            viewer.clientHeight * 0.42;
          viewer.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
        });
      });
    },
    [goToPage],
  );

  const applyPageDraft = useCallback(() => {
    const parsed = Number.parseInt(pageDraft, 10);
    if (Number.isNaN(parsed)) {
      setPageDraft(String(currentPage));
      return;
    }
    goToPage(parsed);
  }, [currentPage, goToPage, pageDraft]);

  const applyHighlightBatch = useCallback((ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids));
    const existingSet = new Set(highlights);
    const newlyAdded = uniqueIds.filter((id) => !existingSet.has(id));
    if (!newlyAdded.length) return;
    setHighlights((existing) => Array.from(new Set([...existing, ...newlyAdded])));
    setHighlightHistory((history) => [...history, newlyAdded]);
  }, [highlights]);

  const addSelectionHighlight = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

    const selectedIds = Array.from(document.querySelectorAll<HTMLElement>(".ocr-glyph"))
      .filter((glyph) => {
        try {
          return selection.containsNode(glyph, true);
        } catch {
          return false;
        }
      })
      .map((glyph) => glyph.dataset.highlightId)
      .filter((id): id is string => Boolean(id));

    if (!selectedIds.length) return false;
    if (selectedIds.length > 120) {
      selection.removeAllRanges();
      showToast("选区过大，已取消高亮，请重新划选");
      return true;
    }
    applyHighlightBatch(selectedIds);
    selection.removeAllRanges();
    showToast(`已精准高亮 ${selectedIds.length} 个字`);
    return true;
  }, [applyHighlightBatch, showToast]);

  const commitPendingHighlight = useCallback(() => {
    if (!pendingSelection.length) return false;
    applyHighlightBatch(pendingSelection);
    showToast(`已精准高亮 ${pendingSelection.length} 个字`);
    setPendingSelection([]);
    return true;
  }, [applyHighlightBatch, pendingSelection, showToast]);

  const undoLastHighlight = useCallback(() => {
    if (!highlightHistory.length) {
      showToast("暂无可撤回的高亮");
      return;
    }

    const lastBatch = highlightHistory[highlightHistory.length - 1];
    const removedIds = new Set(lastBatch);
    setHighlights((existing) => existing.filter((id) => !removedIds.has(id)));
    setHighlightHistory((history) => history.slice(0, -1));
    setPendingSelection([]);
    showToast(`已撤回上一次高亮（${lastBatch.length} 个字）`);
  }, [highlightHistory, showToast]);

  const glyphAtPoint = useCallback((clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".ocr-glyph");
    return element?.dataset.highlightId ?? null;
  }, []);

  const glyphRecord = useCallback((id: string) => {
    const location = parseGlyphId(id);
    if (!location) return null;
    const glyph = ocrPages[location.page - 1]?.lines[location.line]?.glyphs[location.glyph];
    return glyph ? { ...location, glyphData: glyph } : null;
  }, [ocrPages]);

  const sameRowRange = useCallback((startId: string, currentId: string) => {
    const start = glyphRecord(startId);
    const current = glyphRecord(currentId);
    if (!start || !current || start.page !== current.page) return null;

    if (start.line === current.line) {
      const from = Math.min(start.glyph, current.glyph);
      const to = Math.max(start.glyph, current.glyph);
      return Array.from(
        { length: to - from + 1 },
        (_, offset) => `p${start.page}-l${start.line}-g${from + offset}`,
      );
    }

    const startCenterY = start.glyphData.y + start.glyphData.height / 2;
    const currentCenterY = current.glyphData.y + current.glyphData.height / 2;
    const rowTolerance = Math.max(start.glyphData.height, current.glyphData.height) * 0.62;
    if (Math.abs(startCenterY - currentCenterY) > rowTolerance) return null;

    const rowCenterY = (startCenterY + currentCenterY) / 2;
    const left = Math.min(start.glyphData.x, current.glyphData.x);
    const right = Math.max(
      start.glyphData.x + start.glyphData.width,
      current.glyphData.x + current.glyphData.width,
    );

    const page = ocrPages[start.page - 1];
    if (!page) return null;

    return page.lines
      .flatMap((line, lineIndex) =>
        line.glyphs.map((glyph, glyphIndex) => ({
          id: `p${start.page}-l${lineIndex}-g${glyphIndex}`,
          glyph,
        })),
      )
      .filter(({ glyph }) => {
        const centerY = glyph.y + glyph.height / 2;
        const centerX = glyph.x + glyph.width / 2;
        return Math.abs(centerY - rowCenterY) <= rowTolerance && centerX >= left && centerX <= right;
      })
      .sort((a, b) => a.glyph.x - b.glyph.x)
      .map(({ id }) => id);
  }, [glyphRecord, ocrPages]);

  const handleSelectionPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    const id = glyphAtPoint(event.clientX, event.clientY);
    if (!id) {
      setPendingSelection([]);
      return;
    }

    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    dragSelection.current = { pointerId: event.pointerId, startId: id, lastId: id };
    setPendingSelection([id]);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [glyphAtPoint]);

  const handleSelectionPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const activeDrag = dragSelection.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const currentId = glyphAtPoint(event.clientX, event.clientY);
    if (!currentId || currentId === activeDrag.lastId) return;
    activeDrag.lastId = currentId;

    const nextRange = sameRowRange(activeDrag.startId, currentId);
    if (nextRange?.length) {
      setPendingSelection(nextRange);
      return;
    }
  }, [glyphAtPoint, sameRowRange]);

  const handleSelectionPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const activeDrag = dragSelection.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    dragSelection.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleSelectionPointerCancel = useCallback(() => {
    dragSelection.current = null;
  }, []);

  const toggleZoomMode = useCallback(() => {
    const nextEnabled = !zoomMode;
    setZoomMode(nextEnabled);
    if (!nextEnabled) commitZoom(1);
  }, [commitZoom, zoomMode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;

      if (versionDialog) {
        if (event.key === "Escape") {
          event.preventDefault();
          setVersionDialog(null);
        }
        return;
      }

      if (event.key === "Escape" && outlineOpen) {
        event.preventDefault();
        setOutlineOpen(false);
        return;
      }

      if (event.key === "Escape" && activeEntryId) {
        event.preventDefault();
        closeAnnotation();
        return;
      }
      if (event.key === "Escape" && floatingNoteEntryId) {
        event.preventDefault();
        setFloatingNoteEntryId(null);
        return;
      }

      if (
        !isTyping &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        undoLastHighlight();
        return;
      }

      if (
        !isTyping &&
        !activeEntryId &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        if (!event.repeat) toggleZoomMode();
        return;
      }

      if (
        !isTyping &&
        interactionMode === "entry" &&
        (event.code === "Space" || event.key === " ")
      ) {
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        if (floatingNoteEntryId) {
          event.preventDefault();
          setFloatingNoteEntryId(null);
          return;
        }

        const targetedHotspot =
          document.querySelector<HTMLElement>(".entry-hotspot:hover") ??
          (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".entry-hotspot");
        const targetedEntryId = targetedHotspot?.dataset.entryId ?? hoveredEntryId;
        if (targetedEntryId) {
          event.preventDefault();
          if (notes[targetedEntryId]) setFloatingNoteEntryId(targetedEntryId);
          return;
        }
      }

      if (!isTyping && interactionMode === "entry" && event.key.toLowerCase() === "q") {
        const targetedHotspot =
          document.querySelector<HTMLElement>(".entry-hotspot:hover") ??
          (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".entry-hotspot");
        const targetedEntryId = targetedHotspot?.dataset.entryId ?? hoveredEntryId;
        const hoveredEntry = targetedEntryId ? entriesById.get(targetedEntryId) : null;
        if (hoveredEntry) {
          event.preventDefault();
          openAnnotation(hoveredEntry);
          return;
        }
      }

      if (
        !isTyping &&
        !activeEntryId &&
        interactionMode === "entry" &&
        event.key.toLowerCase() === "e"
      ) {
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        const targetedHotspot =
          document.querySelector<HTMLElement>(".entry-hotspot:hover") ??
          (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".entry-hotspot");
        const targetedEntryId = targetedHotspot?.dataset.entryId ?? hoveredEntryId;
        if (targetedEntryId && entriesById.has(targetedEntryId)) {
          event.preventDefault();
          toggleEntryEmphasis(targetedEntryId);
          return;
        }
      }

      if (!isTyping && interactionMode === "highlight" && event.key.toLowerCase() === "q") {
        if (commitPendingHighlight() || addSelectionHighlight()) {
          event.preventDefault();
          return;
        }
      }

      if (!isTyping && mode === "page" && event.key === "ArrowLeft") {
        event.preventDefault();
        goToPage(currentPage - 1);
      }
      if (!isTyping && mode === "page" && event.key === "ArrowRight") {
        event.preventDefault();
        goToPage(currentPage + 1);
      }
      if (!isTyping && zoomMode && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        commitZoom(zoomRef.current + 0.1);
      }
      if (!isTyping && zoomMode && event.key === "-") {
        event.preventDefault();
        commitZoom(zoomRef.current - 0.1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeEntryId,
    addSelectionHighlight,
    closeAnnotation,
    commitZoom,
    commitPendingHighlight,
    currentPage,
    entriesById,
    floatingNoteEntryId,
    goToPage,
    hoveredEntryId,
    interactionMode,
    mode,
    notes,
    openAnnotation,
    outlineOpen,
    toggleEntryEmphasis,
    toggleZoomMode,
    undoLastHighlight,
    versionDialog,
    zoomMode,
  ]);

  const highlightedLineSet = useMemo(() => {
    const lines = new Set<string>();
    effectiveHighlights.forEach((id) => {
      const match = /^p(\d+)-l(\d+)-g\d+$/.exec(id);
      if (match) lines.add(`p${match[1]}-l${match[2]}`);
    });
    return lines;
  }, [effectiveHighlights]);
  const focusHighlightLineSet =
    focusOnly && interactionMode === "highlight"
      ? highlightedLineSet
      : NO_FOCUS_HIGHLIGHT_LINES;
  const visibleEntryIdsByPage = useMemo(
    () =>
      entryPages.map((entries, pageIndex) => {
        if (summaryOnly) {
          return new Set(entries.filter((entry) => entry.isSummary).map((entry) => entry.id));
        }

        if (!focusOnly) {
          return new Set(
            entries
              .filter((entry) => showSummaries || !entry.isSummary)
              .map((entry) => entry.id),
          );
        }

        const pageNumber = pageIndex + 1;
        const visibleIds = new Set<string>();
        const entriesOnPage = new Map(entries.map((entry) => [entry.id, entry]));
        const parentIds = parentEntryIdsByPage[pageIndex] ?? new Map<string, string | null>();
        const targetEntries = entries.filter((entry) => {
          if (entry.isSummary) return false;
          if (interactionMode === "entry") return Boolean(notes[entry.id]);
          return entry.lineIndexes.some((lineIndex) =>
            focusHighlightLineSet.has(`p${pageNumber}-l${lineIndex}`),
          );
        });

        targetEntries.forEach((targetEntry) => {
          visibleIds.add(targetEntry.id);
          let currentEntry = targetEntry;
          const visited = new Set([targetEntry.id]);
          for (let depth = 0; depth < 8; depth += 1) {
            const parentId = parentIds.get(currentEntry.id);
            const parentEntry = parentId ? entriesOnPage.get(parentId) : null;
            if (!parentEntry || visited.has(parentEntry.id)) break;
            visibleIds.add(parentEntry.id);
            visited.add(parentEntry.id);
            currentEntry = parentEntry;
          }
        });

        if (showSummaries) {
          entries.filter((entry) => entry.isSummary).forEach((entry) => visibleIds.add(entry.id));
        }
        return visibleIds;
      }),
    [
      entryPages,
      focusOnly,
      focusHighlightLineSet,
      interactionMode,
      notes,
      parentEntryIdsByPage,
      showSummaries,
      summaryOnly,
    ],
  );
  const visibleLineIndexesByPage = useMemo(
    () =>
      entryPages.map((entries, pageIndex) => {
        const visibleIds = visibleEntryIdsByPage[pageIndex] ?? new Set<string>();
        return new Set(
          entries
            .filter((entry) => visibleIds.has(entry.id))
            .flatMap((entry) => entry.lineIndexes),
        );
      }),
    [entryPages, visibleEntryIdsByPage],
  );
  const visibleConnectorRegionsByPage = useMemo(
    () =>
      entryPages.map((entries, pageIndex) =>
        buildConnectorRevealRegions(
          entries,
          parentEntryIdsByPage[pageIndex] ?? new Map<string, string | null>(),
          visibleEntryIdsByPage[pageIndex] ?? new Set<string>(),
        ),
      ),
    [entryPages, parentEntryIdsByPage, visibleEntryIdsByPage],
  );
  const positionedHighlightsByPage = useMemo(() => {
    const result = Array.from({ length: PAGES.length }, () => [] as Array<{ id: string; glyph: OCRGlyph }>);
    effectiveHighlights.forEach((id) => {
      const location = parseGlyphId(id);
      if (!location) return;
      if (!visibleLineIndexesByPage[location.page - 1]?.has(location.line)) return;
      const glyph = ocrPages[location.page - 1]?.lines[location.line]?.glyphs[location.glyph];
      if (glyph) result[location.page - 1].push({ id, glyph });
    });
    return result;
  }, [effectiveHighlights, ocrPages, visibleLineIndexesByPage]);
  const positionedPendingByPage = useMemo(() => {
    const result = Array.from({ length: PAGES.length }, () => [] as Array<{ id: string; glyph: OCRGlyph }>);
    pendingSelection.forEach((id) => {
      const location = parseGlyphId(id);
      if (!location) return;
      if (!visibleLineIndexesByPage[location.page - 1]?.has(location.line)) return;
      const glyph = ocrPages[location.page - 1]?.lines[location.line]?.glyphs[location.glyph];
      if (glyph) result[location.page - 1].push({ id, glyph });
    });
    return result;
  }, [ocrPages, pendingSelection, visibleLineIndexesByPage]);
  const isolationActive = focusOnly || summaryOnly;
  const displayedPages = mode === "page" ? [PAGES[currentPage - 1]] : PAGES;
  const currentPageNoteCount = (entryPages[currentPage - 1] ?? []).filter((entry) =>
    Boolean(notes[entry.id]),
  ).length;

  const changeInteractionMode = (nextMode: InteractionMode) => {
    setInteractionMode(nextMode);
    setHoveredEntryId(null);
    setFloatingNoteEntryId(null);
    setPendingSelection([]);
    window.getSelection()?.removeAllRanges();
  };

  const handleWheelZoom = (event: ReactWheelEvent<HTMLElement>) => {
    if (!zoomMode || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();

    const viewer = event.currentTarget;
    const target = event.target as Element | null;
    const sheet =
      target?.closest<HTMLElement>(".page-sheet") ??
      document
        .elementsFromPoint(event.clientX, event.clientY)
        .find((element) => element.classList.contains("page-sheet")) as HTMLElement | null;
    const previousZoom = zoomRef.current;
    const limitedDelta = Math.max(-80, Math.min(80, event.deltaY));
    const nextZoom = clampZoom(previousZoom * Math.exp(-limitedDelta * 0.0016));
    if (nextZoom === previousZoom) return;

    const viewerRect = viewer.getBoundingClientRect();
    const cursorX = event.clientX - viewerRect.left;
    const cursorY = event.clientY - viewerRect.top;
    let normalizedX = 0.5;
    let normalizedY = 0.5;
    if (sheet) {
      const sheetRect = sheet.getBoundingClientRect();
      normalizedX = Math.min(1, Math.max(0, (event.clientX - sheetRect.left) / sheetRect.width));
      normalizedY = Math.min(1, Math.max(0, (event.clientY - sheetRect.top) / sheetRect.height));
    }

    zoomRef.current = nextZoom;
    wheelZoomAnchor.current = {
      viewer,
      sheet,
      clientX: event.clientX,
      clientY: event.clientY,
      cursorX,
      cursorY,
      normalizedX,
      normalizedY,
      contentX: viewer.scrollLeft + cursorX,
      contentY: viewer.scrollTop + cursorY,
      previousZoom: renderedZoomRef.current,
      nextZoom,
    };

    viewer.classList.add("wheel-zooming");
    if (wheelZoomEndTimer.current) clearTimeout(wheelZoomEndTimer.current);
    wheelZoomEndTimer.current = setTimeout(() => {
      viewer.classList.remove("wheel-zooming");
      setZoom((current) =>
        current === zoomRef.current ? current : zoomRef.current,
      );
    }, 140);

    if (wheelZoomFrame.current === null) {
      wheelZoomFrame.current = requestAnimationFrame(() => {
        wheelZoomFrame.current = null;
        const anchor = wheelZoomAnchor.current;
        if (!anchor) return;

        applyViewerZoom(anchor.viewer, anchor.nextZoom);
        renderedZoomRef.current = anchor.nextZoom;
        if (anchor.sheet?.isConnected) {
          const nextRect = anchor.sheet.getBoundingClientRect();
          const nextAnchorX = nextRect.left + nextRect.width * anchor.normalizedX;
          const nextAnchorY = nextRect.top + nextRect.height * anchor.normalizedY;
          anchor.viewer.scrollLeft += nextAnchorX - anchor.clientX;
          anchor.viewer.scrollTop += nextAnchorY - anchor.clientY;
        } else {
          const ratio = anchor.nextZoom / anchor.previousZoom;
          anchor.viewer.scrollLeft = anchor.contentX * ratio - anchor.cursorX;
          anchor.viewer.scrollTop = anchor.contentY * ratio - anchor.cursorY;
        }
        wheelZoomAnchor.current = null;
      });
    }
  };

  const clearCurrentPage = () => {
    const prefix = `p${currentPage}-`;
    setHighlights((existing) => existing.filter((id) => !id.startsWith(prefix)));
    setHighlightHistory((history) =>
      history
        .map((batch) => batch.filter((id) => !id.startsWith(prefix)))
        .filter((batch) => batch.length > 0),
    );
    setEmphasizedEntries((existing) =>
      existing.filter((entryId) => entriesById.get(entryId)?.page !== currentPage),
    );
    setPendingSelection([]);
    showToast("已清除本页高亮");
  };

  return (
    <main className="reader-shell">
      <header className="reader-toolbar" aria-label="复习工具栏">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">政</span>
          <div>
            <strong>政治图谱复习室</strong>
            <span>正文共 {PAGES.length} 页</span>
          </div>
        </div>

        <div className="toolbar-lanes">
          <div className="toolbar-row toolbar-primary-row">

        <button
          type="button"
          className={`outline-toggle ${outlineOpen ? "active" : ""}`}
          aria-expanded={outlineOpen}
          aria-controls="study-outline"
          onClick={() => (outlineOpen ? setOutlineOpen(false) : openOutline())}
        >
          <span className="outline-toggle-icon" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          大纲
        </button>

        <div className="toolbar-group version-controls" aria-label="复习版本">
          <span className="version-label">版本</span>
          <select
            className="version-select"
            aria-label="选择复习版本"
            value={activeVersionId}
            disabled={!versionsHydrated}
            onChange={(event) => selectVersion(event.target.value)}
          >
            {versions.map((version) => (
              <option value={version.id} key={version.id}>
                {version.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="version-action"
            disabled={!versionsHydrated}
            onClick={openCreateVersion}
          >
            新建
          </button>
          <button
            type="button"
            className="version-action version-delete"
            title={versions.length <= 1 ? "至少保留一个版本" : "删除当前版本"}
            disabled={!versionsHydrated || versions.length <= 1}
            onClick={() => setVersionDialog("delete")}
          >
            删除
          </button>
        </div>

        <div className="toolbar-group page-jump" aria-label="页码跳转">
          <button
            className="icon-button"
            type="button"
            aria-label="上一页"
            disabled={currentPage === 1}
            onClick={() => goToPage(currentPage - 1)}
          >
            ‹
          </button>
          <label>
            <span>第</span>
            <input
              aria-label="输入页码"
              inputMode="numeric"
              value={pageDraft}
              onChange={(event) => setPageDraft(event.target.value.replace(/\D/g, ""))}
              onBlur={applyPageDraft}
              onKeyDown={(event) => event.key === "Enter" && applyPageDraft()}
            />
            <span>/ {PAGES.length} 页</span>
          </label>
          <button
            className="icon-button"
            type="button"
            aria-label="下一页"
            disabled={currentPage === PAGES.length}
            onClick={() => goToPage(currentPage + 1)}
          >
            ›
          </button>
        </div>

        <div className="toolbar-group segmented" aria-label="翻页方式">
          <button
            type="button"
            className={mode === "scroll" ? "active" : ""}
            aria-pressed={mode === "scroll"}
            onClick={() => setMode("scroll")}
          >
            上下滑动
          </button>
          <button
            type="button"
            className={mode === "page" ? "active" : ""}
            aria-pressed={mode === "page"}
            onClick={() => setMode("page")}
          >
            左右翻页
          </button>
        </div>

        <div className="toolbar-group segmented interaction-switch" aria-label="文字操作方式">
          <button
            type="button"
            className={interactionMode === "highlight" ? "active" : ""}
            aria-pressed={interactionMode === "highlight"}
            onClick={() => changeInteractionMode("highlight")}
          >
            划词模式
          </button>
          <button
            type="button"
            className={interactionMode === "entry" ? "active" : ""}
            aria-pressed={interactionMode === "entry"}
            onClick={() => changeInteractionMode("entry")}
          >
            整体模式
          </button>
        </div>

          </div>
          <div className="toolbar-row toolbar-secondary-row">

        <AccountControls cloud={cloud} />

        <div className="toolbar-group filter-options" aria-label="内容筛选">
          <label className="filter-check">
            <input
              type="checkbox"
              checked={focusOnly}
              disabled={summaryOnly}
              onChange={(event) => {
                setFocusOnly(event.target.checked);
                if (event.target.checked) setShowSummaries(false);
                setPendingSelection([]);
              }}
            />
            <span>{interactionMode === "entry" ? "只看已批注" : "只看高亮条目"}</span>
          </label>
          <label className="filter-check">
            <input
              type="checkbox"
              checked={showSummaries}
              disabled={summaryOnly}
              onChange={(event) => setShowSummaries(event.target.checked)}
            />
            <span>显示总结</span>
          </label>
          <label className="filter-check summary-only-check">
            <input
              type="checkbox"
              checked={summaryOnly}
              onChange={(event) => {
                setSummaryOnly(event.target.checked);
                if (event.target.checked) {
                  setFocusOnly(false);
                  setPendingSelection([]);
                }
              }}
            />
            <span>仅看总结</span>
          </label>
        </div>

        <div className="toolbar-group zoom-controls">
          <button
            type="button"
            className={`zoom-toggle ${zoomMode ? "active" : ""}`}
            aria-pressed={zoomMode}
            onKeyDown={(event) => {
              if (event.code === "Space") event.preventDefault();
            }}
            onClick={(event) => {
              toggleZoomMode();
              event.currentTarget.blur();
            }}
          >
            缩放 {zoomMode ? "已开启" : "未开启"}
            <span className="zoom-shortcut" aria-label="快捷键 P">P</span>
          </button>
          <button
            className="mini-button"
            type="button"
            aria-label="缩小"
            disabled={!zoomMode || zoom <= 0.65}
            onKeyDown={(event) => {
              if (event.code === "Space") event.preventDefault();
            }}
            onClick={(event) => {
              commitZoom(zoomRef.current - 0.1);
              event.currentTarget.blur();
            }}
          >
            −
          </button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button
            className="mini-button"
            type="button"
            aria-label="放大"
            disabled={!zoomMode || zoom >= 2.5}
            onKeyDown={(event) => {
              if (event.code === "Space") event.preventDefault();
            }}
            onClick={(event) => {
              commitZoom(zoomRef.current + 0.1);
              event.currentTarget.blur();
            }}
          >
            +
          </button>
        </div>

        <div className="toolbar-group highlight-tools">
          <span className="key-hint">
            {interactionMode === "highlight" ? (
              <>
                <kbd>Q</kbd>
                划选几个字后高亮
                <span className="shortcut-divider">·</span>
                <kbd className="undo-key">⌘ Z</kbd>
                撤回
              </>
            ) : (
              <>
                <kbd>Q</kbd>
                添加批注
                <span className="shortcut-divider">·</span>
                <kbd className="entry-emphasis-key">E</kbd>
                整条划线 / 撤回
              </>
            )}
          </span>
          {interactionMode === "highlight" ? (
            <button type="button" className="clear-button" onClick={clearCurrentPage}>
              清除本页
            </button>
          ) : (
            <span className="note-count">本页 {currentPageNoteCount} 条批注</span>
          )}
        </div>
          </div>
        </div>
      </header>

      {outlineOpen && (
        <>
          <button
            type="button"
            className="outline-backdrop"
            aria-label="关闭大纲"
            onClick={() => setOutlineOpen(false)}
          />
          <aside className="outline-panel" id="study-outline" aria-label="三级复习大纲">
            <header className="outline-header">
              <div>
                <span>快速导航</span>
                <h2>全书大纲</h2>
              </div>
              <button type="button" aria-label="关闭大纲" onClick={() => setOutlineOpen(false)}>
                ×
              </button>
            </header>
            <nav className="outline-tree" aria-label="按章节与考点跳转">
              {OUTLINE.map((root) => {
                const rootExpanded = expandedOutlineRoots.has(root.id);
                const rootActive = root.id === activeOutlineRoot?.id;
                return (
                  <div className="outline-root" key={root.id}>
                    <div className={`outline-row outline-level-1 ${rootActive ? "current" : ""}`}>
                      <button
                        type="button"
                        className="outline-disclosure"
                        aria-label={rootExpanded ? "收起本章" : "展开本章"}
                        aria-expanded={rootExpanded}
                        onClick={() => toggleOutlineGroup(root.id, 1)}
                      >
                        <span aria-hidden="true">›</span>
                      </button>
                      <button type="button" className="outline-label" onClick={() => jumpToOutlineNode(root)}>
                        {root.title}
                      </button>
                      <span className="outline-page">{root.page}</span>
                    </div>
                    {rootExpanded && (
                      <div className="outline-children">
                        {(root.children ?? []).map((section) => {
                          const sectionExpanded = expandedOutlineSections.has(section.id);
                          const hasPoints = Boolean(section.children?.length);
                          return (
                            <div className="outline-section" key={section.id}>
                              <div className="outline-row outline-level-2">
                                <button
                                  type="button"
                                  className={`outline-disclosure ${hasPoints ? "" : "is-empty"}`}
                                  aria-label={sectionExpanded ? "收起考点" : "展开考点"}
                                  aria-expanded={hasPoints ? sectionExpanded : undefined}
                                  disabled={!hasPoints}
                                  onClick={() => hasPoints && toggleOutlineGroup(section.id, 2)}
                                >
                                  <span aria-hidden="true">›</span>
                                </button>
                                <button
                                  type="button"
                                  className="outline-label"
                                  onClick={() => jumpToOutlineNode(section)}
                                >
                                  {section.title}
                                </button>
                              </div>
                              {sectionExpanded && hasPoints && (
                                <div className="outline-points">
                                  {section.children?.map((point) => (
                                    <button
                                      type="button"
                                      className="outline-row outline-level-3"
                                      key={point.id}
                                      onClick={() => jumpToOutlineNode(point)}
                                    >
                                      <span className="outline-point-dot" aria-hidden="true" />
                                      <span>{point.title}</span>
                                      <small>{point.page}</small>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </nav>
            <footer className="outline-footer">一级章节 · 二级主题 · 三级考点</footer>
          </aside>
        </>
      )}

      <section
        ref={viewerRef}
        className={`reader-viewport mode-${mode} interaction-${interactionMode} ${zoomMode ? "zoom-enabled" : ""}`}
        style={
          {
            "--page-sheet-width": `${Math.round(1400 * zoom)}px`,
            "--page-sheet-max-width": `${Math.round(92 * zoom)}vw`,
          } as CSSProperties
        }
        aria-label="政治思维导图阅读区"
        onWheel={handleWheelZoom}
      >
        {mode === "page" && (
          <button
            type="button"
            className="edge-arrow edge-arrow-left"
            aria-label="上一页"
            disabled={currentPage === 1}
            onClick={() => goToPage(currentPage - 1)}
          >
            ‹
          </button>
        )}

        <div className="pages-track">
          {displayedPages.map((page) => {
            const ocr = ocrPages[page.number - 1];
            const pageEntries = entryPages[page.number - 1] ?? [];
            const visibleEntryIds = visibleEntryIdsByPage[page.number - 1] ?? new Set<string>();
            const visibleLineIndexes =
              visibleLineIndexesByPage[page.number - 1] ?? new Set<number>();
            const pageSummaryRegions = SUMMARY_REGIONS[page.number] ?? [];
            const connectorRegions =
              isolationActive && !summaryOnly
                ? visibleConnectorRegionsByPage[page.number - 1] ?? []
                : [];
            const connectorSrc = withBasePath(`/connectors/mindmap-${String(page.sourcePage).padStart(3, "0")}.png`);
            const revealRegions = isolationActive
              ? summaryOnly
                ? pageSummaryRegions
                : [
                    ...pageEntries
                      .filter((entry) => !entry.isSummary && visibleEntryIds.has(entry.id))
                      .map(expandedEntryRect),
                    ...(showSummaries ? pageSummaryRegions : []),
                  ]
              : [];
            const pageFloatingEntry = floatingNoteEntryId
              ? pageEntries.find((entry) => entry.id === floatingNoteEntryId)
              : null;
            const isRenderedPage =
              mode === "page" || Math.abs(page.number - currentPage) <= 2;
            const isInteractivePage = page.number === currentPage;
            return (
              <article
                className="page-card"
                data-page-number={page.number}
                key={page.number}
                ref={(node) => {
                  pageRefs.current[page.number] = node;
                }}
              >
                {isRenderedPage ? (
                <div
                  className={`page-sheet ${isolationActive ? "is-isolated" : ""}`}
                  style={{
                    aspectRatio: `${page.width} / ${page.height}`,
                  }}
                >
                  <img
                    src={page.src}
                    srcSet={`${page.src} ${page.width}w, ${page.sharpSrc} ${page.width * 2}w`}
                    sizes={`min(${Math.round(92 * zoom)}vw, ${Math.round(1400 * zoom)}px)`}
                    width={page.width}
                    height={page.height}
                    loading={Math.abs(page.number - currentPage) <= 1 ? "eager" : "lazy"}
                    decoding="async"
                    draggable={false}
                    alt={`考研政治命题点高清图谱正文第 ${page.number} 页`}
                  />

                  {isolationActive && (
                    <div className="focus-reveals" aria-hidden="true">
                      {connectorRegions.map((region) => (
                        <span
                          key={region.id}
                          className="focus-connector"
                          style={{
                            left: `${region.x * 100}%`,
                            top: `${region.y * 100}%`,
                            width: `${region.width * 100}%`,
                            height: `${region.height * 100}%`,
                            backgroundImage: `url(${connectorSrc})`,
                            backgroundSize: `${100 / region.width}% ${100 / region.height}%`,
                            backgroundPosition: `${(region.x / (1 - region.width)) * 100}% ${(region.y / (1 - region.height)) * 100}%`,
                          }}
                        />
                      ))}
                      {revealRegions.map((region) => (
                        <span
                          key={region.id}
                          className="focus-reveal"
                          style={{
                            left: `${region.x * 100}%`,
                            top: `${region.y * 100}%`,
                            width: `${region.width * 100}%`,
                            height: `${region.height * 100}%`,
                            backgroundImage: `url(${page.sharpSrc})`,
                            backgroundSize: `${100 / region.width}% ${100 / region.height}%`,
                            backgroundPosition: `${(region.x / (1 - region.width)) * 100}% ${(region.y / (1 - region.height)) * 100}%`,
                          }}
                        />
                      ))}
                      {!revealRegions.length && (
                        <span className="focus-empty">
                          {interactionMode === "entry" ? "本页还没有已批注条目" : "本页还没有高亮条目"}
                        </span>
                      )}
                    </div>
                  )}

                  {!isolationActive && !showSummaries && (
                    <div className="summary-masks" aria-hidden="true">
                      {pageSummaryRegions.map((region) => (
                        <span
                          key={`mask-${region.id}`}
                          style={{
                            left: `${region.x * 100}%`,
                            top: `${region.y * 100}%`,
                            width: `${region.width * 100}%`,
                            height: `${region.height * 100}%`,
                          }}
                        />
                      ))}
                    </div>
                  )}

                  <div className="persistent-highlights" aria-hidden="true">
                    {positionedHighlightsByPage[page.number - 1].map(({ id, glyph }) => (
                      <span
                        key={id}
                        style={{
                          left: `${Math.max(0, glyph.x - 0.0006) * 100}%`,
                          top: `${Math.max(0, glyph.y - 0.0007) * 100}%`,
                          width: `${(glyph.width + 0.0012) * 100}%`,
                          height: `${(glyph.height + 0.0014) * 100}%`,
                        }}
                      />
                    ))}
                  </div>

                  {isInteractivePage && (
                    <div className="selection-preview" aria-hidden="true">
                      {positionedPendingByPage[page.number - 1].map(({ id, glyph }) => (
                        <span
                          key={id}
                          style={{
                            left: `${Math.max(0, glyph.x - 0.0006) * 100}%`,
                            top: `${Math.max(0, glyph.y - 0.0007) * 100}%`,
                            width: `${(glyph.width + 0.0012) * 100}%`,
                            height: `${(glyph.height + 0.0014) * 100}%`,
                          }}
                        />
                      ))}
                    </div>
                  )}

                  <div className="entry-underlines" aria-hidden="true">
                    {pageEntries.flatMap((entry) =>
                      (notes[entry.id] || emphasizedEntrySet.has(entry.id)) &&
                      visibleEntryIds.has(entry.id)
                        ? entry.segments.map((segment, segmentIndex) => (
                            <span
                              key={`${entry.id}-underline-${segmentIndex}`}
                              style={{
                                left: `${segment.x * 100}%`,
                                top: `${(segment.y + segment.height + 0.001) * 100}%`,
                                width: `${segment.width * 100}%`,
                              }}
                            />
                          ))
                        : [],
                    )}
                  </div>

                  {isInteractivePage && ocr && (
                    <SelectableTextLayer
                      pageNumber={page.number}
                      ocr={ocr}
                      visibleLineIndexes={visibleLineIndexes}
                      onPointerDown={handleSelectionPointerDown}
                      onPointerMove={handleSelectionPointerMove}
                      onPointerUp={handleSelectionPointerUp}
                      onPointerCancel={handleSelectionPointerCancel}
                    />
                  )}

                  {isInteractivePage && interactionMode === "entry" && (
                    <div className="entry-layer" aria-label={`第 ${page.number} 页整体条目层`}>
                      {pageEntries.filter((entry) => visibleEntryIds.has(entry.id)).map((entry) => {
                        const hasNote = Boolean(notes[entry.id]);
                        const isEmphasized = emphasizedEntrySet.has(entry.id);
                        return (
                          <button
                            type="button"
                            className={`entry-hotspot ${hasNote ? "has-note" : ""} ${isEmphasized ? "is-emphasized" : ""}`}
                            data-entry-id={entry.id}
                            aria-label={`${entry.text}${hasNote ? "，已有批注，点击查看" : "，按 Q 添加批注"}${isEmphasized ? "，已整条划线和高亮，按 E 撤回" : "，按 E 整条划线和高亮"}`}
                            title={`${hasNote ? "点击查看批注；" : "按 Q 添加批注；"}${isEmphasized ? "按 E 撤回整条划线" : "按 E 整条划线"}`}
                            key={entry.id}
                            style={{
                              left: `${Math.max(0, entry.x - 0.0018) * 100}%`,
                              top: `${Math.max(0, entry.y - 0.0015) * 100}%`,
                              width: `${Math.min(1 - entry.x, entry.width + 0.0036) * 100}%`,
                              height: `${(entry.height + 0.003) * 100}%`,
                            }}
                            onMouseEnter={() => setHoveredEntryId(entry.id)}
                            onMouseLeave={() =>
                              setHoveredEntryId((current) => (current === entry.id ? null : current))
                            }
                            onFocus={() => setHoveredEntryId(entry.id)}
                            onBlur={() =>
                              setHoveredEntryId((current) => (current === entry.id ? null : current))
                            }
                            onClick={() => {
                              if (hasNote) {
                                openAnnotation(entry);
                              } else {
                                showToast("将鼠标停在条目上，按 Q 添加批注");
                              }
                            }}
                          />
                        );
                      })}
                    </div>
                  )}

                  {isInteractivePage &&
                    interactionMode === "entry" &&
                    pageFloatingEntry &&
                    notes[pageFloatingEntry.id] &&
                    visibleEntryIds.has(pageFloatingEntry.id) && (
                      <aside
                        className={`floating-note ${pageFloatingEntry.x > 0.66 ? "align-right" : ""} ${pageFloatingEntry.y > 0.72 ? "opens-upward" : ""}`}
                        role="note"
                        aria-label="条目批注预览"
                        style={{
                          left: `${
                            (pageFloatingEntry.x > 0.66
                              ? Math.min(0.97, pageFloatingEntry.x + pageFloatingEntry.width)
                              : Math.max(0.03, pageFloatingEntry.x)) * 100
                          }%`,
                          top: `${
                            (pageFloatingEntry.y > 0.72
                              ? pageFloatingEntry.y - 0.008
                              : pageFloatingEntry.y + pageFloatingEntry.height + 0.009) * 100
                          }%`,
                        }}
                      >
                        <header>
                          <strong>批注</strong>
                          <button
                            type="button"
                            aria-label="关闭批注预览"
                            onClick={() => setFloatingNoteEntryId(null)}
                          >
                            ×
                          </button>
                        </header>
                        <p>{notes[pageFloatingEntry.id]}</p>
                      </aside>
                    )}
                </div>
                ) : (
                  <div
                    className="page-sheet page-placeholder"
                    style={{ aspectRatio: `${page.width} / ${page.height}` }}
                    aria-hidden="true"
                  />
                )}
                <footer className="page-caption">
                  <span>图谱正文第 {page.number} 页</span>
                  <span>原 PDF 第 {page.sourcePage} 页</span>
                </footer>
              </article>
            );
          })}
        </div>

        {mode === "page" && (
          <button
            type="button"
            className="edge-arrow edge-arrow-right"
            aria-label="下一页"
            disabled={currentPage === PAGES.length}
            onClick={() => goToPage(currentPage + 1)}
          >
            ›
          </button>
        )}
      </section>

      {versionDialog === "create" && (
        <div
          className="version-backdrop"
          role="presentation"
          onMouseDown={() => setVersionDialog(null)}
        >
          <section
            className="version-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-version-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="version-sheet-header">
              <div>
                <span>独立复习进度</span>
                <h2 id="create-version-title">新建版本</h2>
              </div>
              <button
                type="button"
                className="sheet-close"
                aria-label="关闭"
                onClick={() => setVersionDialog(null)}
              >
                ×
              </button>
            </header>
            <p className="version-description">
              新版本从空白开始，高亮、批注和撤回记录都不会影响其他版本。
            </p>
            <label className="version-name-field">
              <span>版本名称</span>
              <input
                autoFocus
                maxLength={30}
                value={versionNameDraft}
                onChange={(event) => setVersionNameDraft(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") createVersion();
                }}
              />
            </label>
            <footer className="version-sheet-actions">
              <button
                type="button"
                className="cancel-note"
                onClick={() => setVersionDialog(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="save-note"
                disabled={!versionNameDraft.trim()}
                onClick={createVersion}
              >
                创建版本
              </button>
            </footer>
          </section>
        </div>
      )}

      {versionDialog === "delete" && activeVersion && (
        <div
          className="version-backdrop"
          role="presentation"
          onMouseDown={() => setVersionDialog(null)}
        >
          <section
            className="version-sheet version-delete-sheet"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-version-title"
            aria-describedby="delete-version-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="delete-version-icon" aria-hidden="true">−</div>
            <h2 id="delete-version-title">删除「{activeVersion.name}」？</h2>
            <p id="delete-version-description">
              这个版本里的高亮和批注会一起删除，此操作无法撤回。其他版本不会受影响。
            </p>
            <footer className="version-sheet-actions split-actions">
              <button
                type="button"
                className="cancel-note"
                onClick={() => setVersionDialog(null)}
              >
                取消
              </button>
              <button type="button" className="confirm-version-delete" onClick={deleteActiveVersion}>
                删除版本
              </button>
            </footer>
          </section>
        </div>
      )}

      {activeEntry && (
        <div className="annotation-backdrop" role="presentation" onMouseDown={closeAnnotation}>
          <section
            className="annotation-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="annotation-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="annotation-header">
              <div>
                <span className="annotation-eyebrow">整体条目 · 第 {activeEntry.page} 页</span>
                <h2 id="annotation-title">条目批注</h2>
              </div>
              <button type="button" className="sheet-close" aria-label="关闭批注" onClick={closeAnnotation}>
                ×
              </button>
            </header>
            <blockquote className="entry-preview">{activeEntry.text}</blockquote>
            <label className="note-field">
              <span>你的批注</span>
              <textarea
                autoFocus
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder="写下你的理解、易错点或补充…"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveAnnotation();
                }}
              />
            </label>
            <footer className="annotation-actions">
              {notes[activeEntry.id] && (
                <button type="button" className="delete-note" onClick={deleteAnnotation}>
                  删除批注
                </button>
              )}
              <span className="save-shortcut">⌘ Enter 保存</span>
              <button type="button" className="cancel-note" onClick={closeAnnotation}>
                取消
              </button>
              <button
                type="button"
                className="save-note"
                disabled={!noteDraft.trim()}
                onClick={saveAnnotation}
              >
                保存批注
              </button>
            </footer>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
