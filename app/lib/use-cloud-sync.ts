"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ITEM_KEY_PREFIX,
  STORAGE_KEYS,
  VERSION_ID_PREFIX,
  scopedItemKey,
} from "./app-config";
import {
  clearCloudflareSession,
  cloudflareLoginUrl,
  cloudflareRequest,
  consumeCloudflareCallback,
  isCloudflareConfigured,
  readCloudflareSession,
  type CloudflareUser,
} from "./cloudflare-client";
import { normalizeReviewItems } from "./review-library";
import type { NoteHighlightRange, StoredSyncState, StudyVersion, Tombstone } from "./study-types";
import { EPOCH_TIMESTAMP, nextIsoTimestamp } from "./study-types";
import {
  chunkItems,
  chooseLatestRecord,
  mergeRecordSets,
  reconcileVersionSnapshots,
  type SyncRecord,
} from "./sync-core";

export type SyncStatus =
  | "unconfigured"
  | "local"
  | "offline"
  | "syncing"
  | "synced"
  | "error";

type SyncInputs = {
  versions: StudyVersion[];
  activeVersionId: string;
  activeVersionUpdatedAt: string;
  hydrated: boolean;
  setVersions: Dispatch<SetStateAction<StudyVersion[]>>;
  setActiveVersionId: Dispatch<SetStateAction<string>>;
  setActiveVersionUpdatedAt: Dispatch<SetStateAction<string>>;
};

export type CloudSyncController = {
  configured: boolean;
  authReady: boolean;
  user: CloudflareUser | null;
  status: SyncStatus;
  statusText: string;
  lastSyncAt: string | null;
  syncNow: () => Promise<void>;
  signIn: () => void;
  signOut: () => Promise<void>;
  markVersionDeleted: (versionId: string) => void;
};

type PullResponse = {
  records: SyncRecord[];
  cursor: string | null;
  hasMore: boolean;
};

const PUSH_BATCH_SIZE = 25;

function emptySyncState(): StoredSyncState {
  return {
    schemaVersion: 1,
    tombstones: {},
    lastSyncAt: null,
    cloudCursor: null,
    syncedRecordVersions: {},
  };
}

function readSyncState(): StoredSyncState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.syncState);
    if (!raw) return emptySyncState();
    const parsed = JSON.parse(raw) as Partial<StoredSyncState>;
    const tombstones = parsed.tombstones && typeof parsed.tombstones === "object"
      ? Object.fromEntries(
          Object.entries(parsed.tombstones).filter(
            (entry): entry is [string, Tombstone] =>
              entry[0].startsWith(ITEM_KEY_PREFIX) &&
              Boolean(entry[1]) &&
              typeof entry[1].updatedAt === "string" &&
              typeof entry[1].deletedAt === "string" &&
              (entry[1].itemType === "study_version" || entry[1].itemType === "active_version"),
          ),
        )
      : {};
    const syncedRecordVersions = parsed.syncedRecordVersions &&
      typeof parsed.syncedRecordVersions === "object"
      ? Object.fromEntries(
          Object.entries(parsed.syncedRecordVersions).filter(
            (entry): entry is [string, string] =>
              entry[0].startsWith(ITEM_KEY_PREFIX) && typeof entry[1] === "string",
          ),
        )
      : {};
    return {
      schemaVersion: 1,
      tombstones,
      lastSyncAt: typeof parsed.lastSyncAt === "string" ? parsed.lastSyncAt : null,
      cloudCursor: typeof parsed.cloudCursor === "string" ? parsed.cloudCursor : null,
      syncedRecordVersions,
    };
  } catch {
    return emptySyncState();
  }
}

function writeSyncState(
  tombstones: Record<string, Tombstone>,
  lastSyncAt: string | null,
  cloudCursor: string | null,
  syncedRecordVersions: Record<string, string>,
) {
  try {
    window.localStorage.setItem(
      STORAGE_KEYS.syncState,
      JSON.stringify({
        schemaVersion: 1,
        tombstones,
        lastSyncAt,
        cloudCursor,
        syncedRecordVersions,
      } satisfies StoredSyncState),
    );
  } catch {
    // Local study data remains available even when browser storage is restricted.
  }
}

function versionRecord(userId: string, version: StudyVersion): SyncRecord {
  const itemKey = scopedItemKey(`version:${version.id}`);
  return {
    id: `${userId}::${itemKey}`,
    user_id: userId,
    item_key: itemKey,
    item_type: "study_version",
    item_data: version as unknown as Record<string, unknown>,
    added_at: new Date(version.createdAt || 0).toISOString(),
    updated_at: version.updatedAt || EPOCH_TIMESTAMP,
    deleted_at: null,
  };
}

function activeVersionRecord(userId: string, activeVersionId: string, updatedAt: string): SyncRecord {
  const itemKey = scopedItemKey("setting:active-version");
  return {
    id: `${userId}::${itemKey}`,
    user_id: userId,
    item_key: itemKey,
    item_type: "active_version",
    item_data: { activeVersionId },
    added_at: updatedAt || EPOCH_TIMESTAMP,
    updated_at: updatedAt || EPOCH_TIMESTAMP,
    deleted_at: null,
  };
}

function tombstoneRecord(userId: string, itemKey: string, tombstone: Tombstone): SyncRecord {
  return {
    id: `${userId}::${itemKey}`,
    user_id: userId,
    item_key: itemKey,
    item_type: tombstone.itemType,
    item_data: {},
    added_at: tombstone.updatedAt,
    updated_at: tombstone.updatedAt,
    deleted_at: tombstone.deletedAt,
  };
}

function buildLocalRecords(
  userId: string,
  versions: StudyVersion[],
  activeVersionId: string,
  activeVersionUpdatedAt: string,
  tombstones: Record<string, Tombstone>,
): SyncRecord[] {
  const records = [
    ...versions.map((version) => versionRecord(userId, version)),
    activeVersionRecord(userId, activeVersionId, activeVersionUpdatedAt),
  ];
  const byKey = new Map(records.map((record) => [record.item_key, record]));
  for (const [itemKey, tombstone] of Object.entries(tombstones)) {
    const deleted = tombstoneRecord(userId, itemKey, tombstone);
    const live = byKey.get(itemKey);
    byKey.set(itemKey, live ? chooseLatestRecord(live, deleted) : deleted);
  }
  return [...byKey.values()];
}

function normalizeRemoteVersion(value: Record<string, unknown>, updatedAt: string): StudyVersion | null {
  if (typeof value.id !== "string" || typeof value.name !== "string") return null;
  if (!value.id.startsWith(VERSION_ID_PREFIX)) return null;
  const notes = value.notes && typeof value.notes === "object" && !Array.isArray(value.notes)
    ? Object.fromEntries(Object.entries(value.notes).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ))
    : {};
  const noteCreatedAt = value.noteCreatedAt && typeof value.noteCreatedAt === "object" &&
    !Array.isArray(value.noteCreatedAt)
    ? Object.fromEntries(Object.entries(value.noteCreatedAt).filter(
        (entry): entry is [string, string] =>
          Boolean(notes[entry[0]]) && typeof entry[1] === "string" && !Number.isNaN(Date.parse(entry[1])),
      ))
    : {};
  const noteHighlights = value.noteHighlights && typeof value.noteHighlights === "object" &&
    !Array.isArray(value.noteHighlights)
    ? Object.fromEntries(Object.entries(value.noteHighlights).flatMap(([entryId, ranges]) => {
        if (!Array.isArray(ranges)) return [];
        const normalized = ranges.flatMap((range) => {
          if (!range || typeof range !== "object") return [];
          const item = range as Partial<NoteHighlightRange>;
          return typeof item.start === "number" &&
            typeof item.end === "number" &&
            typeof item.quote === "string" &&
            item.end > item.start
            ? [{ start: item.start, end: item.end, quote: item.quote }]
            : [];
        });
        return normalized.length ? [[entryId, normalized]] : [];
      }))
    : {};
  const reviewItems = normalizeReviewItems(value.reviewItems);
  return {
    id: value.id,
    name: value.name.trim() || "未命名版本",
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt,
    highlights: Array.isArray(value.highlights)
      ? value.highlights.filter((id): id is string => typeof id === "string")
      : [],
    notes,
    noteHighlights,
    noteCreatedAt,
    highlightHistory: Array.isArray(value.highlightHistory)
      ? value.highlightHistory
          .filter((batch): batch is string[] => Array.isArray(batch))
          .map((batch) => batch.filter((id): id is string => typeof id === "string"))
          .filter((batch) => batch.length > 0)
      : [],
    emphasizedEntries: Array.isArray(value.emphasizedEntries)
      ? value.emphasizedEntries.filter((id): id is string => typeof id === "string")
      : [],
    reviewItems,
  };
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function recordFingerprint(record: SyncRecord): string {
  const payload = JSON.stringify({
    type: record.item_type,
    data: record.item_data,
    updated: record.updated_at,
    deleted: record.deleted_at,
  });
  return `${record.updated_at}:${record.deleted_at ?? ""}:${payload.length}:${simpleHash(payload)}`;
}

function rebindRecord(record: SyncRecord, userId: string): SyncRecord {
  return { ...record, id: `${userId}::${record.item_key}`, user_id: userId };
}

function cloudErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "云端暂时不可用";
}

export function useCloudSync(inputs: SyncInputs): CloudSyncController {
  const configured = isCloudflareConfigured();
  const [user, setUser] = useState<CloudflareUser | null>(null);
  const [authReady, setAuthReady] = useState(!configured);
  const [status, setStatus] = useState<SyncStatus>(configured ? "local" : "unconfigured");
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const lastSyncAtRef = useRef<string | null>(null);
  const latestInputs = useRef(inputs);
  const initialSyncState = useRef<StoredSyncState | null>(null);
  const tombstonesRef = useRef<Record<string, Tombstone>>({});
  const cursorRef = useRef<string | null>(null);
  const syncedVersionsRef = useRef<Record<string, string>>({});
  const runningSync = useRef<Promise<void> | null>(null);
  const syncQueued = useRef(false);

  useEffect(() => {
    latestInputs.current = inputs;
  }, [inputs]);

  useEffect(() => {
    if (!inputs.hydrated || initialSyncState.current) return;
    const state = readSyncState();
    initialSyncState.current = state;
    tombstonesRef.current = state.tombstones;
    cursorRef.current = state.cloudCursor ?? null;
    syncedVersionsRef.current = state.syncedRecordVersions ?? {};
    lastSyncAtRef.current = state.lastSyncAt;
    setLastSyncAt(state.lastSyncAt);
  }, [inputs.hydrated]);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    consumeCloudflareCallback();
    if (!readCloudflareSession()) {
      const timer = window.setTimeout(() => setAuthReady(true), 0);
      return () => window.clearTimeout(timer);
    }
    void cloudflareRequest<{ user: CloudflareUser }>("/auth/me", { method: "GET" })
      .then(({ user: nextUser }) => {
        if (!cancelled) setUser(nextUser);
      })
      .catch(() => {
        if (!cancelled) {
          clearCloudflareSession();
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });
    return () => { cancelled = true; };
  }, [configured]);

  const pullRemote = useCallback(async (startCursor: string | null) => {
    const records: SyncRecord[] = [];
    let cursor = startCursor;
    for (;;) {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page = await cloudflareRequest<PullResponse>(`/sync/pull${suffix}`, { method: "GET" });
      records.push(...page.records);
      cursor = page.cursor ?? cursor;
      if (!page.hasMore) return { records, cursor };
    }
  }, []);

  const pushRemote = useCallback(async (records: SyncRecord[]) => {
    for (const batch of chunkItems(records, PUSH_BATCH_SIZE)) {
      await cloudflareRequest("/sync/push", {
        method: "POST",
        body: {
          records: batch.map(({ item_key, item_type, item_data, added_at, updated_at, deleted_at }) => ({
            item_key,
            item_type,
            item_data,
            added_at,
            updated_at,
            deleted_at,
          })),
        },
      });
    }
  }, []);

  const applyMergedRecords = useCallback((records: SyncRecord[]) => {
    const nextVersions: StudyVersion[] = [];
    const nextTombstones: Record<string, Tombstone> = {};
    const versionItemPrefix = scopedItemKey("version:");
    let activeRecord: SyncRecord | null = null;
    for (const record of records) {
      if (record.deleted_at) {
        nextTombstones[record.item_key] = {
          itemType: record.item_type === "active_version" ? "active_version" : "study_version",
          updatedAt: record.updated_at,
          deletedAt: record.deleted_at,
        };
      } else if (record.item_type === "study_version") {
        const version = normalizeRemoteVersion(record.item_data, record.updated_at);
        if (version) nextVersions.push(version);
      } else if (record.item_type === "active_version") {
        activeRecord = record;
      }
    }
    if (!nextVersions.length) return;
    const reconciledTombstones = { ...nextTombstones };
    for (const [itemKey, local] of Object.entries(tombstonesRef.current)) {
      const remote = reconciledTombstones[itemKey];
      if (!remote || Date.parse(local.updatedAt) > Date.parse(remote.updatedAt)) {
        reconciledTombstones[itemKey] = local;
      }
    }
    const deletedVersionUpdates = Object.fromEntries(
      Object.entries(reconciledTombstones)
        .filter(([key, tombstone]) =>
          tombstone.itemType === "study_version" && key.startsWith(versionItemPrefix))
        .map(([key, tombstone]) => [key.slice(versionItemPrefix.length), tombstone.updatedAt]),
    );
    tombstonesRef.current = reconciledTombstones;
    latestInputs.current.setVersions((current) => {
      const reconciled = reconcileVersionSnapshots(current, nextVersions, deletedVersionUpdates);
      return JSON.stringify(current) === JSON.stringify(reconciled) ? current : reconciled;
    });
    const requestedActive = activeRecord && typeof activeRecord.item_data.activeVersionId === "string"
      ? activeRecord.item_data.activeVersionId
      : "";
    const activeId = nextVersions.some((version) => version.id === requestedActive)
      ? requestedActive
      : nextVersions[0].id;
    const activeUpdatedAt = activeRecord?.updated_at ?? EPOCH_TIMESTAMP;
    latestInputs.current.setActiveVersionId((current) => current === activeId ? current : activeId);
    latestInputs.current.setActiveVersionUpdatedAt((current) =>
      current === activeUpdatedAt ? current : activeUpdatedAt);
  }, []);

  const performSync = useCallback(async () => {
    if (!user || !latestInputs.current.hydrated) return;
    if (!navigator.onLine) {
      setStatus("offline");
      throw new Error("当前处于离线状态");
    }
    setStatus("syncing");
    try {
      const firstPull = await pullRemote(cursorRef.current);
      firstPull.records.forEach((record) => {
        syncedVersionsRef.current[record.item_key] = recordFingerprint(record);
      });
      const localRecords = buildLocalRecords(
        user.id,
        latestInputs.current.versions,
        latestInputs.current.activeVersionId,
        latestInputs.current.activeVersionUpdatedAt,
        tombstonesRef.current,
      );
      const merged = mergeRecordSets(localRecords, firstPull.records)
        .map((record) => rebindRecord(record, user.id));
      applyMergedRecords(merged);

      const pending = merged.filter(
        (record) => syncedVersionsRef.current[record.item_key] !== recordFingerprint(record),
      );
      if (pending.length) await pushRemote(pending);

      const confirmed = await pullRemote(firstPull.cursor);
      confirmed.records.forEach((record) => {
        syncedVersionsRef.current[record.item_key] = recordFingerprint(record);
      });
      const finalMerged = mergeRecordSets(merged, confirmed.records.map((record) => rebindRecord(record, user.id)));
      applyMergedRecords(finalMerged);
      pending.forEach((record) => {
        syncedVersionsRef.current[record.item_key] = recordFingerprint(record);
      });
      const syncedAt = new Date().toISOString();
      cursorRef.current = confirmed.cursor;
      lastSyncAtRef.current = syncedAt;
      setLastSyncAt(syncedAt);
      writeSyncState(
        tombstonesRef.current,
        syncedAt,
        cursorRef.current,
        syncedVersionsRef.current,
      );
      setStatus("synced");
    } catch (error) {
      setStatus(navigator.onLine ? "error" : "offline");
      writeSyncState(
        tombstonesRef.current,
        lastSyncAtRef.current,
        cursorRef.current,
        syncedVersionsRef.current,
      );
      throw new Error(cloudErrorMessage(error));
    }
  }, [applyMergedRecords, pullRemote, pushRemote, user]);

  const syncNow = useCallback(async () => {
    if (!user || !latestInputs.current.hydrated) return;
    if (runningSync.current) {
      syncQueued.current = true;
      return runningSync.current;
    }
    const run = async () => {
      do {
        syncQueued.current = false;
        await performSync();
      } while (syncQueued.current);
    };
    runningSync.current = run().finally(() => { runningSync.current = null; });
    return runningSync.current;
  }, [performSync, user]);

  useEffect(() => {
    if (!user || !inputs.hydrated) return;
    const timer = window.setTimeout(() => {
      setStatus("local");
      void syncNow().catch(() => undefined);
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [
    inputs.activeVersionId,
    inputs.activeVersionUpdatedAt,
    inputs.hydrated,
    inputs.versions,
    syncNow,
    user,
  ]);

  useEffect(() => {
    if (!user || !inputs.hydrated) return;
    void syncNow().catch(() => undefined);
    const interval = window.setInterval(() => void syncNow().catch(() => undefined), 60_000);
    const resume = () => void syncNow().catch(() => undefined);
    const visibility = () => {
      if (document.visibilityState === "visible") resume();
    };
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [inputs.hydrated, syncNow, user]);

  const signIn = useCallback(() => {
    window.location.assign(cloudflareLoginUrl(window.location.href));
  }, []);

  const signOut = useCallback(async () => {
    if (readCloudflareSession()) {
      await cloudflareRequest("/auth/logout", { method: "POST" }).catch(() => undefined);
    }
    clearCloudflareSession();
    setUser(null);
    setStatus("local");
  }, []);

  const markVersionDeleted = useCallback((versionId: string) => {
    const updatedAt = latestInputs.current.versions.find((version) => version.id === versionId)?.updatedAt;
    const timestamp = nextIsoTimestamp(updatedAt);
    const itemKey = scopedItemKey(`version:${versionId}`);
    tombstonesRef.current = {
      ...tombstonesRef.current,
      [itemKey]: {
        itemType: "study_version",
        updatedAt: timestamp,
        deletedAt: timestamp,
      },
    };
    writeSyncState(
      tombstonesRef.current,
      lastSyncAtRef.current,
      cursorRef.current,
      syncedVersionsRef.current,
    );
    setStatus(configured ? "local" : "unconfigured");
    syncQueued.current = true;
  }, [configured]);

  const statusText = status === "unconfigured"
    ? "仅本地 · 待配置免费云端"
    : status === "syncing"
      ? "正在增量同步"
      : status === "synced"
        ? "云端已同步"
        : status === "offline"
          ? "离线 · 本地已保存"
          : status === "error"
            ? "本地已保存，云同步失败"
            : user
              ? "本地已保存"
              : "本地已保存 · 未登录";

  return {
    configured,
    authReady,
    user,
    status,
    statusText,
    lastSyncAt,
    syncNow,
    signIn,
    signOut,
    markVersionDeleted,
  };
}
