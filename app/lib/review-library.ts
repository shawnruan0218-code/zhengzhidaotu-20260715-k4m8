import type { ReviewLibraryItem, ReviewLibraryLevel } from "./study-types";

type ReviewItemSource = Pick<ReviewLibraryItem, "entryId" | "page" | "entryText" | "entryY">;

export const REVIEW_LIBRARY_LEVELS = [1, 2, 3] as const satisfies readonly ReviewLibraryLevel[];

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeLevels(value: unknown): ReviewLibraryLevel[] {
  if (!Array.isArray(value)) return [1];
  const highest = Math.max(
    1,
    ...value.filter(
      (level): level is ReviewLibraryLevel =>
        typeof level === "number" && REVIEW_LIBRARY_LEVELS.includes(level as ReviewLibraryLevel),
    ),
  );
  return REVIEW_LIBRARY_LEVELS.filter((level) => level <= highest);
}

export function normalizeReviewItems(value: unknown): Record<string, ReviewLibraryItem> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([entryId, rawItem]) => {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return [];
      const item = rawItem as Partial<ReviewLibraryItem>;
      if (
        item.entryId !== entryId ||
        typeof item.page !== "number" ||
        !Number.isInteger(item.page) ||
        item.page < 1 ||
        typeof item.entryText !== "string" ||
        typeof item.entryY !== "number" ||
        !validTimestamp(item.addedAt) ||
        !validTimestamp(item.updatedAt)
      ) return [];
      const levels = normalizeLevels(item.levels);
      const rawAddedAtByLevel = item.addedAtByLevel && typeof item.addedAtByLevel === "object"
        ? item.addedAtByLevel
        : {};
      const addedAtByLevel = Object.fromEntries(
        levels.map((level) => {
          const levelTimestamp = rawAddedAtByLevel[level];
          return [level, validTimestamp(levelTimestamp) ? levelTimestamp : level === 1 ? item.addedAt : item.updatedAt];
        }),
      ) as Partial<Record<ReviewLibraryLevel, string>>;
      return [[entryId, {
        entryId,
        page: item.page,
        entryText: item.entryText,
        entryY: item.entryY,
        addedAt: item.addedAt,
        updatedAt: item.updatedAt,
        levels,
        addedAtByLevel,
      } satisfies ReviewLibraryItem]];
    }),
  );
}

export function addReviewItem(
  items: Record<string, ReviewLibraryItem>,
  source: ReviewItemSource,
  timestamp: string,
) {
  return addReviewItemToLevel(items, source, 1, timestamp);
}

export function addReviewItemToLevel(
  items: Record<string, ReviewLibraryItem>,
  source: ReviewItemSource,
  level: ReviewLibraryLevel,
  timestamp: string,
) {
  const current = items[source.entryId];
  if (current?.levels.includes(level)) return items;
  const levels = REVIEW_LIBRARY_LEVELS.filter((candidate) => candidate <= level);
  if (current) {
    return {
      ...items,
      [source.entryId]: {
        ...current,
        ...source,
        updatedAt: timestamp,
        levels,
        addedAtByLevel: {
          ...current.addedAtByLevel,
          ...Object.fromEntries(levels.map((candidate) => [
            candidate,
            current.addedAtByLevel[candidate] ?? timestamp,
          ])),
        },
      },
    };
  }
  return {
    ...items,
    [source.entryId]: {
      ...source,
      addedAt: timestamp,
      updatedAt: timestamp,
      levels,
      addedAtByLevel: Object.fromEntries(levels.map((candidate) => [candidate, timestamp])),
    },
  };
}

export function removeReviewItem(
  items: Record<string, ReviewLibraryItem>,
  entryId: string,
) {
  if (!items[entryId]) return items;
  const next = { ...items };
  delete next[entryId];
  return next;
}

export function removeReviewItemFromLevel(
  items: Record<string, ReviewLibraryItem>,
  entryId: string,
  level: ReviewLibraryLevel,
  timestamp: string,
) {
  const current = items[entryId];
  if (!current?.levels.includes(level)) return items;
  if (level === 1) return removeReviewItem(items, entryId);
  const levels = current.levels.filter((candidate) => candidate < level);
  const addedAtByLevel = Object.fromEntries(
    levels.flatMap((candidate) => {
      const addedAt = current.addedAtByLevel[candidate];
      return addedAt ? [[candidate, addedAt]] : [];
    }),
  ) as Partial<Record<ReviewLibraryLevel, string>>;
  return {
    ...items,
    [entryId]: {
      ...current,
      levels,
      addedAtByLevel,
      updatedAt: timestamp,
    },
  };
}
