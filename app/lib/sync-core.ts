export type SyncRecord = {
  id: string;
  user_id: string;
  item_key: string;
  item_type: string;
  item_data: Record<string, unknown>;
  added_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type TimestampedVersion = {
  id: string;
  createdAt: number;
  updatedAt: string;
};

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function deterministicVersionPayload<T extends TimestampedVersion>(version: T): string {
  return JSON.stringify(version);
}

export function reconcileVersionSnapshots<T extends TimestampedVersion>(
  currentVersions: T[],
  syncedVersions: T[],
  deletedVersionUpdates: Record<string, string> = {},
): T[] {
  const reconciled = new Map<string, T>();
  for (const syncedVersion of syncedVersions) {
    const deletedAt = deletedVersionUpdates[syncedVersion.id];
    if (
      !deletedAt ||
      timestampValue(syncedVersion.updatedAt) > timestampValue(deletedAt)
    ) {
      reconciled.set(syncedVersion.id, syncedVersion);
    }
  }

  for (const currentVersion of currentVersions) {
    const syncedVersion = reconciled.get(currentVersion.id);
    if (syncedVersion) {
      const currentTime = timestampValue(currentVersion.updatedAt);
      const syncedTime = timestampValue(syncedVersion.updatedAt);
      if (
        currentTime > syncedTime ||
        (currentTime === syncedTime &&
          deterministicVersionPayload(currentVersion) >
            deterministicVersionPayload(syncedVersion))
      ) {
        reconciled.set(currentVersion.id, currentVersion);
      }
      continue;
    }

    const deletedAt = deletedVersionUpdates[currentVersion.id];
    if (!deletedAt || timestampValue(currentVersion.updatedAt) > timestampValue(deletedAt)) {
      reconciled.set(currentVersion.id, currentVersion);
    }
  }

  return [...reconciled.values()].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

export function chunkItems<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error("Chunk size must be positive");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function readAllPages<T>(
  readPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 500,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error("Page size must be positive");
  }
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await readPage(from, from + pageSize - 1);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function deterministicPayload(record: SyncRecord): string {
  return JSON.stringify({
    deleted_at: record.deleted_at,
    item_data: record.item_data,
    item_type: record.item_type,
  });
}

export function chooseLatestRecord(left: SyncRecord, right: SyncRecord): SyncRecord {
  const leftTime = Date.parse(left.updated_at);
  const rightTime = Date.parse(right.updated_at);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  if (Boolean(left.deleted_at) !== Boolean(right.deleted_at)) {
    return left.deleted_at ? left : right;
  }
  return deterministicPayload(left) >= deterministicPayload(right) ? left : right;
}

export function mergeRecordSets(
  localRecords: SyncRecord[],
  remoteRecords: SyncRecord[],
): SyncRecord[] {
  const merged = new Map<string, SyncRecord>();
  for (const record of [...localRecords, ...remoteRecords]) {
    const existing = merged.get(record.item_key);
    merged.set(record.item_key, existing ? chooseLatestRecord(existing, record) : record);
  }
  return [...merged.values()].sort((left, right) => left.item_key.localeCompare(right.item_key));
}
