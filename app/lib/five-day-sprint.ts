import type { OutlineNode } from "./outline-navigation";
import type { AnnotationRecord } from "./study-types";

export const FIVE_DAY_SPRINT_DAYS = [1, 2, 3, 4, 5] as const;

export type FiveDaySprintDay = (typeof FIVE_DAY_SPRINT_DAYS)[number];

export type FiveDaySprintPlan = {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  recordDayById: Record<string, FiveDaySprintDay>;
  chapterDayById: Record<string, FiveDaySprintDay>;
};

type OutlineUnit = {
  id: string;
  order: number;
};

function flattenOutline(outline: OutlineNode[]): OutlineUnit[] {
  const units: OutlineUnit[] = [];
  const visit = (nodes: OutlineNode[]) => {
    nodes.forEach((node) => {
      units.push({ id: node.id, order: units.length });
      visit(node.children ?? []);
    });
  };
  visit(outline);
  return units;
}

function recordChapterId(record: AnnotationRecord): string | null {
  return record.outlinePath.at(-1)?.id ?? null;
}

function balancedBoundaries(weights: number[], groupCount: number): number[] {
  const itemCount = weights.length;
  if (!itemCount) return [];
  if (itemCount <= groupCount) return Array.from({ length: itemCount }, (_, index) => index + 1);
  const prefix = [0];
  weights.forEach((weight) => prefix.push(prefix[prefix.length - 1] + weight));
  const totalWeight = prefix[itemCount];
  const useItemCounts = totalWeight === 0;
  const target = (useItemCounts ? itemCount : totalWeight) / groupCount;
  const costs = Array.from({ length: groupCount + 1 }, () =>
    Array.from({ length: itemCount + 1 }, () => Number.POSITIVE_INFINITY),
  );
  const previous = Array.from({ length: groupCount + 1 }, () =>
    Array.from({ length: itemCount + 1 }, () => -1),
  );
  costs[0][0] = 0;
  for (let groups = 1; groups <= groupCount; groups += 1) {
    for (let end = groups; end <= itemCount - (groupCount - groups); end += 1) {
      for (let start = groups - 1; start < end; start += 1) {
        const weight = useItemCounts ? end - start : prefix[end] - prefix[start];
        const candidate = costs[groups - 1][start] + (weight - target) ** 2;
        if (candidate < costs[groups][end]) {
          costs[groups][end] = candidate;
          previous[groups][end] = start;
        }
      }
    }
  }
  const boundaries = Array.from({ length: groupCount }, () => itemCount);
  let end = itemCount;
  for (let groups = groupCount; groups >= 1; groups -= 1) {
    boundaries[groups - 1] = end;
    end = previous[groups][end];
  }
  return boundaries;
}

export function createFiveDaySprintPlan(
  outline: OutlineNode[],
  records: AnnotationRecord[],
  timestamp = new Date().toISOString(),
): FiveDaySprintPlan {
  const units = flattenOutline(outline);
  const orderedRecords = sortAnnotationsByOutline(outline, records);
  const weights = new Map(units.map((unit) => [unit.id, 0]));
  orderedRecords.forEach((record) => {
    const chapterId = recordChapterId(record);
    if (chapterId && weights.has(chapterId)) {
      weights.set(chapterId, (weights.get(chapterId) ?? 0) + 1);
    }
  });
  const boundaries = balancedBoundaries(
    units.map((unit) => weights.get(unit.id) ?? 0),
    FIVE_DAY_SPRINT_DAYS.length,
  );
  const chapterDayById: Record<string, FiveDaySprintDay> = {};
  let unitOffset = 0;
  boundaries.forEach((end, dayIndex) => {
    for (let index = unitOffset; index < end; index += 1) {
      chapterDayById[units[index].id] = FIVE_DAY_SPRINT_DAYS[Math.min(dayIndex, 4)];
    }
    unitOffset = end;
  });
  for (let index = unitOffset; index < units.length; index += 1) {
    chapterDayById[units[index].id] = 5;
  }
  const recordDayById: Record<string, FiveDaySprintDay> = {};
  orderedRecords.forEach((record) => {
    for (let index = record.outlinePath.length - 1; index >= 0; index -= 1) {
      const day = chapterDayById[record.outlinePath[index].id];
      if (!day) continue;
      recordDayById[record.id] = day;
      break;
    }
  });
  return { schemaVersion: 1, createdAt: timestamp, updatedAt: timestamp, recordDayById, chapterDayById };
}

export function normalizeFiveDaySprintPlan(value: unknown): FiveDaySprintPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<FiveDaySprintPlan>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.createdAt !== "string" ||
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    typeof candidate.updatedAt !== "string" ||
    Number.isNaN(Date.parse(candidate.updatedAt)) ||
    !candidate.chapterDayById ||
    typeof candidate.chapterDayById !== "object" ||
    Array.isArray(candidate.chapterDayById)
  ) return null;
  const chapterDayById = Object.fromEntries(
    Object.entries(candidate.chapterDayById).filter(
      (entry): entry is [string, FiveDaySprintDay] =>
        Boolean(entry[0]) && FIVE_DAY_SPRINT_DAYS.includes(entry[1] as FiveDaySprintDay),
    ),
  );
  const recordDayById = candidate.recordDayById && typeof candidate.recordDayById === "object" && !Array.isArray(candidate.recordDayById)
    ? Object.fromEntries(
        Object.entries(candidate.recordDayById).filter(
          (entry): entry is [string, FiveDaySprintDay] =>
            Boolean(entry[0]) && FIVE_DAY_SPRINT_DAYS.includes(entry[1] as FiveDaySprintDay),
        ),
      )
    : {};
  if (!Object.keys(chapterDayById).length) return null;
  return { schemaVersion: 1, createdAt: candidate.createdAt, updatedAt: candidate.updatedAt, recordDayById, chapterDayById };
}

export function fiveDaySprintDayForRecord(
  plan: FiveDaySprintPlan,
  record: AnnotationRecord,
): FiveDaySprintDay {
  const savedDay = plan.recordDayById?.[record.id];
  if (savedDay) return savedDay;
  for (let index = record.outlinePath.length - 1; index >= 0; index -= 1) {
    const day = plan.chapterDayById[record.outlinePath[index].id];
    if (day) return day;
  }
  return 5;
}

export function sortAnnotationsByOutline(
  outline: OutlineNode[],
  records: AnnotationRecord[],
): AnnotationRecord[] {
  const orderById = new Map(flattenOutline(outline).map((unit) => [unit.id, unit.order]));
  return [...records].sort((left, right) => {
    const leftOrder = orderById.get(recordChapterId(left) ?? "") ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderById.get(recordChapterId(right) ?? "") ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.page - right.page || left.entryY - right.entryY || left.id.localeCompare(right.id);
  });
}

export function recordsByFiveDaySprint(
  outline: OutlineNode[],
  records: AnnotationRecord[],
  plan: FiveDaySprintPlan | null,
): Record<FiveDaySprintDay, AnnotationRecord[]> {
  const grouped = Object.fromEntries(
    FIVE_DAY_SPRINT_DAYS.map((day) => [day, [] as AnnotationRecord[]]),
  ) as unknown as Record<FiveDaySprintDay, AnnotationRecord[]>;
  if (!plan) return grouped;
  sortAnnotationsByOutline(outline, records).forEach((record) => {
    grouped[fiveDaySprintDayForRecord(plan, record)].push(record);
  });
  return grouped;
}
