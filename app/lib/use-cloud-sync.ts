"use client";

import type { Session, User } from "@supabase/supabase-js";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ITEM_KEY_PREFIX,
  STORAGE_KEYS,
  SUPABASE_TABLE,
  VERSION_ID_PREFIX,
  scopedItemKey,
} from "./app-config";
import type {
  StoredSyncState,
  StudyVersion,
  Tombstone,
} from "./study-types";
import { EPOCH_TIMESTAMP, nextIsoTimestamp } from "./study-types";
import { getSupabaseClient, isSupabaseConfigured } from "./supabase-client";
import {
  chunkItems,
  chooseLatestRecord,
  mergeRecordSets,
  readAllPages,
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
  session: Session | null;
  user: User | null;
  status: SyncStatus;
  statusText: string;
  lastSyncAt: string | null;
  syncNow: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<"signed-in" | "verify-email">;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  markVersionDeleted: (versionId: string) => void;
};

const PAGE_SIZE = 500;
const UPSERT_BATCH_SIZE = 100;
const TOMBSTONE_RETENTION_DAYS = 90;

function emptySyncState(): StoredSyncState {
  return { schemaVersion: 1, tombstones: {}, lastSyncAt: null };
}

function readSyncState(): StoredSyncState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.syncState);
    if (!raw) return emptySyncState();
    const parsed = JSON.parse(raw) as Partial<StoredSyncState>;
    const tombstones =
      parsed.tombstones && typeof parsed.tombstones === "object"
        ? Object.fromEntries(
            Object.entries(parsed.tombstones).filter(
              (entry): entry is [string, Tombstone] =>
                entry[0].startsWith(ITEM_KEY_PREFIX) &&
                Boolean(entry[1]) &&
                typeof entry[1].updatedAt === "string" &&
                typeof entry[1].deletedAt === "string" &&
                (entry[1].itemType === "study_version" ||
                  entry[1].itemType === "active_version"),
            ),
          )
        : {};
    return {
      schemaVersion: 1,
      tombstones,
      lastSyncAt: typeof parsed.lastSyncAt === "string" ? parsed.lastSyncAt : null,
    };
  } catch {
    return emptySyncState();
  }
}

function writeSyncState(tombstones: Record<string, Tombstone>, lastSyncAt: string | null) {
  try {
    window.localStorage.setItem(
      STORAGE_KEYS.syncState,
      JSON.stringify({ schemaVersion: 1, tombstones, lastSyncAt } satisfies StoredSyncState),
    );
  } catch {
    // The in-memory copy remains available if this browser blocks local storage.
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

function activeVersionRecord(
  userId: string,
  activeVersionId: string,
  updatedAt: string,
): SyncRecord {
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
    const deletedRecord = tombstoneRecord(userId, itemKey, tombstone);
    const liveRecord = byKey.get(itemKey);
    byKey.set(itemKey, liveRecord ? chooseLatestRecord(liveRecord, deletedRecord) : deletedRecord);
  }
  return [...byKey.values()];
}

function normalizeRemoteVersion(value: Record<string, unknown>, updatedAt: string): StudyVersion | null {
  if (typeof value.id !== "string" || typeof value.name !== "string") return null;
  if (!value.id.startsWith(VERSION_ID_PREFIX)) return null;
  return {
    id: value.id,
    name: value.name.trim() || "未命名版本",
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt,
    highlights: Array.isArray(value.highlights)
      ? value.highlights.filter((id): id is string => typeof id === "string")
      : [],
    notes:
      value.notes && typeof value.notes === "object" && !Array.isArray(value.notes)
        ? Object.fromEntries(
            Object.entries(value.notes).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {},
    highlightHistory: Array.isArray(value.highlightHistory)
      ? value.highlightHistory
          .filter((batch): batch is string[] => Array.isArray(batch))
          .map((batch) => batch.filter((id): id is string => typeof id === "string"))
          .filter((batch) => batch.length > 0)
      : [],
    emphasizedEntries: Array.isArray(value.emphasizedEntries)
      ? value.emphasizedEntries.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function cloudErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "云端暂时不可用";
}

export function useCloudSync(inputs: SyncInputs): CloudSyncController {
  const configured = isSupabaseConfigured();
  const client = useMemo(() => getSupabaseClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!configured);
  const [status, setStatus] = useState<SyncStatus>(configured ? "local" : "unconfigured");
  const initialSyncState = useRef<StoredSyncState | null>(null);
  const tombstonesRef = useRef<Record<string, Tombstone>>({});
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const latestInputs = useRef(inputs);
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
    setLastSyncAt(state.lastSyncAt);
  }, [inputs.hydrated]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.auth.getSession().then(({ data, error }) => {
      if (cancelled) return;
      if (!error) setSession(data.session);
      setAuthReady(true);
    });
    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
      if (!nextSession) setStatus("local");
    });
    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [client]);

  const fetchRemoteRecords = useCallback(
    async (userId: string): Promise<SyncRecord[]> => {
      if (!client) return [];
      return readAllPages(async (from, to) => {
        const { data, error } = await client
          .from(SUPABASE_TABLE)
          .select("id,user_id,item_key,item_type,item_data,added_at,updated_at,deleted_at")
          .eq("user_id", userId)
          .order("item_key", { ascending: true })
          .range(from, to);
        if (error) throw error;
        return (data ?? []).filter(
          (record): record is SyncRecord =>
            record.user_id === userId && record.item_key.startsWith(ITEM_KEY_PREFIX),
        );
      }, PAGE_SIZE);
    },
    [client],
  );

  const upsertRecords = useCallback(
    async (records: SyncRecord[]) => {
      if (!client) return;
      for (const batch of chunkItems(records, UPSERT_BATCH_SIZE)) {
        const { error } = await client
          .from(SUPABASE_TABLE)
          .upsert(batch, { onConflict: "user_id,item_key", ignoreDuplicates: false });
        if (error) throw error;
      }
    },
    [client],
  );

  const applyMergedRecords = useCallback((records: SyncRecord[]) => {
    const nextVersions: StudyVersion[] = [];
    const nextTombstones: Record<string, Tombstone> = {};
    let activeRecord: SyncRecord | null = null;

    for (const record of records) {
      if (record.deleted_at) {
        nextTombstones[record.item_key] = {
          itemType: record.item_type === "active_version" ? "active_version" : "study_version",
          updatedAt: record.updated_at,
          deletedAt: record.deleted_at,
        };
        continue;
      }
      if (record.item_type === "study_version") {
        const version = normalizeRemoteVersion(record.item_data, record.updated_at);
        if (version) nextVersions.push(version);
      } else if (record.item_type === "active_version") {
        activeRecord = record;
      }
    }

    if (!nextVersions.length) return;
    nextVersions.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const requestedActiveId =
      activeRecord && typeof activeRecord.item_data.activeVersionId === "string"
        ? activeRecord.item_data.activeVersionId
        : "";
    const nextActiveId = nextVersions.some((version) => version.id === requestedActiveId)
      ? requestedActiveId
      : nextVersions[0].id;
    const activeUpdatedAt = activeRecord?.updated_at ?? EPOCH_TIMESTAMP;

    tombstonesRef.current = nextTombstones;
    latestInputs.current.setVersions((current) =>
      JSON.stringify(current) === JSON.stringify(nextVersions) ? current : nextVersions,
    );
    latestInputs.current.setActiveVersionId((current) =>
      current === nextActiveId ? current : nextActiveId,
    );
    latestInputs.current.setActiveVersionUpdatedAt((current) =>
      current === activeUpdatedAt ? current : activeUpdatedAt,
    );
  }, []);

  const performSync = useCallback(async () => {
    const userId = session?.user.id;
    if (!client || !userId || !latestInputs.current.hydrated) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setStatus("offline");
      throw new Error("当前处于离线状态");
    }

    setStatus("syncing");
    try {
      const firstLocal = buildLocalRecords(
        userId,
        latestInputs.current.versions,
        latestInputs.current.activeVersionId,
        latestInputs.current.activeVersionUpdatedAt,
        tombstonesRef.current,
      );
      const firstRemote = await fetchRemoteRecords(userId);
      const firstMerged = mergeRecordSets(firstLocal, firstRemote);
      await upsertRecords(firstMerged);

      // A second read closes the race where another device writes during this sync.
      const confirmedRemote = await fetchRemoteRecords(userId);
      const latestLocal = buildLocalRecords(
        userId,
        latestInputs.current.versions,
        latestInputs.current.activeVersionId,
        latestInputs.current.activeVersionUpdatedAt,
        tombstonesRef.current,
      );
      const confirmedMerged = mergeRecordSets(latestLocal, confirmedRemote);
      await upsertRecords(confirmedMerged);
      applyMergedRecords(confirmedMerged);

      const syncedAt = new Date().toISOString();
      const cutoff = new Date(
        Date.now() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { error: cleanupError } = await client
        .from(SUPABASE_TABLE)
        .delete()
        .eq("user_id", userId)
        .not("deleted_at", "is", null)
        .lt("deleted_at", cutoff);
      if (cleanupError) throw cleanupError;

      tombstonesRef.current = Object.fromEntries(
        Object.entries(tombstonesRef.current).filter(([, tombstone]) => tombstone.deletedAt >= cutoff),
      );
      setLastSyncAt(syncedAt);
      writeSyncState(tombstonesRef.current, syncedAt);
      setStatus("synced");
    } catch (error) {
      setStatus(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "error");
      writeSyncState(tombstonesRef.current, lastSyncAt);
      throw new Error(cloudErrorMessage(error));
    }
  }, [applyMergedRecords, client, fetchRemoteRecords, lastSyncAt, session?.user.id, upsertRecords]);

  const syncNow = useCallback(async () => {
    if (!client || !session?.user.id || !latestInputs.current.hydrated) return;
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
    runningSync.current = run().finally(() => {
      runningSync.current = null;
    });
    return runningSync.current;
  }, [client, performSync, session?.user.id]);

  useEffect(() => {
    if (!inputs.hydrated) return;
    if (session?.user.id) {
      syncQueued.current = true;
      void syncNow().catch(() => undefined);
    }
  }, [
    inputs.activeVersionId,
    inputs.activeVersionUpdatedAt,
    inputs.hydrated,
    inputs.versions,
    session?.user.id,
    syncNow,
  ]);

  useEffect(() => {
    if (!session?.user.id || !inputs.hydrated) return;
    void syncNow().catch(() => undefined);
    const interval = window.setInterval(() => void syncNow().catch(() => undefined), 30_000);
    const resumeSync = () => void syncNow().catch(() => undefined);
    const onVisibility = () => {
      if (document.visibilityState === "visible") resumeSync();
    };
    window.addEventListener("online", resumeSync);
    window.addEventListener("focus", resumeSync);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", resumeSync);
      window.removeEventListener("focus", resumeSync);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [inputs.hydrated, session?.user.id, syncNow]);

  const signUp = useCallback(
    async (email: string, password: string) => {
      if (!client) throw new Error("尚未配置当前项目的 Supabase");
      const redirectUrl = `${window.location.origin}${window.location.pathname}`;
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectUrl },
      });
      if (error) throw error;
      if (data.session) {
        await syncNow();
        return "signed-in" as const;
      }
      return "verify-email" as const;
    },
    [client, syncNow],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!client) throw new Error("尚未配置当前项目的 Supabase");
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await syncNow();
    },
    [client, syncNow],
  );

  const signOut = useCallback(async () => {
    if (!client) return;
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) throw error;
    setSession(null);
    setStatus("local");
  }, [client]);

  const markVersionDeleted = useCallback((versionId: string) => {
    const versionUpdatedAt = latestInputs.current.versions.find(
      (version) => version.id === versionId,
    )?.updatedAt;
    const timestamp = nextIsoTimestamp(versionUpdatedAt);
    const itemKey = scopedItemKey(`version:${versionId}`);
    tombstonesRef.current = {
      ...tombstonesRef.current,
      [itemKey]: {
        itemType: "study_version",
        updatedAt: timestamp,
        deletedAt: timestamp,
      },
    };
    writeSyncState(tombstonesRef.current, lastSyncAt);
    setStatus(configured ? "local" : "unconfigured");
    syncQueued.current = true;
  }, [configured, lastSyncAt]);

  const statusText =
    status === "unconfigured"
      ? "仅本地 · 待配置云端"
      : status === "syncing"
        ? "正在同步"
        : status === "synced"
          ? "云端已同步"
          : status === "offline"
            ? "离线 · 本地已保存"
            : status === "error"
              ? "本地已保存，云同步失败"
              : session
                ? "本地已保存"
                : "本地已保存 · 未登录";

  return {
    configured,
    authReady,
    session,
    user: session?.user ?? null,
    status,
    statusText,
    lastSyncAt,
    syncNow,
    signUp,
    signIn,
    signOut,
    markVersionDeleted,
  };
}
