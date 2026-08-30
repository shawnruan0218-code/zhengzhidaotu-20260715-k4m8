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
import {
  AnnotationHistoryDialog,
  type MiniReviewBounds,
} from "./annotation-history-dialog";
import { BatchKnowledgeSearchPanel } from "./batch-knowledge-search-panel";
import {
  clearRememberedEntryText,
  type SelectedEntryText,
} from "./entry-highlight-text";
import { KnowledgeSearchPanel } from "./knowledge-search-panel";
import { APP_NAMESPACE, STORAGE_KEYS, VERSION_ID_PREFIX, withBasePath } from "./lib/app-config";
import {
  normalizeFiveDaySprintPlan,
  type FiveDaySprintPlan,
} from "./lib/five-day-sprint";
import { normalizeAnnotationUpdatedAt } from "./lib/annotation-sync";
import { shortcutKey } from "./lib/keyboard-shortcuts";
import type { KnowledgeEntry } from "./lib/knowledge-search";
import { removeNoteHighlightSelection } from "./lib/note-highlights";
import {
  outlinePathForLocation,
  type OutlineNode,
} from "./lib/outline-navigation";
import {
  addReviewItemToLevel,
  normalizeReviewItems,
  removeReviewItemFromLevel,
  REVIEW_LIBRARY_LEVELS,
} from "./lib/review-library";
import {
  normalizeReviewBookmark,
  type ReviewBookmark,
} from "./lib/review-bookmark";
import {
  attachLegacySummaryIds,
  buildLegacySummaryGroups,
  buildSummaryGroups,
} from "./lib/summary-entry-groups";
import {
  EPOCH_TIMESTAMP,
  nextIsoTimestamp,
  type AnnotationRecord,
  type NoteHighlightRange,
  type ReviewLibraryLevel,
  type StoredLibrary,
  type StoredSettings,
  type StudyVersion,
} from "./lib/study-types";
import { useCloudSync } from "./lib/use-cloud-sync";
import {
  clearRememberedNoteText,
  HighlightedNoteText,
  readSelectedNoteText,
  type SelectedNoteText,
} from "./note-highlight-text";
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
  legacyIds?: string[];
};

type SummaryRegion = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type LocatorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type AnnotationLocator = LocatorRect & {
  page: number;
  animationId: number;
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

function localDayKey(value: string | number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function entryPageFromId(entryId: string) {
  const match = entryId.match(/(?:^|-)p(\d+)(?:-|$)/);
  if (!match) return 0;
  const page = Number(match[1]);
  return Number.isInteger(page) ? page : 0;
}

function outlineContains(node: OutlineNode, id: string | null): boolean {
  if (!id) return false;
  return node.id === id || (node.children ?? []).some((child) => outlineContains(child, id));
}

function knowledgeFocusRect(entry: KnowledgeEntry): LocatorRect {
  const values = [entry.focusX, entry.focusY, entry.focusWidth, entry.focusHeight];
  if (values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return {
      x: entry.focusX as number,
      y: entry.focusY as number,
      width: entry.focusWidth as number,
      height: entry.focusHeight as number,
    };
  }
  return { x: entry.x, y: entry.y, width: entry.width, height: entry.height };
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
  const noteCreatedAt =
    candidate.noteCreatedAt &&
    typeof candidate.noteCreatedAt === "object" &&
    !Array.isArray(candidate.noteCreatedAt)
      ? Object.fromEntries(
          Object.entries(candidate.noteCreatedAt).filter(
            (entry): entry is [string, string] =>
              Boolean(notes[entry[0]]) &&
              typeof entry[1] === "string" &&
              !Number.isNaN(Date.parse(entry[1])),
          ),
        )
      : {};
  const noteHighlights =
    candidate.noteHighlights &&
    typeof candidate.noteHighlights === "object" &&
    !Array.isArray(candidate.noteHighlights)
      ? Object.fromEntries(
          Object.entries(candidate.noteHighlights).flatMap(([entryId, ranges]) => {
            if (!Array.isArray(ranges)) return [];
            const normalized = ranges.flatMap((range) => {
              if (!range || typeof range !== "object") return [];
              const item = range as Partial<NoteHighlightRange>;
              if (
                typeof item.start !== "number" ||
                typeof item.end !== "number" ||
                typeof item.quote !== "string" ||
                item.end <= item.start
              ) return [];
              return [{ start: item.start, end: item.end, quote: item.quote }];
            });
            return normalized.length ? [[entryId, normalized]] : [];
          }),
        )
      : {};
  const entryTextHighlights =
    candidate.entryTextHighlights &&
    typeof candidate.entryTextHighlights === "object" &&
    !Array.isArray(candidate.entryTextHighlights)
      ? Object.fromEntries(
          Object.entries(candidate.entryTextHighlights).flatMap(([entryId, ranges]) => {
            if (!Array.isArray(ranges)) return [];
            const normalized = ranges.flatMap((range) => {
              if (!range || typeof range !== "object") return [];
              const item = range as Partial<NoteHighlightRange>;
              if (
                typeof item.start !== "number" ||
                typeof item.end !== "number" ||
                typeof item.quote !== "string" ||
                item.end <= item.start
              ) return [];
              return [{ start: item.start, end: item.end, quote: item.quote }];
            });
            return normalized.length ? [[entryId, normalized]] : [];
          }),
        )
      : {};
  const reviewItems = normalizeReviewItems(candidate.reviewItems);
  const updatedAt =
    typeof candidate.updatedAt === "string" && !Number.isNaN(Date.parse(candidate.updatedAt))
      ? candidate.updatedAt
      : INITIAL_UPDATED_AT;

  return {
    id: candidate.id,
    name: candidate.name.trim() || "未命名版本",
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
    updatedAt,
    highlights: Array.isArray(candidate.highlights)
      ? candidate.highlights.filter((id): id is string => typeof id === "string")
      : [],
    notes,
    noteHighlights,
    entryTextHighlights,
    noteCreatedAt,
    annotationUpdatedAt: normalizeAnnotationUpdatedAt(
      candidate.annotationUpdatedAt,
      notes,
      noteCreatedAt,
      updatedAt,
      entryTextHighlights,
    ),
    highlightHistory: Array.isArray(candidate.highlightHistory)
      ? candidate.highlightHistory
          .filter((batch): batch is string[] => Array.isArray(batch))
          .map((batch) => batch.filter((id): id is string => typeof id === "string"))
          .filter((batch) => batch.length > 0)
      : [],
    emphasizedEntries: Array.isArray(candidate.emphasizedEntries)
      ? candidate.emphasizedEntries.filter((id): id is string => typeof id === "string")
      : [],
    reviewItems,
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
  joinWrappedNodes = true,
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

  if (joinWrappedNodes) {
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
  }

  const groups = new Map<number, number[]>();
  candidates.forEach((_, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), index]);
  });

  // A “考点” heading and its tightly attached subtitle are one logical parent node.
  // Some pages use a parenthesised subtitle, while others print a short title below it.
  if (joinWrappedNodes) {
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
  // Same-baseline colour fragments have already been joined by
  // buildEntryBlocks. A strict vertical order here avoids a non-transitive
  // comparator accidentally moving a continuation above its numbered item.
  const ordered = [...blocks].sort((left, right) => left.y - right.y || left.x - right.x);
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
    const legacyRegionBlocks = buildEntryBlocks(
      page,
      pageNumber,
      (line) => isInsideRegion(line, region),
    ).sort((left, right) => {
      const centerDelta = left.y + left.height / 2 - (right.y + right.height / 2);
      const rowTolerance = Math.max(left.height, right.height) * 0.65;
      return Math.abs(centerDelta) <= rowTolerance ? left.x - right.x : left.y - right.y;
    });
    const orderedRegionBlocks = buildEntryBlocks(
      page,
      pageNumber,
      (line) => isInsideRegion(line, region),
      false,
    ).sort((left, right) => left.y - right.y || left.x - right.x);
    const legacyEntries = buildLegacySummaryGroups(legacyRegionBlocks).map((blocks, itemIndex) =>
      combineSummaryBlocks(blocks, pageNumber, region, itemIndex + 1),
    );
    const entries = buildSummaryGroups(orderedRegionBlocks).map((blocks, itemIndex) =>
      combineSummaryBlocks(blocks, pageNumber, region, itemIndex + 1),
    );
    return attachLegacySummaryIds(entries, legacyEntries);
  });
}

function entryStorageIds(entry: EntryBlock) {
  return [entry.id, ...(entry.legacyIds ?? [])];
}

function entryHasNote(entry: EntryBlock, notes: Record<string, string>) {
  return entryStorageIds(entry).some((id) => Boolean(notes[id]));
}

function entryNoteId(entry: EntryBlock, notes: Record<string, string>) {
  return entryStorageIds(entry).find((id) => Boolean(notes[id])) ?? entry.id;
}

function entryIsEmphasized(entry: EntryBlock, emphasizedIds: Set<string>) {
  return entryStorageIds(entry).some((id) => emphasizedIds.has(id));
}

function entryHotspotRect(entry: EntryBlock, pageEntries: EntryBlock[]) {
  if (!entry.isSummary || !entry.segments.length) {
    return {
      x: Math.max(0, entry.x - 0.0018),
      y: Math.max(0, entry.y - 0.0015),
      width: Math.min(1 - entry.x, entry.width + 0.0036),
      height: entry.height + 0.003,
    };
  }

  const centers = entry.segments.map((segment) => segment.y + segment.height / 2);
  const firstCenter = Math.min(...centers);
  const lastCenter = Math.max(...centers);
  const summaryRegionKey = (candidate: EntryBlock) =>
    candidate.id.replace(/-item-\d+-l[\d-]+$/, "");
  const regionKey = summaryRegionKey(entry);
  const horizontallyOverlaps = (candidate: EntryBlock) =>
    Math.min(entry.x + entry.width, candidate.x + candidate.width) -
      Math.max(entry.x, candidate.x) > 0.01;
  const peers = pageEntries
    .filter((candidate) => candidate.isSummary && candidate.id !== entry.id)
    .filter((candidate) => summaryRegionKey(candidate) === regionKey)
    .filter(horizontallyOverlaps)
    .map((candidate) => {
      const candidateCenters = candidate.segments.map(
        (segment) => segment.y + segment.height / 2,
      );
      return {
        first: Math.min(...candidateCenters),
        last: Math.max(...candidateCenters),
      };
    });
  const previousCenter = Math.max(
    -Infinity,
    ...peers.filter((peer) => peer.last < firstCenter).map((peer) => peer.last),
  );
  const nextCenter = Math.min(
    Infinity,
    ...peers.filter((peer) => peer.first > lastCenter).map((peer) => peer.first),
  );
  const top = Number.isFinite(previousCenter)
    ? (previousCenter + firstCenter) / 2
    : Math.max(0, entry.y - 0.0005);
  const bottom = Number.isFinite(nextCenter)
    ? (lastCenter + nextCenter) / 2
    : Math.min(1, entry.y + entry.height + 0.0005);

  return {
    x: Math.max(0, entry.x - 0.001),
    y: top,
    width: Math.min(1 - entry.x, entry.width + 0.002),
    height: Math.max(0.003, bottom - top),
  };
}

function entryMarkerDepth(text: string) {
  const normalized = text.replace(/^[！!「『\s]+/, "").replace(/\s+/g, "");
  if (/^(?:考点\d*[:：]?|[一二三四五六七八九十]+[、.．])/.test(normalized)) return 0;
  if (/^\d{1,2}[.、．]/.test(normalized)) return 1;
  if (/^[（(]\d+[）)]/.test(normalized)) return 2;
  if (/^[①②③④⑤⑥⑦⑧⑨⑩]/.test(normalized)) return 3;
  return null;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the local selection fallback when clipboard permission is unavailable.
  }

  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus({ preventScroll: true });
  }
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
  const [fiveDaySprintPlan, setFiveDaySprintPlan] = useState<FiveDaySprintPlan | null>(null);
  const [reviewBookmark, setReviewBookmark] = useState<ReviewBookmark | null>(null);
  const [versionDialog, setVersionDialog] = useState<"create" | "delete" | null>(null);
  const [versionNameDraft, setVersionNameDraft] = useState("");
  const [pendingSelection, setPendingSelection] = useState<string[]>([]);
  const [focusOnly, setFocusOnly] = useState(false);
  const [showSummaries, setShowSummaries] = useState(true);
  const [summaryOnly, setSummaryOnly] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [knowledgeSearchOpen, setKnowledgeSearchOpen] = useState(false);
  const [batchKnowledgeSearchOpen, setBatchKnowledgeSearchOpen] = useState(false);
  const [annotationHistoryOpen, setAnnotationHistoryOpen] = useState(false);
  const [annotationHistoryMiniBounds, setAnnotationHistoryMiniBounds] =
    useState<(MiniReviewBounds & { viewerLeft: number }) | null>(null);
  const [knowledgeLocator, setKnowledgeLocator] = useState<
    (KnowledgeEntry & { animationId: number }) | null
  >(null);
  const [annotationLocator, setAnnotationLocator] = useState<AnnotationLocator | null>(null);
  const [pendingAnnotationJump, setPendingAnnotationJump] = useState<{
    entryId: string;
    page: number;
  } | null>(null);
  const [expandedOutlineRoots, setExpandedOutlineRoots] = useState<Set<string>>(() => new Set());
  const [expandedOutlineSections, setExpandedOutlineSections] = useState<Set<string>>(() => new Set());
  const [currentOutlineNodeId, setCurrentOutlineNodeId] = useState<string | null>(null);
  const [panKeyHeld, setPanKeyHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [hoveredEntryId, setHoveredEntryId] = useState<string | null>(null);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [floatingNoteEntryId, setFloatingNoteEntryId] = useState<string | null>(null);
  const [dockedNotePosition, setDockedNotePosition] = useState<{ left: number; top: number } | null>(null);
  const [isDockedNoteDragging, setIsDockedNoteDragging] = useState(false);
  const [noteFontScale, setNoteFontScale] = useState(0.9);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEYS.noteDisplay) ?? "null") as
        | { fontScale?: unknown }
        | null;
      if (typeof saved?.fontScale !== "number") return;
      const savedScale = Math.min(1.7, Math.max(0.9, saved.fontScale));
      queueMicrotask(() => setNoteFontScale(savedScale));
    } catch {
      // Display preference is optional and never affects stored study data.
    }
  }, []);
  const [noteDraft, setNoteDraft] = useState("");
  const [toast, setToast] = useState("");
  const viewerRef = useRef<HTMLElement | null>(null);
  const dockedNoteRef = useRef<HTMLElement | null>(null);
  const dockedNoteManuallyPositioned = useRef(false);
  const dockedNoteDrag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null>(null);
  const pageRefs = useRef<Record<number, HTMLElement | null>>({});
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knowledgeLocatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const annotationLocatorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedEntryGroup = useRef<string[]>([]);
  const pendingClipboardText = useRef<string | null>(null);
  const clipboardWriteInFlight = useRef(false);
  const panKeyHeldRef = useRef(false);
  const handleAnnotationHistoryMiniBounds = useCallback((bounds: MiniReviewBounds | null) => {
    if (!bounds) {
      setAnnotationHistoryMiniBounds(null);
      return;
    }
    const viewerLeft = Math.max(0, viewerRef.current?.getBoundingClientRect().left ?? 0);
    setAnnotationHistoryMiniBounds({ ...bounds, viewerLeft });
  }, []);
  const pagePanDrag = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startScrollLeft: number;
    startScrollTop: number;
  } | null>(null);
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
  const versionsRef = useRef(versions);
  const fiveDaySprintPlanRef = useRef(fiveDaySprintPlan);
  const reviewBookmarkRef = useRef(reviewBookmark);

  useEffect(() => {
    versionsRef.current = versions;
  }, [versions]);

  useEffect(() => {
    fiveDaySprintPlanRef.current = fiveDaySprintPlan;
  }, [fiveDaySprintPlan]);

  useEffect(() => {
    reviewBookmarkRef.current = reviewBookmark;
  }, [reviewBookmark]);

  const commitVersionsDurably = useCallback(
    (update: StudyVersion[] | ((current: StudyVersion[]) => StudyVersion[])) => {
      const current = versionsRef.current;
      const next = typeof update === "function" ? update(current) : update;
      if (next === current) return true;
      try {
        window.localStorage.setItem(
          STORAGE_KEYS.library,
          JSON.stringify({ schemaVersion: 1, versions: next } satisfies StoredLibrary),
        );
      } catch {
        setToast("本地保存失败，本次修改未提交；请不要刷新页面");
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(""), 6_000);
        return false;
      }
      versionsRef.current = next;
      setVersions(next);
      return true;
    },
    [],
  );

  const commitFiveDaySprintPlanDurably = useCallback((plan: FiveDaySprintPlan) => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.fiveDaySprint, JSON.stringify(plan));
    } catch {
      setToast("本地保存失败，五天冲刺计划未创建；原批注没有变化");
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(""), 6_000);
      return false;
    }
    fiveDaySprintPlanRef.current = plan;
    setFiveDaySprintPlan(plan);
    return true;
  }, []);

  const commitReviewBookmarkDurably = useCallback((bookmark: ReviewBookmark) => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.reviewBookmark, JSON.stringify(bookmark));
    } catch {
      setToast("本地保存失败，复习书签未标记；原批注没有变化");
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(""), 6_000);
      return false;
    }
    reviewBookmarkRef.current = bookmark;
    setReviewBookmark(bookmark);
    return true;
  }, []);

  const cloud = useCloudSync({
    versions,
    versionsRef,
    activeVersionId,
    activeVersionUpdatedAt,
    fiveDaySprintPlan,
    fiveDaySprintPlanRef,
    reviewBookmark,
    reviewBookmarkRef,
    hydrated: versionsHydrated,
    setVersions,
    setActiveVersionId,
    setActiveVersionUpdatedAt,
    setFiveDaySprintPlan,
    setReviewBookmark,
  });

  const activeVersion = versions.find((version) => version.id === activeVersionId) ?? null;
  const highlights = activeVersion?.highlights ?? [];
  const notes = activeVersion?.notes ?? {};
  const noteHighlights = activeVersion?.noteHighlights ?? {};
  const highlightHistory = activeVersion?.highlightHistory ?? [];
  const emphasizedEntries = activeVersion?.emphasizedEntries ?? [];

  const updateActiveVersion = useCallback(
    (updater: (version: StudyVersion) => StudyVersion) => {
      return commitVersionsDurably((current) =>
        current.map((version) =>
          version.id === activeVersionId
            ? { ...updater(version), updatedAt: nextIsoTimestamp(version.updatedAt) }
            : version,
        ),
      );
    },
    [activeVersionId, commitVersionsDurably],
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
    let loadedFiveDaySprintPlan: FiveDaySprintPlan | null = null;
    let loadedReviewBookmark: ReviewBookmark | null = null;

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
      loadedFiveDaySprintPlan = normalizeFiveDaySprintPlan(
        JSON.parse(window.localStorage.getItem(STORAGE_KEYS.fiveDaySprint) ?? "null"),
      );
      loadedReviewBookmark = normalizeReviewBookmark(
        JSON.parse(window.localStorage.getItem(STORAGE_KEYS.reviewBookmark) ?? "null"),
      );
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
          noteHighlights: {},
          entryTextHighlights: {},
          noteCreatedAt: {},
          annotationUpdatedAt: {},
          highlightHistory: [],
          emphasizedEntries: [],
          reviewItems: {},
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
      fiveDaySprintPlanRef.current = loadedFiveDaySprintPlan;
      reviewBookmarkRef.current = loadedReviewBookmark;
      setVersions(loadedVersions);
      setFiveDaySprintPlan(loadedFiveDaySprintPlan);
      setReviewBookmark(loadedReviewBookmark);
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
    if (!versionsHydrated) return;
    const flushLatestLibrary = () => {
      try {
        window.localStorage.setItem(
          STORAGE_KEYS.library,
          JSON.stringify({ schemaVersion: 1, versions: versionsRef.current } satisfies StoredLibrary),
        );
      } catch {
        // Critical edits are already saved synchronously. This is a final lifecycle fallback.
      }
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushLatestLibrary();
    };
    window.addEventListener("pagehide", flushLatestLibrary);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushLatestLibrary);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [versionsHydrated]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEYS.noteDisplay,
        JSON.stringify({ fontScale: noteFontScale }),
      );
    } catch {
      // Keep the current-session preference when storage is unavailable.
    }
  }, [noteFontScale]);

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
      if (knowledgeLocatorTimer.current) clearTimeout(knowledgeLocatorTimer.current);
      if (annotationLocatorTimer.current) clearTimeout(annotationLocatorTimer.current);
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

  const annotatedPageNumbers = useMemo(
    () =>
      Array.from(
        new Set(
          versions
            .flatMap((version) => Object.keys(version.notes))
            .map(entryPageFromId)
            .filter((page) => page >= 1 && page <= PAGES.length),
        ),
      ),
    [versions],
  );

  useEffect(() => {
    annotatedPageNumbers.forEach(loadOcrPage);
  }, [annotatedPageNumbers, loadOcrPage]);

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
      noteHighlights: {},
      entryTextHighlights: {},
      noteCreatedAt: {},
      annotationUpdatedAt: {},
      highlightHistory: [],
      emphasizedEntries: [],
      reviewItems: {},
    };
    clearTransientStudyState();
    if (!commitVersionsDurably((current) => [...current, nextVersion])) return;
    setActiveVersionId(nextVersion.id);
    setActiveVersionUpdatedAt((current) => nextIsoTimestamp(current));
    setVersionDialog(null);
    setVersionNameDraft("");
    showToast(`已新建并切换到「${nextVersion.name}」`);
  }, [clearTransientStudyState, commitVersionsDurably, showToast, versionNameDraft]);

  const deleteActiveVersion = useCallback(() => {
    if (!activeVersion || versions.length <= 1) return;
    const remainingVersions = versions.filter((version) => version.id !== activeVersion.id);
    cloud.markVersionDeleted(activeVersion.id);
    clearTransientStudyState();
    if (!commitVersionsDurably(remainingVersions)) return;
    setActiveVersionId(remainingVersions[0].id);
    setActiveVersionUpdatedAt((current) => nextIsoTimestamp(current));
    setVersionDialog(null);
    showToast(`已删除「${activeVersion.name}」`);
  }, [activeVersion, clearTransientStudyState, cloud, commitVersionsDurably, showToast, versions]);

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
    () => {
      const entries = new Map<string, EntryBlock>();
      entryPages.flat().forEach((entry) => {
        entryStorageIds(entry).forEach((id) => entries.set(id, entry));
      });
      return entries;
    },
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
      const entry = entriesById.get(entryId);
      if (!entry) return;
      const storageIds = new Set(entryStorageIds(entry));
      const isEmphasized = entryIsEmphasized(entry, emphasizedEntrySet);
      setEmphasizedEntries((current) =>
        isEmphasized
          ? current.filter((id) => !storageIds.has(id))
          : [...current.filter((id) => !storageIds.has(id)), entry.id],
      );
      showToast(isEmphasized ? "已撤回整条划线和高亮" : "已整条划线并高亮");
    },
    [emphasizedEntrySet, entriesById, setEmphasizedEntries, showToast],
  );

  const queueClipboardWrite = useCallback(
    (text: string) => {
      pendingClipboardText.current = text;
      if (clipboardWriteInFlight.current) return;

      clipboardWriteInFlight.current = true;
      void (async () => {
        try {
          while (pendingClipboardText.current !== null) {
            const latestText = pendingClipboardText.current;
            pendingClipboardText.current = null;
            const copied = await copyTextToClipboard(latestText);
            if (!copied) {
              pendingClipboardText.current = null;
              showToast("复制失败，请检查剪贴板权限");
              return;
            }
          }
        } finally {
          clipboardWriteInFlight.current = false;
          if (pendingClipboardText.current !== null) {
            queueMicrotask(() => queueClipboardWrite(pendingClipboardText.current ?? ""));
          }
        }
      })();
    },
    [showToast],
  );

  const startEntryCopyGroup = useCallback(
    (entry: EntryBlock) => {
      const text = entry.text.trim();
      if (!text) return;
      copiedEntryGroup.current = [entry.id];
      queueClipboardWrite(text);
      showToast("已开始新复制组：当前 1 个条目");
    },
    [queueClipboardWrite, showToast],
  );

  const appendEntryToCopyGroup = useCallback(
    (entry: EntryBlock) => {
      if (!copiedEntryGroup.current.length) {
        showToast("请先悬停一个条目并按 W 开始复制组");
        return;
      }

      const nextEntryIds = copiedEntryGroup.current.includes(entry.id)
        ? copiedEntryGroup.current
        : [...copiedEntryGroup.current, entry.id];
      const text = nextEntryIds
        .map((entryId) => entriesById.get(entryId)?.text.trim() ?? "")
        .filter(Boolean)
        .join("\n\n");
      if (!text) return;

      copiedEntryGroup.current = nextEntryIds;
      queueClipboardWrite(text);
      showToast(`已复制组合内容：共 ${nextEntryIds.length} 个条目`);
    },
    [entriesById, queueClipboardWrite, showToast],
  );

  const openAnnotation = useCallback(
    (entry: EntryBlock) => {
      setFloatingNoteEntryId(null);
      const noteId = entryNoteId(entry, notes);
      setActiveEntryId(noteId);
      setNoteDraft(notes[noteId] ?? "");
    },
    [notes],
  );

  const closeAnnotation = useCallback(() => {
    setActiveEntryId(null);
    setNoteDraft("");
  }, []);

  const saveAnnotation = useCallback(() => {
    if (!activeEntryId || !noteDraft.trim()) return;
    const savedAt = new Date().toISOString();
    const committed = updateActiveVersion((version) => {
      const alreadyExists = Boolean(version.notes[activeEntryId]);
      const annotationUpdatedAt = nextIsoTimestamp(
        version.annotationUpdatedAt[activeEntryId] ?? version.updatedAt,
      );
      return {
        ...version,
        notes: { ...version.notes, [activeEntryId]: noteDraft.trim() },
        noteCreatedAt:
          alreadyExists || version.noteCreatedAt[activeEntryId]
            ? version.noteCreatedAt
            : { ...version.noteCreatedAt, [activeEntryId]: savedAt },
        annotationUpdatedAt: {
          ...version.annotationUpdatedAt,
          [activeEntryId]: annotationUpdatedAt,
        },
      };
    });
    if (!committed) return;
    closeAnnotation();
    showToast("批注已保存");
  }, [activeEntryId, closeAnnotation, noteDraft, showToast, updateActiveVersion]);

  const deleteAnnotation = useCallback(() => {
    if (!activeEntryId) return;
    const committed = updateActiveVersion((version) => {
      const annotationUpdatedAt = nextIsoTimestamp(
        version.annotationUpdatedAt[activeEntryId] ?? version.updatedAt,
      );
      const nextNotes = { ...version.notes };
      const nextNoteCreatedAt = { ...version.noteCreatedAt };
      const nextNoteHighlights = { ...version.noteHighlights };
      delete nextNotes[activeEntryId];
      delete nextNoteCreatedAt[activeEntryId];
      delete nextNoteHighlights[activeEntryId];
      return {
        ...version,
        notes: nextNotes,
        noteCreatedAt: nextNoteCreatedAt,
        noteHighlights: nextNoteHighlights,
        annotationUpdatedAt: {
          ...version.annotationUpdatedAt,
          [activeEntryId]: annotationUpdatedAt,
        },
      };
    });
    if (!committed) return;
    setFloatingNoteEntryId(null);
    closeAnnotation();
    showToast("批注已删除");
  }, [activeEntryId, closeAnnotation, showToast, updateActiveVersion]);

  const addNoteTextHighlight = useCallback(
    (selection: SelectedNoteText) => {
      const committed = commitVersionsDurably((current) =>
        current.map((version) => {
          if (version.id !== selection.versionId || !version.notes[selection.entryId]) {
            return version;
          }
          const existing = version.noteHighlights[selection.entryId] ?? [];
          if (
            existing.some(
              (range) => range.start === selection.start && range.end === selection.end,
            )
          ) {
            return version;
          }
          const updatedAt = nextIsoTimestamp(
            version.annotationUpdatedAt[selection.entryId] ?? version.updatedAt,
          );
          return {
            ...version,
            noteHighlights: {
              ...version.noteHighlights,
              [selection.entryId]: [
                ...existing,
                {
                  start: selection.start,
                  end: selection.end,
                  quote: selection.quote,
                },
              ],
            },
            annotationUpdatedAt: {
              ...version.annotationUpdatedAt,
              [selection.entryId]: updatedAt,
            },
            updatedAt,
          };
        }),
      );
      if (!committed) return;
      window.getSelection()?.removeAllRanges();
      clearRememberedNoteText();
      showToast("已高亮批注中的选中文字");
    },
    [commitVersionsDurably, showToast],
  );

  const removeSelectedNoteTextHighlight = useCallback(
    (selection: SelectedNoteText) => {
      const selectedVersion = versions.find((version) => version.id === selection.versionId);
      const preview = selectedVersion?.notes[selection.entryId]
        ? removeNoteHighlightSelection(
            selectedVersion.notes[selection.entryId],
            selectedVersion.noteHighlights[selection.entryId] ?? [],
            selection,
          )
        : null;
      const committed = commitVersionsDurably((current) =>
        current.map((version) => {
          if (version.id !== selection.versionId || !version.notes[selection.entryId]) {
            return version;
          }
          const result = removeNoteHighlightSelection(
            version.notes[selection.entryId],
            version.noteHighlights[selection.entryId] ?? [],
            selection,
          );
          if (!result.changed) return version;
          const nextNoteHighlights = { ...version.noteHighlights };
          if (result.ranges.length) nextNoteHighlights[selection.entryId] = result.ranges;
          else delete nextNoteHighlights[selection.entryId];
          const updatedAt = nextIsoTimestamp(
            version.annotationUpdatedAt[selection.entryId] ?? version.updatedAt,
          );
          return {
            ...version,
            noteHighlights: nextNoteHighlights,
            annotationUpdatedAt: {
              ...version.annotationUpdatedAt,
              [selection.entryId]: updatedAt,
            },
            updatedAt,
          };
        }),
      );
      if (!committed) return;
      window.getSelection()?.removeAllRanges();
      clearRememberedNoteText();
      showToast(preview?.changed ? "已取消选中文字的批注高亮" : "选中文字没有高亮");
    },
    [commitVersionsDurably, showToast, versions],
  );

  const addEntryTextHighlight = useCallback(
    (selection: SelectedEntryText) => {
      const selectedVersion = versions.find((version) => version.id === selection.versionId);
      const changed = Boolean(selectedVersion) && !(selectedVersion?.entryTextHighlights[selection.entryId] ?? [])
        .some((range) => range.start === selection.start && range.end === selection.end);
      const committed = commitVersionsDurably((current) =>
        current.map((version) => {
          if (version.id !== selection.versionId) return version;
          const existing = version.entryTextHighlights[selection.entryId] ?? [];
          if (existing.some((range) => range.start === selection.start && range.end === selection.end)) {
            return version;
          }
          const updatedAt = nextIsoTimestamp(
            version.annotationUpdatedAt[selection.entryId] ?? version.updatedAt,
          );
          return {
            ...version,
            entryTextHighlights: {
              ...version.entryTextHighlights,
              [selection.entryId]: [
                ...existing,
                { start: selection.start, end: selection.end, quote: selection.quote },
              ],
            },
            annotationUpdatedAt: {
              ...version.annotationUpdatedAt,
              [selection.entryId]: updatedAt,
            },
            updatedAt,
          };
        }),
      );
      if (!committed) return;
      window.getSelection()?.removeAllRanges();
      clearRememberedEntryText();
      showToast(changed ? "已高亮快速复习词条中的选中文字" : "这段文字已经高亮");
    },
    [commitVersionsDurably, showToast, versions],
  );

  const removeSelectedEntryTextHighlight = useCallback(
    (selection: SelectedEntryText) => {
      const selectedVersion = versions.find((version) => version.id === selection.versionId);
      const preview = selectedVersion
        ? removeNoteHighlightSelection(
            selection.text,
            selectedVersion.entryTextHighlights[selection.entryId] ?? [],
            selection,
          )
        : null;
      const committed = commitVersionsDurably((current) =>
        current.map((version) => {
          if (version.id !== selection.versionId) return version;
          const result = removeNoteHighlightSelection(
            selection.text,
            version.entryTextHighlights[selection.entryId] ?? [],
            selection,
          );
          if (!result.changed) return version;
          const nextEntryTextHighlights = { ...version.entryTextHighlights };
          if (result.ranges.length) nextEntryTextHighlights[selection.entryId] = result.ranges;
          else delete nextEntryTextHighlights[selection.entryId];
          const updatedAt = nextIsoTimestamp(
            version.annotationUpdatedAt[selection.entryId] ?? version.updatedAt,
          );
          return {
            ...version,
            entryTextHighlights: nextEntryTextHighlights,
            annotationUpdatedAt: {
              ...version.annotationUpdatedAt,
              [selection.entryId]: updatedAt,
            },
            updatedAt,
          };
        }),
      );
      if (!committed) return;
      window.getSelection()?.removeAllRanges();
      clearRememberedEntryText();
      showToast(preview?.changed ? "已取消快速复习词条中的选中文字高亮" : "选中文字没有高亮");
    },
    [commitVersionsDurably, showToast, versions],
  );

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

  const centerPageRect = useCallback((page: number, rect: LocatorRect) => {
    const viewer = viewerRef.current;
    const article = pageRefs.current[page];
    const sheet = article?.querySelector<HTMLElement>(".page-sheet");
    if (!viewer || !sheet) return false;

    const viewerRect = viewer.getBoundingClientRect();
    const sheetRect = sheet.getBoundingClientRect();
    const targetLeft =
      viewer.scrollLeft +
      sheetRect.left -
      viewerRect.left +
      sheetRect.width * (rect.x + rect.width / 2) -
      viewer.clientWidth / 2;
    const targetTop =
      viewer.scrollTop +
      sheetRect.top -
      viewerRect.top +
      sheetRect.height * (rect.y + rect.height / 2) -
      viewer.clientHeight / 2;
    viewer.scrollTo({
      left: Math.max(0, targetLeft),
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
    return true;
  }, []);

  const revealAnnotationEntry = useCallback(
    (entry: EntryBlock) => {
      if (annotationLocatorTimer.current) clearTimeout(annotationLocatorTimer.current);
      setAnnotationLocator({
        page: entry.page,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
        animationId: Date.now(),
      });
      annotationLocatorTimer.current = setTimeout(() => setAnnotationLocator(null), 3_150);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!centerPageRect(entry.page, entry)) {
            setTimeout(() => centerPageRect(entry.page, entry), 180);
          }
        });
      });
    },
    [centerPageRect],
  );

  const jumpToAnnotation = useCallback(
    (record: AnnotationRecord, options?: { showNote?: boolean }) => {
      if (record.versionId !== activeVersionId) selectVersion(record.versionId);
      setFocusOnly(false);
      setSummaryOnly(false);
      setShowSummaries(true);
      setInteractionMode("entry");
      if (options?.showNote) setFloatingNoteEntryId(record.entryId);
      loadOcrPage(record.page);
      goToPage(record.page, "auto");

      const entry = entriesById.get(record.entryId);
      if (entry) {
        setPendingAnnotationJump(null);
        revealAnnotationEntry(entry);
      } else {
        setPendingAnnotationJump({ entryId: record.entryId, page: record.page });
      }
      showToast(`正在定位第 ${record.page} 页批注`);
    },
    [
      activeVersionId,
      entriesById,
      goToPage,
      loadOcrPage,
      revealAnnotationEntry,
      selectVersion,
      showToast,
    ],
  );

  const updateAnnotationRecord = useCallback(
    (record: AnnotationRecord, note: string) => {
      const normalized = note.trim();
      if (!normalized) return;
      const savedAt = new Date().toISOString();
      const committed = commitVersionsDurably((current) =>
        current.map((version) => {
          if (version.id !== record.versionId || version.notes[record.entryId] === normalized) return version;
          const nextRanges = (version.noteHighlights[record.entryId] ?? []).flatMap((range) => {
            if (!range.quote) return [];
            const start = normalized.indexOf(range.quote);
            return start >= 0 ? [{ start, end: start + range.quote.length, quote: range.quote }] : [];
          });
          const nextNoteHighlights = { ...version.noteHighlights };
          if (nextRanges.length) nextNoteHighlights[record.entryId] = nextRanges;
          else delete nextNoteHighlights[record.entryId];
          const updatedAt = nextIsoTimestamp(
            version.annotationUpdatedAt[record.entryId] ?? version.updatedAt,
          );
          return {
            ...version,
            notes: { ...version.notes, [record.entryId]: normalized },
            noteHighlights: nextNoteHighlights,
            noteCreatedAt: version.noteCreatedAt[record.entryId]
              ? version.noteCreatedAt
              : { ...version.noteCreatedAt, [record.entryId]: savedAt },
            annotationUpdatedAt: {
              ...version.annotationUpdatedAt,
              [record.entryId]: updatedAt,
            },
            updatedAt,
          };
        }),
      );
      if (!committed) return;
      setFloatingNoteEntryId(record.entryId);
    },
    [commitVersionsDurably],
  );

  const addAnnotationToReview = useCallback(
    (record: AnnotationRecord, level: ReviewLibraryLevel) => {
      const alreadySelected = versions.some(
        (version) => version.id === record.versionId && Boolean(version.reviewItems[record.entryId]?.levels.includes(level)),
      );
      if (alreadySelected) {
        showToast(`这条已经在复习库 ${level} 中`);
        return;
      }
      const timestamp = nextIsoTimestamp();
      if (!commitVersionsDurably((current) =>
        current.map((version) => {
          if (version.id !== record.versionId) return version;
          if (version.reviewItems[record.entryId]?.levels.includes(level)) return version;
          return {
            ...version,
            reviewItems: addReviewItemToLevel(version.reviewItems, record, level, timestamp),
            updatedAt: nextIsoTimestamp(version.updatedAt),
          };
        }),
      )) return;
      showToast(`已加入复习库 ${level}`);
    },
    [commitVersionsDurably, showToast, versions],
  );

  const removeAnnotationFromReview = useCallback(
    (record: AnnotationRecord, level: ReviewLibraryLevel) => {
      const timestamp = nextIsoTimestamp();
      if (!commitVersionsDurably((current) =>
        current.map((version) => {
          if (version.id !== record.versionId || !version.reviewItems[record.entryId]?.levels.includes(level)) return version;
          return {
            ...version,
            reviewItems: removeReviewItemFromLevel(version.reviewItems, record.entryId, level, timestamp),
            updatedAt: nextIsoTimestamp(version.updatedAt),
          };
        }),
      )) return;
      showToast(level === 1 ? "已移出全部复习库，原批注保持不变" : `已移出复习库 ${level} 及后续层级，原批注保持不变`);
    },
    [commitVersionsDurably, showToast],
  );

  useEffect(() => {
    if (!pendingAnnotationJump) return;
    const entry = entriesById.get(pendingAnnotationJump.entryId);
    if (!entry) return;
    queueMicrotask(() => {
      revealAnnotationEntry(entry);
      setPendingAnnotationJump(null);
    });
  }, [entriesById, pendingAnnotationJump, revealAnnotationEntry]);

  const locateKnowledgeEntry = useCallback(
    (entry: KnowledgeEntry) => {
      setFocusOnly(false);
      setSummaryOnly(false);
      setShowSummaries(true);
      loadOcrPage(entry.page);
      goToPage(entry.page, "auto");

      if (knowledgeLocatorTimer.current) clearTimeout(knowledgeLocatorTimer.current);
      setKnowledgeLocator({ ...entry, animationId: Date.now() });
      knowledgeLocatorTimer.current = setTimeout(() => setKnowledgeLocator(null), 3_150);

      const centerTarget = () => {
        return centerPageRect(entry.page, entry);
      };

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!centerTarget()) setTimeout(centerTarget, 180);
        });
      });
    },
    [centerPageRect, goToPage, loadOcrPage],
  );

  const activeOutlineRoot = useMemo(() => {
    let active = OUTLINE[0];
    OUTLINE.forEach((root) => {
      if (root.page <= currentPage) active = root;
    });
    return active;
  }, [currentPage]);

  const openOutline = useCallback(() => {
    const viewer = viewerRef.current;
    const sheet = pageRefs.current[currentPage]?.querySelector<HTMLElement>(".page-sheet");
    const viewerRect = viewer?.getBoundingClientRect();
    const sheetRect = sheet?.getBoundingClientRect();
    const currentY =
      viewerRect && sheetRect && sheetRect.height
        ? Math.min(1, Math.max(0, (viewerRect.top + viewerRect.height * 0.46 - sheetRect.top) / sheetRect.height))
        : 0;
    const currentPath = outlinePathForLocation(OUTLINE, currentPage, currentY);
    const rootId = currentPath[0]?.id ?? activeOutlineRoot?.id;
    const sectionId = currentPath[1]?.id;
    const currentId = currentPath.at(-1)?.id ?? rootId ?? null;
    setCurrentOutlineNodeId(currentId);
    setExpandedOutlineRoots((existing) => {
      const next = new Set(existing);
      if (rootId) next.add(rootId);
      return next;
    });
    if (sectionId) {
      setExpandedOutlineSections((existing) => new Set(existing).add(sectionId));
    }
    setOutlineOpen(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const tree = document.querySelector<HTMLElement>(".outline-tree");
        const row = currentId
          ? document.querySelector<HTMLElement>(`.outline-row[data-outline-id="${currentId}"]`)
          : null;
        if (!tree || !row) return;
        const treeRect = tree.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        tree.scrollTo({
          top: Math.max(
            0,
            tree.scrollTop + rowRect.top - treeRect.top - tree.clientHeight / 2 + rowRect.height / 2,
          ),
          behavior: "smooth",
        });
      });
    });
  }, [activeOutlineRoot, currentPage]);

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
    const releasePanKey = () => {
      const activePan = pagePanDrag.current;
      if (activePan && viewerRef.current?.hasPointerCapture(activePan.pointerId)) {
        viewerRef.current.releasePointerCapture(activePan.pointerId);
      }
      panKeyHeldRef.current = false;
      pagePanDrag.current = null;
      setPanKeyHeld(false);
      setIsPanning(false);
    };

    const handlePanKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (
        !zoomMode ||
        isTyping ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.toLowerCase() !== "r"
      ) {
        return;
      }

      event.preventDefault();
      if (panKeyHeldRef.current) return;
      panKeyHeldRef.current = true;
      setPanKeyHeld(true);
      window.getSelection()?.removeAllRanges();
      setPendingSelection([]);
    };

    const handlePanKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "r") releasePanKey();
    };

    window.addEventListener("keydown", handlePanKeyDown);
    window.addEventListener("keyup", handlePanKeyUp);
    window.addEventListener("blur", releasePanKey);
    if (!zoomMode) releasePanKey();
    return () => {
      window.removeEventListener("keydown", handlePanKeyDown);
      window.removeEventListener("keyup", handlePanKeyUp);
      window.removeEventListener("blur", releasePanKey);
    };
  }, [zoomMode]);

  const handlePagePanPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!zoomMode || !panKeyHeldRef.current || event.pointerType !== "mouse" || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    setPendingSelection([]);
    pagePanDrag.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: event.currentTarget.scrollLeft,
      startScrollTop: event.currentTarget.scrollTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  }, [zoomMode]);

  const handlePagePanPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const activePan = pagePanDrag.current;
    if (!activePan || activePan.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.scrollLeft =
      activePan.startScrollLeft - (event.clientX - activePan.startClientX);
    event.currentTarget.scrollTop =
      activePan.startScrollTop - (event.clientY - activePan.startClientY);
  }, []);

  const finishPagePan = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const activePan = pagePanDrag.current;
    if (!activePan || activePan.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    pagePanDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsPanning(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const shortcut = shortcutKey(event);
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

      const isBatchToggle =
        !isTyping &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "b";

      if (isBatchToggle) {
        event.preventDefault();
        if (!event.repeat) {
          setFloatingNoteEntryId(null);
          setOutlineOpen(false);
          setKnowledgeSearchOpen(false);
          setBatchKnowledgeSearchOpen((current) => !current);
        }
        return;
      }

      if (annotationHistoryOpen) {
        const isHistoryToggle =
          !isTyping &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          (
            shortcut === "h" ||
            event.key === "·" ||
            (event.code === "Backquote" && !event.shiftKey)
          );
        if (event.key === "Escape" || isHistoryToggle) {
          event.preventDefault();
          setAnnotationHistoryOpen(false);
          return;
        }
        const isOutsideEntryNotePreview =
          !isTyping &&
          interactionMode === "entry" &&
          (event.code === "Space" || event.key === " ");
        const isMainPageEntryShortcut =
          !isTyping &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          interactionMode === "entry" &&
          (shortcut === "q" || shortcut === "e") &&
          Boolean(
            document.querySelector<HTMLElement>(".entry-hotspot:hover") ?? hoveredEntryId,
          );
        if (!isOutsideEntryNotePreview && !isMainPageEntryShortcut) return;
      }

      if (
        !isTyping &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (shortcut === "d" || shortcut === "f")
      ) {
        const selectedNote = readSelectedNoteText();
        if (selectedNote) {
          event.preventDefault();
          if (shortcut === "d") addNoteTextHighlight(selectedNote);
          else removeSelectedNoteTextHighlight(selectedNote);
          return;
        }
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
        !activeEntryId &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "a" &&
        !document.querySelector(".account-sheet, .knowledge-sheet")
      ) {
        event.preventDefault();
        if (!event.repeat) {
          setFloatingNoteEntryId(null);
          setOutlineOpen(false);
          setBatchKnowledgeSearchOpen(false);
          setKnowledgeSearchOpen(true);
        }
        return;
      }

      if (
        !isTyping &&
        !activeEntryId &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (
          event.key.toLowerCase() === "h" ||
          event.key === "·" ||
          (event.code === "Backquote" && !event.shiftKey)
        ) &&
        !document.querySelector(".account-sheet, .knowledge-sheet")
      ) {
        event.preventDefault();
        if (!event.repeat) {
          setFloatingNoteEntryId(null);
          setOutlineOpen(false);
          setAnnotationHistoryOpen((current) => !current);
        }
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
          const targetedEntry = entriesById.get(targetedEntryId);
          if (targetedEntry && entryHasNote(targetedEntry, notes)) {
            setFloatingNoteEntryId(entryNoteId(targetedEntry, notes));
          }
          return;
        }
      }

      if (!isTyping && interactionMode === "entry" && shortcut === "q") {
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
        shortcut === "e"
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

      if (
        !isTyping &&
        !activeEntryId &&
        interactionMode === "entry" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "w"
      ) {
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        const targetedHotspot =
          document.querySelector<HTMLElement>(".entry-hotspot:hover") ??
          (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".entry-hotspot");
        const targetedEntryId = targetedHotspot?.dataset.entryId ?? hoveredEntryId;
        const targetedEntry = targetedEntryId ? entriesById.get(targetedEntryId) : null;
        if (targetedEntry) {
          event.preventDefault();
          void startEntryCopyGroup(targetedEntry);
          return;
        }
      }

      if (
        !isTyping &&
        !activeEntryId &&
        interactionMode === "entry" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key === "1"
      ) {
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        const targetedHotspot =
          document.querySelector<HTMLElement>(".entry-hotspot:hover") ??
          (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".entry-hotspot");
        const targetedEntryId = targetedHotspot?.dataset.entryId ?? hoveredEntryId;
        const targetedEntry = targetedEntryId ? entriesById.get(targetedEntryId) : null;
        if (targetedEntry) {
          event.preventDefault();
          void appendEntryToCopyGroup(targetedEntry);
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
    addNoteTextHighlight,
    addSelectionHighlight,
    annotationHistoryOpen,
    closeAnnotation,
    commitZoom,
    commitPendingHighlight,
    appendEntryToCopyGroup,
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
    removeSelectedNoteTextHighlight,
    startEntryCopyGroup,
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
          if (interactionMode === "entry") {
            return entryHasNote(entry, notes) || entryIsEmphasized(entry, emphasizedEntrySet);
          }
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
      emphasizedEntrySet,
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
    entryHasNote(entry, notes),
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

  const annotationStats = useMemo(() => {
    const todayKey = localDayKey(new Date());
    return versions.reduce(
      (stats, version) => {
        const noteIds = Object.keys(version.notes);
        stats.total += noteIds.length;
        stats.today += noteIds.filter(
          (entryId) => localDayKey(version.noteCreatedAt[entryId] ?? "") === todayKey,
        ).length;
        return stats;
      },
      { today: 0, total: 0 },
    );
  }, [versions]);

  const annotationRecords = useMemo(
    () =>
      versions
        .flatMap((version) =>
          Object.entries(version.notes).flatMap(([entryId, note]) => {
            const entry = entriesById.get(entryId);
            const page = entry?.page ?? entryPageFromId(entryId);
            if (!page) return [];
            return [{
              id: `${version.id}::${entryId}`,
              versionId: version.id,
              versionName: version.name,
              entryId,
              page,
              entryText: entry?.text.trim() || `第 ${page} 页批注条目`,
              note,
              noteHighlights: version.noteHighlights[entryId] ?? [],
              entryTextHighlights: version.entryTextHighlights[entryId] ?? [],
              entryY: entry?.y ?? 0,
              outlinePath: outlinePathForLocation(OUTLINE, page, entry?.y ?? 0),
              createdAt: version.noteCreatedAt[entryId] ?? null,
            } satisfies AnnotationRecord];
          }),
        )
        .sort((left, right) =>
          (right.createdAt ?? "").localeCompare(left.createdAt ?? ""),
        ),
    [entriesById, versions],
  );
  const reviewRecordsByLevel = useMemo(
    () => Object.fromEntries(
      REVIEW_LIBRARY_LEVELS.map((level) => [
        level,
        versions
          .flatMap((version) =>
            Object.values(version.reviewItems).flatMap((item) => {
              if (!item.levels.includes(level)) return [];
              const entry = entriesById.get(item.entryId);
              return [{
                id: `${version.id}::${item.entryId}`,
                versionId: version.id,
                versionName: version.name,
                entryId: item.entryId,
                page: entry?.page ?? item.page,
                entryText: entry?.text.trim() || item.entryText,
                note: version.notes[item.entryId] ?? "",
                noteHighlights: version.noteHighlights[item.entryId] ?? [],
                entryTextHighlights: version.entryTextHighlights[item.entryId] ?? [],
                entryY: entry?.y ?? item.entryY,
                outlinePath: outlinePathForLocation(
                  OUTLINE,
                  entry?.page ?? item.page,
                  entry?.y ?? item.entryY,
                ),
                createdAt: item.addedAtByLevel[level] ?? item.addedAt,
              } satisfies AnnotationRecord];
            }),
          )
          .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? "")),
      ]),
    ) as Record<ReviewLibraryLevel, AnnotationRecord[]>,
    [entriesById, versions],
  );

  const floatingNoteEntry = floatingNoteEntryId
    ? entriesById.get(floatingNoteEntryId) ?? null
    : null;
  const floatingNoteStorageId = floatingNoteEntry
    ? entryNoteId(floatingNoteEntry, notes)
    : null;
  const dockedNoteText = floatingNoteStorageId ? notes[floatingNoteStorageId] : null;
  const naturalDockedNoteWidth = dockedNoteText
    ? Math.min(760, Math.max(340, 300 + Math.sqrt(dockedNoteText.length) * 28))
    : 0;
  const viewerLeft = annotationHistoryMiniBounds?.viewerLeft ?? 0;
  const dockedNoteWidth = annotationHistoryMiniBounds
    ? Math.min(
        naturalDockedNoteWidth,
        Math.max(280, annotationHistoryMiniBounds.left - viewerLeft - 48),
      )
    : naturalDockedNoteWidth;
  const dockedNoteLeft = annotationHistoryMiniBounds
    ? Math.max(
        viewerLeft + 16,
        viewerLeft + (annotationHistoryMiniBounds.left - viewerLeft - dockedNoteWidth) / 2,
      )
    : 16;
  const showDockedHistoryNote = Boolean(
    annotationHistoryOpen &&
    annotationHistoryMiniBounds &&
    floatingNoteStorageId &&
    dockedNoteText,
  );

  useEffect(() => {
    dockedNoteManuallyPositioned.current = false;
    dockedNoteDrag.current = null;
    queueMicrotask(() => {
      setIsDockedNoteDragging(false);
      setDockedNotePosition(null);
    });
  }, [floatingNoteEntryId]);

  useEffect(() => {
    if (!annotationLocator) return;
    dockedNoteManuallyPositioned.current = false;
    queueMicrotask(() => setDockedNotePosition(null));
  }, [annotationLocator?.animationId]);

  useEffect(() => {
    if (!showDockedHistoryNote || !annotationHistoryMiniBounds) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let frame = 0;
    const placeNote = () => {
      if (dockedNoteManuallyPositioned.current) return;
      const note = dockedNoteRef.current;
      if (!note) return;
      const noteRect = note.getBoundingClientRect();
      const locator = document.querySelector<HTMLElement>(".annotation-locator");
      const persistentTargetRect = (() => {
        if (!floatingNoteEntry) return null;
        const sheet = pageRefs.current[floatingNoteEntry.page]?.querySelector<HTMLElement>(".page-sheet");
        if (!sheet) return null;
        const sheetRect = sheet.getBoundingClientRect();
        const left = sheetRect.left + sheetRect.width * Math.max(0, floatingNoteEntry.x - 0.003);
        const top = sheetRect.top + sheetRect.height * Math.max(0, floatingNoteEntry.y - 0.004);
        const width = sheetRect.width * Math.min(1 - floatingNoteEntry.x, floatingNoteEntry.width + 0.006);
        const height = sheetRect.height * Math.min(1 - floatingNoteEntry.y, floatingNoteEntry.height + 0.008);
        return { left, top, right: left + width, bottom: top + height };
      })();
      const locatorRect = locator?.getBoundingClientRect() ?? persistentTargetRect;
      const edge = 18;
      const gap = 30;
      const maximumLeft = Math.max(edge, window.innerWidth - noteRect.width - edge);
      const left = Math.min(maximumLeft, Math.max(edge, dockedNoteLeft));
      const maximumTop = Math.max(edge, window.innerHeight - noteRect.height - edge);
      let top = Math.min(maximumTop, Math.max(edge, (window.innerHeight - noteRect.height) / 2));

      if (locatorRect) {
        const horizontalOverlap =
          left < locatorRect.right + gap && left + noteRect.width > locatorRect.left - gap;
        const verticalOverlap =
          top < locatorRect.bottom + gap && top + noteRect.height > locatorRect.top - gap;
        if (horizontalOverlap && verticalOverlap) {
          const above = locatorRect.top - gap - noteRect.height;
          const below = locatorRect.bottom + gap;
          const aboveFits = above >= edge;
          const belowFits = below + noteRect.height <= window.innerHeight - edge;
          if (belowFits && (!aboveFits || window.innerHeight - locatorRect.bottom >= locatorRect.top)) {
            top = below;
          } else if (aboveFits) {
            top = above;
          } else {
            const spaceAbove = Math.max(0, locatorRect.top - edge);
            const spaceBelow = Math.max(0, window.innerHeight - edge - locatorRect.bottom);
            top = spaceBelow >= spaceAbove ? maximumTop : edge;
          }
        }
      }
      setDockedNotePosition((current) =>
        current && Math.abs(current.left - left) < 0.5 && Math.abs(current.top - top) < 0.5
          ? current
          : { left, top },
      );
    };

    frame = requestAnimationFrame(placeNote);
    [180, 420, 760].forEach((delay) => timers.push(setTimeout(placeNote, delay)));
    const viewer = viewerRef.current;
    window.addEventListener("resize", placeNote);
    viewer?.addEventListener("scroll", placeNote, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      window.removeEventListener("resize", placeNote);
      viewer?.removeEventListener("scroll", placeNote);
    };
  }, [
    annotationHistoryMiniBounds,
    annotationLocator?.animationId,
    dockedNoteLeft,
    dockedNoteText,
    dockedNoteWidth,
    floatingNoteEntry,
    noteFontScale,
    showDockedHistoryNote,
  ]);

  const startDockedNoteDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const note = dockedNoteRef.current;
    if (!note) return;
    const rect = note.getBoundingClientRect();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dockedNoteManuallyPositioned.current = true;
    dockedNoteDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    setIsDockedNoteDragging(true);
    setDockedNotePosition({ left: rect.left, top: rect.top });
  }, []);

  const moveDockedNote = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dockedNoteDrag.current;
    const note = dockedNoteRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !note) return;
    const rect = note.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, window.innerWidth - rect.width - 8),
      Math.max(8, drag.left + event.clientX - drag.startX),
    );
    const top = Math.min(
      Math.max(8, window.innerHeight - rect.height - 8),
      Math.max(8, drag.top + event.clientY - drag.startY),
    );
    setDockedNotePosition({ left, top });
  }, []);

  const stopDockedNoteDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dockedNoteDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dockedNoteDrag.current = null;
    setIsDockedNoteDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <main className="reader-shell">
      <header className="reader-toolbar" aria-label="复习工具栏">
        <AccountControls
          cloud={cloud}
          annotationStats={annotationStats}
          annotationRecords={annotationRecords}
          onJumpToAnnotation={jumpToAnnotation}
        />

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

        <button
          type="button"
          className={`knowledge-toggle ${knowledgeSearchOpen ? "active" : ""}`}
          aria-haspopup="dialog"
          onClick={() => {
            setBatchKnowledgeSearchOpen(false);
            setKnowledgeSearchOpen(true);
          }}
          title="快捷键 A"
        >
          <span className="knowledge-toggle-icon" aria-hidden="true" />
          AI 检索
          <span className="knowledge-shortcut" aria-label="快捷键 A">A</span>
        </button>

        <button
          type="button"
          className={`knowledge-toggle knowledge-batch-toggle ${batchKnowledgeSearchOpen ? "active" : ""}`}
          aria-haspopup="dialog"
          onClick={() => {
            setKnowledgeSearchOpen(false);
            setBatchKnowledgeSearchOpen(true);
          }}
          title="快捷键 B"
        >
          <span className="knowledge-batch-toggle-icon" aria-hidden="true">≋</span>
          增强检索
          <span className="knowledge-shortcut" aria-label="快捷键 B">B</span>
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
            title={zoomMode ? "按住 R 并拖动鼠标可平移页面；快捷键 P 关闭缩放" : "快捷键 P 开启缩放"}
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
                const rootActive = currentOutlineNodeId
                  ? outlineContains(root, currentOutlineNodeId)
                  : root.id === activeOutlineRoot?.id;
                return (
                  <div className="outline-root" key={root.id}>
                    <div data-outline-id={root.id} className={`outline-row outline-level-1 ${rootActive || root.id === currentOutlineNodeId ? "current" : ""}`}>
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
                              <div data-outline-id={section.id} className={`outline-row outline-level-2 ${outlineContains(section, currentOutlineNodeId) ? "current" : ""}`}>
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
                                      data-outline-id={point.id}
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

      <KnowledgeSearchPanel
        open={knowledgeSearchOpen}
        onClose={() => setKnowledgeSearchOpen(false)}
        onLocate={locateKnowledgeEntry}
      />

      <BatchKnowledgeSearchPanel
        open={batchKnowledgeSearchOpen}
        onClose={() => setBatchKnowledgeSearchOpen(false)}
        onLocate={locateKnowledgeEntry}
      />

      <AnnotationHistoryDialog
        open={annotationHistoryOpen}
        records={annotationRecords}
        reviewRecordsByLevel={reviewRecordsByLevel}
        fiveDaySprintPlan={fiveDaySprintPlan}
        onCreateFiveDaySprintPlan={commitFiveDaySprintPlanDurably}
        reviewBookmark={reviewBookmark}
        onSaveReviewBookmark={commitReviewBookmarkDurably}
        currentOutlineNodeId={outlinePathForLocation(OUTLINE, currentPage, 0.46).at(-1)?.id ?? null}
        onClose={() => setAnnotationHistoryOpen(false)}
        onJump={jumpToAnnotation}
        onUpdateNote={updateAnnotationRecord}
        onAddToReview={addAnnotationToReview}
        onRemoveFromReview={removeAnnotationFromReview}
        onHighlightNote={addNoteTextHighlight}
        onRemoveNoteHighlight={removeSelectedNoteTextHighlight}
        onHighlightEntryText={addEntryTextHighlight}
        onRemoveEntryTextHighlight={removeSelectedEntryTextHighlight}
        onMiniBoundsChange={handleAnnotationHistoryMiniBounds}
        noteFontScale={noteFontScale}
        onNoteFontScaleChange={setNoteFontScale}
        outline={OUTLINE}
      />

      {showDockedHistoryNote && floatingNoteStorageId && dockedNoteText && (
        <aside
          ref={dockedNoteRef}
          className={`floating-note history-docked-note ${isDockedNoteDragging ? "is-dragging" : ""}`}
          role="note"
          aria-label="快速复习批注预览"
          style={{
            "--floating-note-width": `${dockedNoteWidth}px`,
            "--note-font-scale": noteFontScale,
            left: `${dockedNotePosition?.left ?? dockedNoteLeft}px`,
            top: `${dockedNotePosition?.top ?? 18}px`,
          } as CSSProperties}
        >
          <header onPointerDown={startDockedNoteDrag} onPointerMove={moveDockedNote} onPointerUp={stopDockedNoteDrag} onPointerCancel={stopDockedNoteDrag}>
            <strong>批注 <small>拖动可移开</small></strong>
            <button type="button" aria-label="关闭批注预览" onClick={() => setFloatingNoteEntryId(null)}>×</button>
          </header>
          <p>
            <HighlightedNoteText
              text={dockedNoteText}
              ranges={noteHighlights[floatingNoteStorageId]}
              entryId={floatingNoteStorageId}
              versionId={activeVersionId}
            />
          </p>
        </aside>
      )}

      <section
        ref={viewerRef}
        className={`reader-viewport mode-${mode} interaction-${interactionMode} ${zoomMode ? "zoom-enabled" : ""} ${panKeyHeld ? "pan-ready" : ""} ${isPanning ? "pan-dragging" : ""}`}
        style={
          {
            "--page-sheet-width": `${Math.round(1400 * zoom)}px`,
            "--page-sheet-max-width": `${Math.round(92 * zoom)}vw`,
          } as CSSProperties
        }
        aria-label="政治思维导图阅读区"
        onWheel={handleWheelZoom}
        onPointerDownCapture={handlePagePanPointerDown}
        onPointerMoveCapture={handlePagePanPointerMove}
        onPointerUpCapture={finishPagePan}
        onPointerCancelCapture={finishPagePan}
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
              ? pageEntries.find((entry) => entryStorageIds(entry).includes(floatingNoteEntryId))
              : null;
            const pageFloatingNoteId = pageFloatingEntry
              ? entryNoteId(pageFloatingEntry, notes)
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

                  {knowledgeLocator?.page === page.number && (() => {
                    const focusRect = knowledgeFocusRect(knowledgeLocator);
                    const contextPaddingX = knowledgeLocator.kind === "line" ? 0.012 : 0.004;
                    const contextPaddingY = knowledgeLocator.kind === "line" ? 0.012 : 0.005;
                    return (
                      <>
                        <span
                          key={`${knowledgeLocator.animationId}-context`}
                          className="knowledge-locator knowledge-locator-context"
                          aria-hidden="true"
                          style={{
                            left: `${Math.max(0, knowledgeLocator.x - contextPaddingX) * 100}%`,
                            top: `${Math.max(0, knowledgeLocator.y - contextPaddingY) * 100}%`,
                            width: `${Math.min(
                              1 - Math.max(0, knowledgeLocator.x - contextPaddingX),
                              knowledgeLocator.width + contextPaddingX * 2,
                            ) * 100}%`,
                            height: `${Math.min(
                              1 - Math.max(0, knowledgeLocator.y - contextPaddingY),
                              knowledgeLocator.height + contextPaddingY * 2,
                            ) * 100}%`,
                          }}
                        />
                        <span
                          key={`${knowledgeLocator.animationId}-detail`}
                          className="knowledge-locator-detail"
                          aria-hidden="true"
                          style={{
                            left: `${Math.max(0, focusRect.x - 0.0018) * 100}%`,
                            top: `${Math.max(0, focusRect.y - 0.0025) * 100}%`,
                            width: `${Math.min(1 - focusRect.x, focusRect.width + 0.0036) * 100}%`,
                            height: `${Math.min(1 - focusRect.y, focusRect.height + 0.005) * 100}%`,
                          }}
                        />
                      </>
                    );
                  })()}

                  {annotationLocator?.page === page.number && (
                    <span
                      key={annotationLocator.animationId}
                      className="annotation-locator"
                      aria-hidden="true"
                      style={{
                        left: `${Math.max(0, annotationLocator.x - 0.003) * 100}%`,
                        top: `${Math.max(0, annotationLocator.y - 0.004) * 100}%`,
                        width: `${Math.min(1 - annotationLocator.x, annotationLocator.width + 0.006) * 100}%`,
                        height: `${Math.min(1 - annotationLocator.y, annotationLocator.height + 0.008) * 100}%`,
                      }}
                    />
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
                        } as CSSProperties}
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
                        const hasNote = entryHasNote(entry, notes);
                        const isEmphasized = entryIsEmphasized(entry, emphasizedEntrySet);
                        const hotspotRect = entryHotspotRect(entry, pageEntries);
                        return (
                          <button
                            type="button"
                            className={`entry-hotspot ${hasNote ? "has-note" : ""} ${isEmphasized ? "is-emphasized" : ""}`}
                            data-entry-id={entry.id}
                            aria-label={`${entry.text}${hasNote ? "，已有批注，点击查看" : "，按 Q 添加批注"}${isEmphasized ? "，已整条划线和高亮，按 E 撤回" : "，按 E 整条划线和高亮"}，按 W 开始新复制组，按数字 1 追加到复制组`}
                            title={`${hasNote ? "点击查看批注；" : "按 Q 添加批注；"}${isEmphasized ? "按 E 撤回整条划线；" : "按 E 整条划线；"}按 W 开始新复制组；按 1 追加当前条目`}
                            key={entry.id}
                            style={{
                              left: `${hotspotRect.x * 100}%`,
                              top: `${hotspotRect.y * 100}%`,
                              width: `${hotspotRect.width * 100}%`,
                              height: `${hotspotRect.height * 100}%`,
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
                    pageFloatingNoteId &&
                    notes[pageFloatingNoteId] &&
                    !showDockedHistoryNote &&
                    visibleEntryIds.has(pageFloatingEntry.id) && (
                      <aside
                        className={`floating-note ${pageFloatingEntry.x > 0.66 ? "align-right" : ""} ${pageFloatingEntry.y > 0.72 ? "opens-upward" : ""}`}
                        role="note"
                        aria-label="条目批注预览"
                        style={{
                          "--floating-note-width": `${Math.min(
                            760,
                            Math.max(340, 300 + Math.sqrt(notes[pageFloatingNoteId].length) * 28),
                          )}px`,
                          "--note-font-scale": noteFontScale,
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
                        } as CSSProperties}
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
                        <p>
                          <HighlightedNoteText
                            text={notes[pageFloatingNoteId]}
                            ranges={noteHighlights[pageFloatingNoteId]}
                            entryId={pageFloatingNoteId}
                            versionId={activeVersionId}
                          />
                        </p>
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
        <div className={`annotation-backdrop ${annotationHistoryOpen ? "from-history" : ""}`} role="presentation" onMouseDown={closeAnnotation}>
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
              {activeEntryId && notes[activeEntryId] && (
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
