import assert from "node:assert/strict";
import test from "node:test";
import {
  addReviewItem,
  normalizeReviewItems,
  removeReviewItem,
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

test("复习词条按稳定 entryId 原子化加入且重复加入幂等", () => {
  const first = addReviewItem({}, source, timestamp);
  const second = addReviewItem(first, source, "2026-08-23T02:00:00.000Z");
  assert.equal(first[source.entryId].entryText, source.entryText);
  assert.equal(first[source.entryId].addedAt, timestamp);
  assert.equal(second, first);
});

test("移出复习库不修改原对象或其它词条", () => {
  const first = addReviewItem({}, source, timestamp);
  const second = addReviewItem(first, { ...source, entryId: "p4-entry-two" }, timestamp);
  const removed = removeReviewItem(second, source.entryId);
  assert.equal(second[source.entryId].entryText, source.entryText);
  assert.equal(removed[source.entryId], undefined);
  assert.ok(removed["p4-entry-two"]);
});

test("只接受结构和时间合法的复习词条", () => {
  const valid = addReviewItem({}, source, timestamp);
  const normalized = normalizeReviewItems({
    ...valid,
    broken: { entryId: "broken", page: 0, entryText: "x", entryY: 0, addedAt: "bad", updatedAt: "bad" },
  });
  assert.deepEqual(normalized, valid);
});
