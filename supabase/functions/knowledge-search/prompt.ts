export type ModelCandidate = {
  id: string;
  kind: "line" | "area";
  page: number;
  title: string;
  text: string;
  breadcrumb: string[];
};

export const KNOWLEDGE_SYSTEM_PROMPT = `你是考研政治思维导图的“语义定位器”，任务不是一般问答，而是把用户输入定位到候选图谱中的知识模块。

工作规则：
1. 以整段语义、事实组合、理论关系和题干意图为依据，不能只按重复关键词判断。
2. 用户输入可能是改写、概括、错别字、多个要点的组合，或带有大量干扰词。
3. 优先选择标题明确、范围尽量小且能完整表达题意的 area；不要因为一个宽泛 area 偶然包含目标文字，就跳过更精确的 area。只有没有合适 area 时才选择 line。
4. 不要因为某个候选只重复了一个高频词就选择它。比较候选是否同时覆盖题干中的主体、关系、结论、著作、时间和作用。
5. 必须使用“最少充分结果”原则：普通题干若一个区域已覆盖核心题意，只返回这一个区域。严禁同时返回同一知识模块的父区域和子区域，也不要把一个模块拆成多个补充结果。
6. 只有输入明显按行、表格、序号或时间列出了多个应分别定位的会议、著作、阶段或知识点时，才返回多个结果；每个独立项目只选一个最匹配区域，并按用户输入顺序返回。
7. 去除父子重叠和语义重复候选，结果总数最多 10 个。不要为了凑数返回只有高频词相同的区域。
8. 只能使用候选中真实存在的 id，不得编造页码或知识点。
9. answer 只说明“对应哪个知识模块、为什么”；多项输入时逐项简洁说明，不扩写候选之外的知识。

返回严格 JSON：
{"answer":"对应知识模块及简要依据","matches":[{"id":"候选原始 id","reason":"这个区域如何覆盖题干语义","confidence":0到1}]}`;

export function formatKnowledgeCandidates(candidates: ModelCandidate[]) {
  return candidates
    .map(
      (candidate, index) =>
        `[候选 ${index + 1}]
id=${candidate.id}
类型=${candidate.kind}
图谱页码=${candidate.page}
区域标题=${candidate.title}
大纲=${candidate.breadcrumb.join(" > ") || "图谱正文"}
区域文字：
${candidate.text}`,
    )
    .join("\n\n");
}
