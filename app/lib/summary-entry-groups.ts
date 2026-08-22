export type SummaryGroupBlock = {
  id: string;
  text: string;
  y: number;
  height: number;
  lineIndexes: number[];
};

export type SummaryCompatibleEntry = SummaryGroupBlock & {
  legacyIds?: string[];
};

type SummarySectionMode = "numbered" | "aggregate";

const NUMBERED_MARKERS = "①②③④⑤⑥⑦⑧⑨⑩";

function normalizedText(text: string) {
  return text.replace(/\s+/g, "").replace(/^[！!「『]+/, "");
}

function sectionHeading(text: string): {
  kind: "summary" | "mistakes";
  headingOnly: boolean;
} | null {
  const normalized = normalizedText(text);
  // The red dotted border is occasionally OCR'd as a leading number or an
  // exclamation mark (for example "1 总结2："). Accept that noise here.
  const match = normalized.match(/^(?:\d{1,2})?(总结\d*|易错点)(?:（[^）]*）)?[：:]?/);
  if (!match) return null;
  return {
    kind: match[1].startsWith("总结") ? "summary" : "mistakes",
    headingOnly: normalized.slice(match[0].length).length === 0,
  };
}

function markerNumber(text: string): number | null {
  const normalized = normalizedText(text);
  const arabic = normalized.match(/^(\d{1,2})(?:[.、．]|(?=[\u4e00-\u9fff]))/);
  if (arabic) return Number(arabic[1]);
  const parenthesized = normalized.match(/^[（(](\d{1,2})[）)]/);
  if (parenthesized) return Number(parenthesized[1]);
  const circled = NUMBERED_MARKERS.indexOf(normalized[0]);
  return circled >= 0 ? circled + 1 : null;
}

function looksLikeMissingSummaryHeading(text: string, marker: number | null, previous: number | null) {
  if (marker !== 1 || previous === null || previous < 2) return false;
  const normalized = normalizedText(text);
  // A numbered definition such as "1.使用价值：……" after a completed
  // true/false list is the common layout when OCR misses the printed "总结：".
  return /[：:]/.test(normalized) && !/[（(][√✓×VX]/i.test(normalized);
}

function blockBottom<T extends SummaryGroupBlock>(group: T[] | null) {
  return group ? Math.max(...group.map((entry) => entry.y + entry.height)) : -1;
}

/**
 * The original grouping algorithm is kept so that new geometry can inherit
 * every pre-existing entry ID. Nothing stored under an old ID needs rewriting.
 */
export function buildLegacySummaryGroups<T extends SummaryGroupBlock>(blocks: T[]): T[][] {
  const groups: T[][] = [];
  let currentGroup: T[] | null = null;

  blocks.forEach((block) => {
    const normalized = block.text.replace(/\s+/g, "");
    const headingOnly = /^[！!「]?\s*(?:总结|易错点)(?:（[^）]*）)?[：:]?\s*$/.test(normalized);
    if (headingOnly) {
      currentGroup = null;
      return;
    }

    const startsNumberedItem = /^[！!「]?\s*(?:\d{1,2}[.、．]|\d{1,2}(?=[\u4e00-\u9fff])|[①②③④⑤⑥⑦⑧⑨⑩]|[（(]\d+[）)])/.test(normalized);
    const currentBottom = blockBottom(currentGroup);
    if (startsNumberedItem || !currentGroup || block.y - currentBottom > 0.028) {
      currentGroup = [block];
      groups.push(currentGroup);
    } else {
      currentGroup.push(block);
    }
  });

  return groups;
}

/**
 * Split red callout boxes by their actual section semantics:
 * - every numbered "易错点" is independent;
 * - a "总结/总结1/总结2" heading and its following numbered lines stay whole;
 * - if OCR drops the summary heading, a 3 -> 1 numbered reset with a definition
 *   colon starts the aggregate summary section.
 */
export function buildSummaryGroups<T extends SummaryGroupBlock>(blocks: T[]): T[][] {
  const groups: T[][] = [];
  let currentGroup: T[] | null = null;
  let mode: SummarySectionMode = "numbered";
  let previousMarker: number | null = null;

  blocks.forEach((block) => {
    const heading = sectionHeading(block.text);
    if (heading) {
      previousMarker = null;
      if (heading.kind === "summary") {
        mode = "aggregate";
        currentGroup = [block];
        groups.push(currentGroup);
      } else {
        mode = "numbered";
        currentGroup = heading.headingOnly ? null : [block];
        if (currentGroup) groups.push(currentGroup);
      }
      return;
    }

    const marker = markerNumber(block.text);
    const currentBottom = blockBottom(currentGroup);
    const separatedByWhitespace = currentGroup !== null && block.y - currentBottom > 0.028;

    if (mode === "numbered" && looksLikeMissingSummaryHeading(block.text, marker, previousMarker)) {
      mode = "aggregate";
      currentGroup = [block];
      groups.push(currentGroup);
      previousMarker = marker;
      return;
    }

    if (mode === "numbered" && (marker !== null || !currentGroup || separatedByWhitespace)) {
      currentGroup = [block];
      groups.push(currentGroup);
    } else if (mode === "aggregate" && (!currentGroup || separatedByWhitespace)) {
      currentGroup = [block];
      groups.push(currentGroup);
    } else {
      currentGroup?.push(block);
    }

    if (marker !== null) previousMarker = marker;
  });

  return groups;
}

function overlapCount(left: number[], right: number[]) {
  const rightSet = new Set(right);
  return left.reduce((count, value) => count + Number(rightSet.has(value)), 0);
}

/**
 * Assign each legacy entry ID to exactly one improved entry. Exact matches keep
 * their ID; split/merged entries retain aliases so old notes and emphasis data
 * remain discoverable without mutating local or cloud storage.
 */
export function attachLegacySummaryIds<T extends SummaryCompatibleEntry>(
  entries: T[],
  legacyEntries: SummaryGroupBlock[],
): T[] {
  const assigned = entries.map(() => [] as SummaryGroupBlock[]);

  legacyEntries.forEach((legacy) => {
    let bestIndex = -1;
    let bestOverlap = 0;
    let bestCoverage = -1;
    entries.forEach((entry, index) => {
      const overlap = overlapCount(legacy.lineIndexes, entry.lineIndexes);
      const coverage = overlap / Math.max(1, entry.lineIndexes.length);
      if (
        overlap > bestOverlap ||
        (overlap === bestOverlap && overlap > 0 && coverage > bestCoverage) ||
        (overlap === bestOverlap && overlap > 0 && coverage === bestCoverage &&
          (bestIndex < 0 || entry.y < entries[bestIndex].y))
      ) {
        bestIndex = index;
        bestOverlap = overlap;
        bestCoverage = coverage;
      }
    });
    if (bestIndex >= 0 && bestOverlap > 0) assigned[bestIndex].push(legacy);
  });

  return entries.map((entry, index) => {
    const aliases = assigned[index].sort((left, right) => left.y - right.y || left.id.localeCompare(right.id));
    if (!aliases.length) return entry;
    const exact = aliases.find(
      (legacy) =>
        legacy.lineIndexes.length === entry.lineIndexes.length &&
        overlapCount(legacy.lineIndexes, entry.lineIndexes) === entry.lineIndexes.length,
    );
    const primary = exact ?? aliases[0];
    return {
      ...entry,
      id: primary.id,
      legacyIds: aliases.map((legacy) => legacy.id).filter((id) => id !== primary.id),
    };
  });
}
