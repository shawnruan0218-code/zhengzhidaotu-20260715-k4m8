import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  extractKnowledgeQueryUnits,
  localKnowledgeAnswer,
  rankKnowledgeCandidates,
  rankKnowledgeEntries,
} from "../app/lib/knowledge-search.ts";
import {
  friendlyKnowledgeError,
  knowledgeHttpErrorMessage,
  shouldRetryKnowledgeRequest,
} from "../app/lib/knowledge-request.ts";
import {
  parseKnowledgeModelOutput,
  recoverKnowledgeModelOutput,
} from "../supabase/functions/knowledge-search/model-output.ts";

const builtKnowledgeIndex = JSON.parse(
  readFileSync(new URL("../public/data/knowledge-index.json", import.meta.url), "utf8"),
);

const entries = [
  {
    id: "knowledge-p1-l1",
    kind: "line",
    page: 1,
    sourcePage: 6,
    title: "实践是检验真理的唯一标准",
    text: "实践是检验真理的唯一标准",
    breadcrumb: ["认识论", "真理与价值"],
    x: 0.2,
    y: 0.3,
    width: 0.2,
    height: 0.03,
  },
  {
    id: "knowledge-p2-l2",
    kind: "line",
    page: 2,
    sourcePage: 7,
    title: "物质是标志客观实在的哲学范畴",
    text: "物质是标志客观实在的哲学范畴",
    breadcrumb: ["唯物论", "物质观"],
    x: 0.4,
    y: 0.5,
    width: 0.3,
    height: 0.03,
  },
];

test("exact political knowledge phrases rank first", () => {
  const matches = rankKnowledgeEntries("下面哪一项说明实践是检验真理的唯一标准？", entries);
  assert.equal(matches[0]?.id, "knowledge-p1-l1");
});

test("outline context participates in retrieval", () => {
  const matches = rankKnowledgeEntries("物质观", entries);
  assert.equal(matches[0]?.id, "knowledge-p2-l2");
});

test("local fallback keeps stable page coordinates", () => {
  const matches = rankKnowledgeEntries("客观实在", entries);
  const answer = localKnowledgeAnswer("客观实在", matches);
  assert.equal(answer.localOnly, true);
  assert.equal(answer.matches[0]?.page, 2);
  assert.equal(answer.matches[0]?.x, 0.4);
});

test("multi-line queries preserve candidates for each independent item", () => {
  const conferenceEntries = [
    ["p12", "十二大提出建设有中国特色的社会主义"],
    ["p13", "十三大系统阐述社会主义初级阶段理论和基本路线"],
    ["p14", "十四大提出建立社会主义市场经济体制"],
    ["p15", "十五大把邓小平理论写入党章"],
  ].map(([id, text], index) => ({
    ...entries[0],
    id,
    kind: "area",
    page: index + 10,
    title: text,
    text,
  }));
  const matches = rankKnowledgeCandidates(
    `1982 十二大 建设有中国特色的社会主义
1987 十三大 社会主义初级阶段理论、基本路线
1992 十四大 建立社会主义市场经济体制
1997 十五大 邓小平理论写入党章`,
    conferenceEntries,
    10,
  );
  assert.deepEqual(new Set(matches.map((match) => match.id)), new Set(["p12", "p13", "p14", "p15"]));
});

test("A/B/C/D questions are split into independent retrieval units", () => {
  const units = extractKnowledgeQueryUnits(
    "题干（ ） A.第一个知识点 B.第二个知识点\nC.第三个知识点 D.第四个知识点",
  );
  assert.deepEqual(
    units.map((unit) => unit.label),
    ["A", "B", "C", "D"],
  );
  assert.deepEqual(
    units.map((unit) => unit.text),
    ["第一个知识点", "第二个知识点", "第三个知识点", "第四个知识点"],
  );
});

test("market economy option question preserves candidates for all four options", () => {
  const query = `1992年，邓小平同志在南方谈话中指出，计划和市场都是经济手段。这一精辟论述（）
A.为形成社会主义市场经济理论开辟了道路 党的十一届六中全会提出“计划经济为主、市场调节为辅”
B.是社会主义经济理论的重大突破 党的十二届三中全会提出“公有制基础上的有计划的商品经济”
C.明确把建立社会主义市场经济体制作为我国经济体制改革的目标 党的十四大
D.标志着邓小平同志的社会主义市场经济理论的形成`;
  const matches = rankKnowledgeCandidates(
    query,
    builtKnowledgeIndex.entries,
    48,
  );
  const labels = new Set(matches.flatMap((match) => match.queryLabels ?? []));
  assert.deepEqual(labels, new Set(["A", "B", "C", "D"]));
  assert.ok(
    matches.some(
      (match) =>
        match.queryLabels?.includes("B") &&
        `${match.title}\n${match.text}`.includes("十二届三中全会"),
    ),
  );
  assert.ok(
    matches.some(
      (match) =>
        match.queryLabels?.includes("C") &&
        `${match.title}\n${match.text}`.includes("建立社会主义市场经济体制"),
    ),
  );
  assert.ok(
    matches.some(
      (match) =>
        match.queryLabels?.includes("D") &&
        `${match.title}\n${match.text}`.includes("社会主义市场经济理论的形成"),
    ),
  );
});

test("area matches preserve a smaller exact-entry locator", () => {
  assert.equal(builtKnowledgeIndex.schemaVersion, 2);
  const area = builtKnowledgeIndex.entries.find(
    (entry) =>
      entry.kind === "area" &&
      entry.focusWidth > 0 &&
      entry.focusHeight > 0 &&
      (entry.focusWidth < entry.width || entry.focusHeight < entry.height),
  );
  assert.ok(area);
  assert.ok(area.focusX >= area.x - 0.0000001);
  assert.ok(area.focusY >= area.y - 0.0000001);
  assert.ok(area.focusX + area.focusWidth <= area.x + area.width + 0.0000001);
  assert.ok(area.focusY + area.focusHeight <= area.y + area.height + 0.0000001);
});

test("transient AI service failures are retried and shown in Chinese", () => {
  assert.equal(shouldRetryKnowledgeRequest(502), true);
  assert.equal(shouldRetryKnowledgeRequest(401), false);
  assert.equal(
    friendlyKnowledgeError(
      new Error("Edge Function returned a non-2xx status code"),
    ),
    "AI 服务暂时繁忙，请重新检索",
  );
  assert.equal(
    knowledgeHttpErrorMessage(504),
    "AI 检索等待时间过长，请重新检索",
  );
});

test("model output parser tolerates fences, trailing commas, and extra text", () => {
  const parsed = parseKnowledgeModelOutput(`
说明文字
\`\`\`json
{"answer":"已定位","matches":[{"id":"p1","confidence":0.9,}],}
\`\`\`
`);
  assert.equal(parsed.answer, "已定位");
  assert.deepEqual(parsed.matches, [{ id: "p1", confidence: 0.9 }]);
});

test("damaged model output recovers valid candidate ids", () => {
  const recovered = recoverKnowledgeModelOutput(
    '{"matches":[{"id":"p2"},{"id":"p1","reason":"未结束',
    ["p1", "p2", "p3"],
  );
  assert.deepEqual(
    recovered?.matches.map((match) => match.id),
    ["p2", "p1"],
  );
});

test("same river explanation recalls absolute motion and relative rest", () => {
  const query = `河水一直在流，第二次踏进去时，水已经不是刚才的水了。
所以它强调：世界是运动变化的。
但它还叫“同一条河流”，说明这条河还有相对稳定的一面。
河水变了，但河道、名字、整体结构还在，所以它仍然可以被叫作“同一条河”。
所以前者是辩证法：既承认运动变化，又承认相对稳定。`;
  const matches = rankKnowledgeCandidates(query, builtKnowledgeIndex.entries, 48);
  const ids = new Set(matches.map((match) => match.id));
  assert.equal(ids.has("area-knowledge-p3-l43"), true);
  assert.equal(ids.has("area-knowledge-p3-l27"), true);
});
