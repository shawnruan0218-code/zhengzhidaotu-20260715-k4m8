import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationSyncEntryIds,
  applyAnnotationSyncSnapshot,
  normalizeAnnotationUpdatedAt,
} from "../app/lib/annotation-sync.ts";

const oldTime = "2026-08-23T01:00:00.000Z";
const newTime = "2026-08-24T01:00:00.000Z";

function version() {
  return {
    id: "zhengzhidaotu_20260715_k4m8-default",
    name: "默认版本",
    createdAt: 0,
    updatedAt: oldTime,
    highlights: [],
    notes: { first: "第一条批注", second: "第二条批注" },
    noteHighlights: { first: [{ start: 0, end: 2, quote: "第一" }] },
    noteCreatedAt: { first: oldTime, second: oldTime },
    annotationUpdatedAt: { first: oldTime, second: oldTime },
    highlightHistory: [],
    emphasizedEntries: [],
    reviewItems: {},
  };
}

test("旧整版本数据会为每条批注补齐独立同步时间", () => {
  assert.deepEqual(
    normalizeAnnotationUpdatedAt(undefined, { first: "一", second: "二" }, { first: oldTime }, newTime),
    { first: oldTime, second: newTime },
  );
});

test("一条批注的云端更新不会覆盖其它批注和高亮", () => {
  const current = version();
  const updated = applyAnnotationSyncSnapshot(current, {
    versionId: current.id,
    entryId: "second",
    note: "第二条已修改",
    noteHighlights: [{ start: 0, end: 3, quote: "第二条" }],
    noteCreatedAt: oldTime,
    updatedAt: newTime,
  });
  assert.equal(updated.notes.first, "第一条批注");
  assert.deepEqual(updated.noteHighlights.first, current.noteHighlights.first);
  assert.equal(updated.notes.second, "第二条已修改");
  assert.equal(updated.noteHighlights.second[0].quote, "第二条");
});

test("较旧设备不能覆盖较新的批注高亮", () => {
  const current = version();
  current.annotationUpdatedAt.first = newTime;
  const updated = applyAnnotationSyncSnapshot(current, {
    versionId: current.id,
    entryId: "first",
    note: "旧设备内容",
    noteHighlights: [],
    noteCreatedAt: oldTime,
    updatedAt: oldTime,
  });
  assert.equal(updated, current);
});

test("显式删除以空批注快照同步，且不会复活", () => {
  const current = version();
  const deleted = applyAnnotationSyncSnapshot(current, {
    versionId: current.id,
    entryId: "first",
    note: "",
    noteHighlights: [],
    noteCreatedAt: null,
    updatedAt: newTime,
  });
  assert.equal(deleted.notes.first, undefined);
  assert.equal(deleted.noteHighlights.first, undefined);
  assert.equal(deleted.annotationUpdatedAt.first, newTime);
  assert.deepEqual(annotationSyncEntryIds(deleted), ["first", "second"]);
});
