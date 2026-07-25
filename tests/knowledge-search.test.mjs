import assert from "node:assert/strict";
import test from "node:test";
import {
  localKnowledgeAnswer,
  rankKnowledgeCandidates,
  rankKnowledgeEntries,
} from "../app/lib/knowledge-search.ts";

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
