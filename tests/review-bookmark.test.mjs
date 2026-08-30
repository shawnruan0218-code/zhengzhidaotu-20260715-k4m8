import assert from "node:assert/strict";
import test from "node:test";
import {
  createReviewBookmark,
  findReviewBookmarkRecord,
  normalizeReviewBookmark,
} from "../app/lib/review-bookmark.ts";

function record(overrides = {}) {
  return {
    id: "record-7",
    versionId: "version-1",
    versionName: "默认版本",
    entryId: "entry-7",
    page: 57,
    entryText: "文化软实力显著增强",
    note: "文化软实力→教育 科技 人才",
    noteHighlights: [{ start: 0, end: 5, quote: "文化软实力" }],
    entryTextHighlights: [{ start: 0, end: 5, quote: "文化软实力" }],
    entryY: 0.42,
    outlinePath: [{ id: "chapter-3", title: "文化", level: 2 }],
    createdAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

test("复习书签只保存稳定位置引用，不复制或改写批注与高亮", () => {
  const source = record();
  const bookmark = createReviewBookmark(source, { type: "sprint", day: 3 });
  assert.equal(bookmark.recordId, source.id);
  assert.equal(bookmark.entryId, source.entryId);
  assert.equal(bookmark.page, source.page);
  assert.deepEqual(bookmark.scope, { type: "sprint", day: 3 });
  assert.equal("note" in bookmark, false);
  assert.equal("noteHighlights" in bookmark, false);
  assert.equal("entryTextHighlights" in bookmark, false);
});

test("重新标记会保留初次创建时间并产生更新版本", () => {
  const first = createReviewBookmark(record(), { type: "all" });
  const next = createReviewBookmark(record({ id: "record-8", entryId: "entry-8" }), { type: "chapter", chapterId: "chapter-3" }, first);
  assert.equal(next.createdAt, first.createdAt);
  assert.ok(Date.parse(next.updatedAt) > Date.parse(first.updatedAt));
  assert.equal(next.recordId, "record-8");
});

test("旧条目 ID 改变时仍可按版本和词条稳定定位", () => {
  const source = record();
  const bookmark = createReviewBookmark(source, { type: "library", level: 2 });
  const migrated = record({ id: "record-new-id" });
  assert.equal(findReviewBookmarkRecord(bookmark, [migrated]), migrated);
});

test("书签载入严格校验范围和时间，旧版本无书签兼容为空", () => {
  assert.equal(normalizeReviewBookmark(null), null);
  assert.equal(normalizeReviewBookmark({ schemaVersion: 1, recordId: "x" }), null);
  const bookmark = createReviewBookmark(record(), { type: "sprint", day: 5 });
  assert.deepEqual(normalizeReviewBookmark(JSON.parse(JSON.stringify(bookmark))), bookmark);
});
