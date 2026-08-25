import type { NoteHighlightRange, StudyVersion } from "./study-types";

export type AnnotationSyncSnapshot = {
  versionId: string;
  entryId: string;
  note: string;
  noteHighlights: NoteHighlightRange[];
  entryTextHighlights: NoteHighlightRange[];
  noteCreatedAt: string | null;
  updatedAt: string;
};

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function normalizeAnnotationUpdatedAt(
  value: unknown,
  notes: Record<string, string>,
  noteCreatedAt: Record<string, string>,
  fallback: string,
  entryTextHighlights: Record<string, NoteHighlightRange[]> = {},
): Record<string, string> {
  const normalized = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] =>
          Boolean(entry[0]) && validTimestamp(entry[1])),
      )
    : {};
  for (const entryId of new Set([...Object.keys(notes), ...Object.keys(entryTextHighlights)])) {
    if (!normalized[entryId]) normalized[entryId] = noteCreatedAt[entryId] ?? fallback;
  }
  return normalized;
}

export function annotationSyncEntryIds(version: StudyVersion): string[] {
  return [...new Set([
    ...Object.keys(version.notes),
    ...Object.keys(version.entryTextHighlights),
    ...Object.keys(version.annotationUpdatedAt),
  ])].sort();
}

export function applyAnnotationSyncSnapshot(
  version: StudyVersion,
  snapshot: AnnotationSyncSnapshot,
): StudyVersion {
  if (snapshot.versionId !== version.id) return version;
  const localUpdatedAt = version.annotationUpdatedAt[snapshot.entryId] ?? "1970-01-01T00:00:00.000Z";
  if (Date.parse(localUpdatedAt) > Date.parse(snapshot.updatedAt)) return version;

  const notes = { ...version.notes };
  const noteHighlights = { ...version.noteHighlights };
  const entryTextHighlights = { ...version.entryTextHighlights };
  const noteCreatedAt = { ...version.noteCreatedAt };
  if (snapshot.note) {
    notes[snapshot.entryId] = snapshot.note;
    if (snapshot.noteHighlights.length) noteHighlights[snapshot.entryId] = snapshot.noteHighlights;
    else delete noteHighlights[snapshot.entryId];
    if (snapshot.noteCreatedAt) noteCreatedAt[snapshot.entryId] = snapshot.noteCreatedAt;
  } else {
    delete notes[snapshot.entryId];
    delete noteHighlights[snapshot.entryId];
    delete noteCreatedAt[snapshot.entryId];
  }
  if (snapshot.entryTextHighlights.length) {
    entryTextHighlights[snapshot.entryId] = snapshot.entryTextHighlights;
  } else {
    delete entryTextHighlights[snapshot.entryId];
  }

  return {
    ...version,
    notes,
    noteHighlights,
    entryTextHighlights,
    noteCreatedAt,
    annotationUpdatedAt: {
      ...version.annotationUpdatedAt,
      [snapshot.entryId]: snapshot.updatedAt,
    },
    updatedAt: Date.parse(snapshot.updatedAt) > Date.parse(version.updatedAt)
      ? snapshot.updatedAt
      : version.updatedAt,
  };
}
