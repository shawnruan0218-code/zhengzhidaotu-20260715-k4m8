import assert from "node:assert/strict";
import test from "node:test";
import {
  createFiveDaySprintPlan,
  fiveDaySprintDayForRecord,
  normalizeFiveDaySprintPlan,
  recordsByFiveDaySprint,
} from "../app/lib/five-day-sprint.ts";

const outline = Array.from({ length: 10 }, (_, index) => ({
  id: `chapter-${index + 1}`,
  title: `章节 ${index + 1}`,
  page: index + 1,
  y: 0,
}));

function record(index, chapterIndex = index) {
  return {
    id: `version::entry-${index}`,
    versionId: "version",
    versionName: "默认版本",
    entryId: `entry-${index}`,
    page: chapterIndex + 1,
    entryText: `词条 ${index}`,
    note: `批注 ${index}`,
    noteHighlights: [{ start: 0, end: 2, quote: "批注" }],
    entryTextHighlights: [{ start: 0, end: 2, quote: "词条" }],
    entryY: index / 100,
    outlinePath: [{ id: `chapter-${chapterIndex + 1}`, title: `章节 ${chapterIndex + 1}`, level: 1 }],
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

test("首次计划按章节连续顺序把批注近似均分成五天", () => {
  const records = Array.from({ length: 20 }, (_, index) => record(index, Math.floor(index / 2)));
  const plan = createFiveDaySprintPlan(outline, records, "2026-08-30T00:00:00.000Z");
  const grouped = recordsByFiveDaySprint(outline, records, plan);
  assert.deepEqual(Object.values(grouped).map((items) => items.length), [4, 4, 4, 4, 4]);
  assert.deepEqual(Object.values(grouped).flat().map((item) => item.id), records.map((item) => item.id));
});

test("不会为了数字完全平均而拆开同一个章节", () => {
  const records = Array.from({ length: 12 }, (_, index) => record(index, 0));
  const plan = createFiveDaySprintPlan(outline, records, "2026-08-30T00:00:00.000Z");
  const grouped = recordsByFiveDaySprint(outline, records, plan);
  assert.equal(Object.values(grouped).filter((items) => items.length > 0).length, 1);
  assert.equal(Object.values(grouped).flat().length, 12);
});

test("分组只返回原批注引用，不改写高亮或批注内容", () => {
  const records = [record(0, 0), record(1, 1)];
  const snapshot = structuredClone(records);
  const plan = createFiveDaySprintPlan(outline, records, "2026-08-30T00:00:00.000Z");
  const flattened = Object.values(recordsByFiveDaySprint(outline, records, plan)).flat();
  assert.deepEqual(records, snapshot);
  assert.equal(flattened[0], records[0]);
  assert.deepEqual(flattened[0].noteHighlights, snapshot[0].noteHighlights);
  assert.deepEqual(flattened[0].entryTextHighlights, snapshot[0].entryTextHighlights);
});

test("后续新增批注固定加入其章节原先分配的天数", () => {
  const initial = Array.from({ length: 10 }, (_, index) => record(index, index));
  const plan = createFiveDaySprintPlan(outline, initial, "2026-08-30T00:00:00.000Z");
  const added = record(99, 3);
  assert.equal(fiveDaySprintDayForRecord(plan, added), plan.chapterDayById["chapter-4"]);
  assert.deepEqual(normalizeFiveDaySprintPlan(JSON.parse(JSON.stringify(plan))), plan);
});
