import type { ReviewLibraryItem } from "./study-types";

type ReviewItemSource = Pick<ReviewLibraryItem, "entryId" | "page" | "entryText" | "entryY">;

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
        typeof item.addedAt !== "string" ||
        Number.isNaN(Date.parse(item.addedAt)) ||
        typeof item.updatedAt !== "string" ||
        Number.isNaN(Date.parse(item.updatedAt))
      ) return [];
      return [[entryId, {
        entryId,
        page: item.page,
        entryText: item.entryText,
        entryY: item.entryY,
        addedAt: item.addedAt,
        updatedAt: item.updatedAt,
      } satisfies ReviewLibraryItem]];
    }),
  );
}

export function addReviewItem(
  items: Record<string, ReviewLibraryItem>,
  source: ReviewItemSource,
  timestamp: string,
) {
  if (items[source.entryId]) return items;
  return {
    ...items,
    [source.entryId]: {
      ...source,
      addedAt: timestamp,
      updatedAt: timestamp,
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
