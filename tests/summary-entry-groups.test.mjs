import assert from "node:assert/strict";
import test from "node:test";

import {
  attachLegacySummaryIds,
  buildLegacySummaryGroups,
  buildSummaryGroups,
} from "../app/lib/summary-entry-groups.ts";

function block(id, text, y, lineIndex = Number(id.replace(/\D/g, ""))) {
  return { id, text, y, height: 0.012, lineIndexes: [lineIndex] };
}

test("易错点编号独立，而 OCR 漏掉标题的总结编号保持为一组", () => {
  const blocks = [
    block("b1", "易错点：", 0.01, 1),
    block("b2", "1.商品一定是劳动产品，但劳动产品不一定是商品", 0.03, 2),
    block("b3", "产品不是商品）", 0.043, 3),
    block("b4", "2.商品贯穿于商品经济的全部过程", 0.06, 4),
    block("b5", "13.商品伴随人类社会的始终", 0.08, 5),
    block("b6", "主义社会，都不存在商品）", 0.093, 6),
    block("b7", "1.使用价值：有用性、自然属性、社会财富", 0.12, 7),
    block("b8", "2.价值：无差别的一般人类劳动、社会属性", 0.137, 8),
    block("b9", "3.商品的价值是劳动创造的", 0.154, 9),
  ];

  assert.deepEqual(
    buildSummaryGroups(blocks).map((group) => group.map((entry) => entry.id)),
    [["b2", "b3"], ["b4"], ["b5", "b6"], ["b7", "b8", "b9"]],
  );
});

test("总结标题和其后的编号列表作为一个完整条目", () => {
  const blocks = [
    block("b1", "总结1：先有使用价值，再有价值，最后再谈交换价值", 0.01, 1),
    block("b2", "1.使用价值是价值存在的前提", 0.03, 2),
    block("b3", "2.使用价值是价值、交换价值的物质承担者", 0.05, 3),
  ];

  assert.deepEqual(buildSummaryGroups(blocks).map((group) => group.length), [3]);
});

test("带正文的单行易错点不会被当成空标题丢弃", () => {
  const blocks = [block("b1", "易错点：价值与使用价值互为前提（×）", 0.01, 1)];
  assert.deepEqual(buildSummaryGroups(blocks).map((group) => group[0].id), ["b1"]);
});

test("改进后的总结分组继承旧 ID 和别名，不需要改写已保存数据", () => {
  const blocks = [
    block("b1", "总结：", 0.01, 1),
    block("b2", "1.第一点", 0.03, 2),
    block("b3", "2.第二点", 0.05, 3),
  ];
  const legacy = buildLegacySummaryGroups(blocks).map((group, index) => ({
    id: `legacy-${index + 1}`,
    text: group.map((entry) => entry.text).join(""),
    y: group[0].y,
    height: 0.012,
    lineIndexes: group.flatMap((entry) => entry.lineIndexes),
  }));
  const improved = buildSummaryGroups(blocks).map((group) => ({
    id: "new-entry",
    text: group.map((entry) => entry.text).join(""),
    y: group[0].y,
    height: 0.05,
    lineIndexes: group.flatMap((entry) => entry.lineIndexes),
  }));
  const [compatible] = attachLegacySummaryIds(improved, legacy);

  assert.equal(compatible.id, "legacy-1");
  assert.deepEqual(compatible.legacyIds, ["legacy-2"]);
});
