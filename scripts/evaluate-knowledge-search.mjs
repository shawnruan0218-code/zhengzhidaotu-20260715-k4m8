import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rankKnowledgeCandidates } from "../app/lib/knowledge-search.ts";
import {
  KNOWLEDGE_SYSTEM_PROMPT,
  formatKnowledgeCandidates,
} from "../supabase/functions/knowledge-search/prompt.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiKey = process.env.SILICONFLOW_API_KEY;
const model = process.env.SILICONFLOW_MODEL || "Qwen/Qwen3.5-35B-A3B";
if (!apiKey) throw new Error("SILICONFLOW_API_KEY is required");

const knowledgeIndex = JSON.parse(
  await readFile(path.join(root, "public", "data", "knowledge-index.json"), "utf8"),
);
const cases = [
  {
    name: "马克思主义创立条件",
    query: `马克思主义产生：
社会根源：资本主义经济的发展
阶级基础：无产阶级反抗资产阶级的日益激化
思想渊源：德国古典，英国古典，英法空想`,
    expectedPage: 1,
    expectedTitle: "创立条件",
    expectedMatchCount: 1,
  },
  {
    name: "时空观",
    query: "时空是运动的存在形式，物质是运动的载体。",
    expectedPage: 3,
    expectedTitle: "时间和空间",
    maxMatchCount: 2,
  },
  {
    name: "论十大关系",
    query:
      "毛泽东在《论十大关系》的报告中，初步总结了我国社会主义建设的经验，明确提出要以苏为鉴，独立自主地探索适合中国情况的社会主义建设道路。《论十大关系》标志着党探索中国社会主义建设道路的良好开端。",
    expectedPage: 45,
    expectedTitle: "论十大关系",
    expectedMatchCount: 1,
  },
  {
    name: "十二大至十五大会议提法",
    query: `会议 核心标志性提法
1982 十二大 建设有中国特色的社会主义
1987 十三大 社会主义初级阶段理论、基本路线
1992 十四大 建立社会主义市场经济体制
1997 十五大 邓小平理论写入党章，明确首要基本问题`,
    expectedItems: [
      ["十二大", "1982"],
      ["十三大", "1987"],
      ["十四大", "1992"],
      ["十五大", "1997"],
    ],
    expectedMatchCount: 4,
  },
  {
    name: "南方谈话四选项全覆盖",
    query: `1992年，邓小平同志在南方谈话中明确指出，“计划经济不等于社会主义，资本主义也有计划；市场经济不等于资本主义，社会主义也有市场，计划和市场都是经济手段”。这一精辟论述（）
A.为形成社会主义市场经济理论开辟了道路 党的十一届六中全会提出了“计划经济为主、市场调节为辅”的方针
B.是社会主义经济理论的重大突破 党的十二届三中全会提出“公有制基础上的有计划的商品经济”的概念
C.明确把建立社会主义市场经济体制作为我国经济体制改革的目标 党的十四大
D.标志着邓小平同志的社会主义市场经济理论的形成`,
    expectedLabels: ["A", "B", "C", "D"],
    expectedMatchCount: 4,
  },
];
const selectedCases = process.env.EVAL_CASE
  ? cases.filter((testCase) => testCase.name.includes(process.env.EVAL_CASE))
  : cases;

function parseJsonContent(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content;
  return JSON.parse(candidate.slice(candidate.indexOf("{"), candidate.lastIndexOf("}") + 1));
}

const reports = [];
for (const testCase of selectedCases) {
  const candidates = rankKnowledgeCandidates(testCase.query, knowledgeIndex.entries, 48);
  const candidatePayload = candidates.map((candidate) => ({
    id: candidate.id,
    kind: candidate.kind,
    page: candidate.page,
    title: candidate.title,
    text: candidate.text,
    breadcrumb: candidate.breadcrumb,
    queryLabels: candidate.queryLabels,
  }));
  const startedAt = Date.now();
  const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 1200,
      enable_thinking: false,
      temperature: 0.1,
      top_p: 0.65,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: KNOWLEDGE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `用户查询：\n${testCase.query}\n\n图谱候选区域：\n${formatKnowledgeCandidates(candidatePayload)}`,
        },
      ],
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    const report = {
      name: testCase.name,
      ok: false,
      status: response.status,
      error: body?.message ?? body?.error?.message ?? "API request failed",
    };
    reports.push(report);
    console.log(JSON.stringify({ model, report }, null, 2));
    continue;
  }
  const parsed = parseJsonContent(body?.choices?.[0]?.message?.content ?? "");
  const selected = Array.isArray(parsed.matches)
    ? parsed.matches
        .map((match) => ({
          ...match,
          candidate: candidatePayload.find((candidate) => candidate.id === match.id),
        }))
        .filter((match) => match.candidate)
    : [];
  const selectedText = selected.map((match) =>
    [
      match.candidate.title,
      match.candidate.text,
      ...match.candidate.breadcrumb,
    ].join("\n"),
  );
  const singleMatchOk =
    selected.some(
      (match) =>
        match.candidate.page === testCase.expectedPage &&
        `${match.candidate.title}\n${match.candidate.text}`.includes(testCase.expectedTitle),
    );
  const multipleMatchesOk = testCase.expectedItems?.every((needles) =>
    selectedText.some((text) => needles.every((needle) => text.includes(needle))),
  );
  const matchCountOk =
    (testCase.expectedMatchCount === undefined ||
      selected.length === testCase.expectedMatchCount) &&
    (testCase.maxMatchCount === undefined || selected.length <= testCase.maxMatchCount);
  const labelsOk =
    testCase.expectedLabels === undefined ||
    testCase.expectedLabels.every((label) =>
      selected.some(
        (match) =>
          Array.isArray(match.queryLabels) &&
          match.queryLabels.includes(label),
      ),
    );
  const report = {
    name: testCase.name,
    ok:
      (testCase.expectedLabels
        ? labelsOk
        : testCase.expectedItems
          ? multipleMatchesOk
          : singleMatchOk) && matchCountOk,
    answer: parsed.answer,
    selected: selected.map((match) => ({
      id: match.id,
      page: match.candidate.page,
      title: match.candidate.title,
      queryLabels: match.queryLabels,
      reason: match.reason,
      confidence: match.confidence,
    })),
    usage: body.usage,
    durationMs: Date.now() - startedAt,
  };
  reports.push(report);
  console.log(JSON.stringify({ model, report }, null, 2));
}

console.log(JSON.stringify({ model, allPassed: reports.every((report) => report.ok) }, null, 2));
if (reports.some((report) => !report.ok)) process.exitCode = 1;
