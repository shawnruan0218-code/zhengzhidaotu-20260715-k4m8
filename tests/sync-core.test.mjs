import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkItems,
  mergeRecordSets,
  readAllPages,
} from "../app/lib/sync-core.ts";

const namespace = "zhengzhidaotu_20260715_k4m8";
const userId = "00000000-0000-0000-0000-000000000001";

function record(key, updatedAt, itemData, deletedAt = null) {
  const itemKey = `${namespace}:${key}`;
  return {
    id: `${userId}::${itemKey}`,
    user_id: userId,
    item_key: itemKey,
    item_type: "study_version",
    item_data: itemData,
    added_at: "2026-01-01T00:00:00.000Z",
    updated_at: updatedAt,
    deleted_at: deletedAt,
  };
}

test("merges different item keys without dropping either device", () => {
  const merged = mergeRecordSets(
    [record("version:a", "2026-07-15T01:00:00.000Z", { value: "computer" })],
    [record("version:b", "2026-07-15T01:00:00.000Z", { value: "phone" })],
  );
  assert.deepEqual(merged.map((item) => item.item_key), [
    `${namespace}:version:a`,
    `${namespace}:version:b`,
  ]);
});

test("keeps the newest update for the same stable item key", () => {
  const oldRecord = record("version:a", "2026-07-15T01:00:00.000Z", { value: "old" });
  const newRecord = record("version:a", "2026-07-15T02:00:00.000Z", { value: "new" });
  assert.equal(mergeRecordSets([oldRecord], [newRecord])[0].item_data.value, "new");
  assert.equal(mergeRecordSets([newRecord], [oldRecord])[0].item_data.value, "new");
});

test("a newer soft delete wins and an older device cannot resurrect it", () => {
  const live = record("version:a", "2026-07-15T01:00:00.000Z", { value: "live" });
  const deleted = record(
    "version:a",
    "2026-07-15T02:00:00.000Z",
    {},
    "2026-07-15T02:00:00.000Z",
  );
  assert.equal(mergeRecordSets([live], [deleted])[0].deleted_at, "2026-07-15T02:00:00.000Z");
});

test("a deletion wins an exact timestamp tie deterministically", () => {
  const timestamp = "2026-07-15T02:00:00.000Z";
  const live = record("version:a", timestamp, { value: "live" });
  const deleted = record("version:a", timestamp, {}, timestamp);
  assert.equal(mergeRecordSets([live], [deleted])[0].deleted_at, timestamp);
});

test("paginated reads retrieve more than the Supabase 1000-row default", async () => {
  const source = Array.from({ length: 1_205 }, (_, index) => index);
  const requestedRanges = [];
  const rows = await readAllPages(async (from, to) => {
    requestedRanges.push([from, to]);
    return source.slice(from, to + 1);
  }, 500);
  assert.equal(rows.length, 1_205);
  assert.deepEqual(requestedRanges, [[0, 499], [500, 999], [1000, 1499]]);
});

test("bulk writes are split into bounded batches", () => {
  const batches = chunkItems(Array.from({ length: 251 }, (_, index) => index), 100);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 51]);
});
