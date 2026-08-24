import assert from "node:assert/strict";
import test from "node:test";
import {
  addReviewItem,
  addReviewItemToLevel,
  normalizeReviewItems,
  removeReviewItem,
  removeReviewItemFromLevel,
} from "../app/lib/review-library.ts";

const source = {
  entryId: "p4-entry-consciousness",
  page: 4,
  entryText: "意识具有目的性和计划性",
  entryY: 0.42,
};
const timestamp = "2026-08-23T01:02:03.000Z";

test("旧版本没有复习库字段时兼容为空库", () => {
  assert.deepEqual(normalizeReviewItems(undefined), {});
  assert.deepEqual(normalizeReviewItems([]), {});
});

test("旧复习库词条无层级字段时无损迁移为复习库 1", () => {
  const legacy = {
    [source.entryId]: {
      ...source,
      addedAt: timestamp,
      updatedAt: timestamp,
    },
  };
  const normalized = normalizeReviewItems(legacy);
  assert.deepEqual(normalized[source.entryId].levels, [1]);
  assert.equal(normalized[source.entryId].addedAtByLevel[1], timestamp);
  assert.equal(normalized[source.entryId].entryText, source.entryText);
});

test("复习词条按稳定 entryId 原子化加入且重复加入幂等", () => {
  const first = addReviewItem({}, source, timestamp);
  const second = addReviewItem(first, source, "2026-08-23T02:00:00.000Z");
  assert.equal(first[source.entryId].entryText, source.entryText);
  assert.equal(first[source.entryId].addedAt, timestamp);
  assert.equal(second, first);
});

test("复习库按 1 → 2 → 3 连续加入且最多三层", () => {
  const level1 = addReviewItem({}, source, timestamp);
  const level2 = addReviewItemToLevel(level1, source, 2, "2026-08-24T01:00:00.000Z");
  const level3 = addReviewItemToLevel(level2, source, 3, "2026-08-24T02:00:00.000Z");
  const duplicate = addReviewItemToLevel(level3, source, 3, "2026-08-24T03:00:00.000Z");
  assert.deepEqual(level1[source.entryId].levels, [1]);
  assert.deepEqual(level2[source.entryId].levels, [1, 2]);
  assert.deepEqual(level3[source.entryId].levels, [1, 2, 3]);
  assert.equal(level3[source.entryId].addedAtByLevel[2], "2026-08-24T01:00:00.000Z");
  assert.equal(duplicate, level3);
});

test("移出复习库不修改原对象或其它词条", () => {
  const first = addReviewItem({}, source, timestamp);
  const second = addReviewItem(first, { ...source, entryId: "p4-entry-two" }, timestamp);
  const removed = removeReviewItem(second, source.entryId);
  assert.equal(second[source.entryId].entryText, source.entryText);
  assert.equal(removed[source.entryId], undefined);
  assert.ok(removed["p4-entry-two"]);
});

test("从复习库 2 移出时保留库 1 并同时清理后续层级", () => {
  const level3 = addReviewItemToLevel({}, source, 3, timestamp);
  const removed = removeReviewItemFromLevel(level3, source.entryId, 2, "2026-08-24T04:00:00.000Z");
  assert.deepEqual(level3[source.entryId].levels, [1, 2, 3]);
  assert.deepEqual(removed[source.entryId].levels, [1]);
  assert.equal(removed[source.entryId].addedAtByLevel[2], undefined);
  assert.equal(removed[source.entryId].entryText, source.entryText);
});

test("只接受结构和时间合法的复习词条", () => {
  const valid = addReviewItem({}, source, timestamp);
  const normalized = normalizeReviewItems({
    ...valid,
    broken: { entryId: "broken", page: 0, entryText: "x", entryY: 0, addedAt: "bad", updatedAt: "bad" },
  });
  assert.deepEqual(normalized, valid);
});
