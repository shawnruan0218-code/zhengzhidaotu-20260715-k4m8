export type StudyVersion = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: string;
  highlights: string[];
  notes: Record<string, string>;
  highlightHistory: string[][];
  emphasizedEntries: string[];
};

export type StoredLibrary = {
  schemaVersion: 1;
  versions: StudyVersion[];
};

export type StoredSettings = {
  schemaVersion: 1;
  activeVersionId: string;
  updatedAt: string;
};

export type Tombstone = {
  itemType: "study_version" | "active_version";
  updatedAt: string;
  deletedAt: string;
};

export type StoredSyncState = {
  schemaVersion: 1;
  tombstones: Record<string, Tombstone>;
  lastSyncAt: string | null;
};

export const EPOCH_TIMESTAMP = new Date(0).toISOString();

export function nextIsoTimestamp(previous = EPOCH_TIMESTAMP): string {
  const previousTime = Date.parse(previous);
  const nextTime = Math.max(Date.now(), Number.isNaN(previousTime) ? 0 : previousTime + 1);
  return new Date(nextTime).toISOString();
}
