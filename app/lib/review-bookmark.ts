import type { AnnotationRecord, ReviewLibraryLevel } from "./study-types";
import type { FiveDaySprintDay } from "./five-day-sprint";

export type ReviewBookmarkScope =
  | { type: "all" }
  | { type: "chapter"; chapterId: string }
  | { type: "sprint"; day: FiveDaySprintDay }
  | { type: "library"; level: ReviewLibraryLevel };

export type ReviewBookmark = {
  schemaVersion: 1;
  recordId: string;
  versionId: string;
  entryId: string;
  page: number;
  scope: ReviewBookmarkScope;
  createdAt: string;
  updatedAt: string;
};

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function nextBookmarkTimestamp(previous?: string): string {
  const previousTime = previous ? Date.parse(previous) : 0;
  return new Date(Math.max(Date.now(), Number.isNaN(previousTime) ? 0 : previousTime + 1)).toISOString();
}

function normalizeScope(value: unknown): ReviewBookmarkScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scope = value as Record<string, unknown>;
  if (scope.type === "all") return { type: "all" };
  if (scope.type === "chapter" && typeof scope.chapterId === "string" && scope.chapterId.length > 0) {
    return { type: "chapter", chapterId: scope.chapterId };
  }
  if (scope.type === "sprint" && [1, 2, 3, 4, 5].includes(Number(scope.day))) {
    return { type: "sprint", day: Number(scope.day) as FiveDaySprintDay };
  }
  if (scope.type === "library" && [1, 2, 3].includes(Number(scope.level))) {
    return { type: "library", level: Number(scope.level) as ReviewLibraryLevel };
  }
  return null;
}

export function normalizeReviewBookmark(value: unknown): ReviewBookmark | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const scope = normalizeScope(candidate.scope);
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.recordId !== "string" || !candidate.recordId ||
    typeof candidate.versionId !== "string" || !candidate.versionId ||
    typeof candidate.entryId !== "string" || !candidate.entryId ||
    typeof candidate.page !== "number" || !Number.isInteger(candidate.page) || candidate.page < 1 ||
    !scope ||
    !isIsoTimestamp(candidate.createdAt) ||
    !isIsoTimestamp(candidate.updatedAt)
  ) return null;
  return {
    schemaVersion: 1,
    recordId: candidate.recordId,
    versionId: candidate.versionId,
    entryId: candidate.entryId,
    page: candidate.page,
    scope,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

export function createReviewBookmark(
  record: AnnotationRecord,
  scope: ReviewBookmarkScope,
  previous: ReviewBookmark | null = null,
): ReviewBookmark {
  const updatedAt = nextBookmarkTimestamp(previous?.updatedAt);
  return {
    schemaVersion: 1,
    recordId: record.id,
    versionId: record.versionId,
    entryId: record.entryId,
    page: record.page,
    scope,
    createdAt: previous?.createdAt ?? updatedAt,
    updatedAt,
  };
}

export function findReviewBookmarkRecord(
  bookmark: ReviewBookmark,
  records: AnnotationRecord[],
): AnnotationRecord | null {
  return records.find((record) => record.id === bookmark.recordId)
    ?? records.find((record) =>
      record.versionId === bookmark.versionId && record.entryId === bookmark.entryId)
    ?? records.find((record) => record.entryId === bookmark.entryId && record.page === bookmark.page)
    ?? null;
}
