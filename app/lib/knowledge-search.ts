export type KnowledgeEntry = {
  id: string;
  kind: "line" | "area";
  page: number;
  sourcePage: number;
  title: string;
  text: string;
  breadcrumb: string[];
  x: number;
  y: number;
  width: number;
  height: number;
};

export type KnowledgeIndex = {
  schemaVersion: number;
  pageCount: number;
  entryCount: number;
  sourceLineCount: number;
  entries: KnowledgeEntry[];
};

export type KnowledgeMatch = KnowledgeEntry & {
  score: number;
  reason?: string;
  confidence?: number;
};

export type KnowledgeAnswer = {
  answer: string;
  matches: KnowledgeMatch[];
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
  };
  localOnly: boolean;
  warning?: string;
};

function normalize(value: string) {
  return value
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？；：、,.!?;:'"“”‘’（）()\[\]【】《》〈〉—\-_/\\]/g, "");
}

function ngrams(value: string, size: number) {
  const result = new Set<string>();
  if (value.length < size) {
    if (value) result.add(value);
    return result;
  }
  for (let index = 0; index <= value.length - size; index += 1) {
    result.add(value.slice(index, index + size));
  }
  return result;
}

function overlapScore(query: Set<string>, target: Set<string>) {
  if (!query.size || !target.size) return 0;
  let intersection = 0;
  query.forEach((token) => {
    if (target.has(token)) intersection += 1;
  });
  const recall = intersection / query.size;
  const precision = intersection / target.size;
  return recall * 0.72 + precision * 0.28;
}

export function rankKnowledgeEntries(
  rawQuery: string,
  entries: KnowledgeEntry[],
  limit = 24,
): KnowledgeMatch[] {
  const query = normalize(rawQuery);
  if (!query) return [];
  const queryBigrams = ngrams(query, 2);
  const queryTrigrams = ngrams(query, 3);

  return entries
    .map((entry) => {
      const text = normalize(entry.text);
      const context = normalize(entry.breadcrumb.join(" "));
      if (!text) return { ...entry, score: 0 };

      let score = 0;
      if (text === query) score += 120;
      if (text.includes(query)) score += 50 + Math.min(20, (query.length / text.length) * 20);
      if (query.includes(text) && text.length >= 4) {
        score += 22 + Math.min(18, (text.length / query.length) * 18);
      }
      if (context.includes(query)) score += 24;

      score += overlapScore(queryBigrams, ngrams(text, 2)) * 42;
      score += overlapScore(queryTrigrams, ngrams(text, 3)) * 52;
      score += overlapScore(queryBigrams, ngrams(context, 2)) * 14;

      // Tiny OCR fragments are useful for exact matches, but should not crowd
      // out complete knowledge statements in question-style searches.
      if (text.length <= 3 && query.length > 6 && !query.includes(text)) score *= 0.22;
      if (entry.kind === "area" && query.length >= 8) {
        const specificity = Math.min(1.2, Math.max(0.72, Math.sqrt(480 / text.length)));
        score *= 1.9 * specificity;
      }
      return { ...entry, score };
    })
    .filter((entry) => entry.score >= 3.5)
    .sort((left, right) => right.score - left.score || left.text.length - right.text.length)
    .slice(0, limit);
}

function splitKnowledgeQuery(rawQuery: string) {
  const segments = rawQuery
    .split(/\r?\n|[；;]/)
    .map((line) =>
      line
        .replace(/^[\s|｜:：\-—]+|[\s|｜:：\-—]+$/g, "")
        .replace(/^(会议|核心标志性提法|知识点|题目|选项)$/u, "")
        .trim(),
    )
    .filter((line) => normalize(line).length >= 6);

  return segments.length >= 2 ? [...new Set(segments)].slice(0, 10) : [];
}

export function rankKnowledgeCandidates(
  rawQuery: string,
  entries: KnowledgeEntry[],
  limit = 48,
): KnowledgeMatch[] {
  const segments = splitKnowledgeQuery(rawQuery);
  if (!segments.length) return rankKnowledgeEntries(rawQuery, entries, limit);

  const merged = new Map<string, KnowledgeMatch>();
  const addMatches = (matches: KnowledgeMatch[]) => {
    matches.forEach((match) => {
      const existing = merged.get(match.id);
      if (!existing || match.score > existing.score) merged.set(match.id, match);
    });
  };

  // 表格或分行输入中的每一行都是一个独立语义单元。先为各行保留候选，
  // 再补充整段召回，避免其中一行的高频词挤掉其他知识点。
  segments.forEach((segment) => addMatches(rankKnowledgeEntries(segment, entries, 8)));
  addMatches(rankKnowledgeEntries(rawQuery, entries, 24));

  return [...merged.values()]
    .sort((left, right) => right.score - left.score || left.text.length - right.text.length)
    .slice(0, limit);
}

export function localKnowledgeAnswer(query: string, matches: KnowledgeMatch[]): KnowledgeAnswer {
  const top = matches.slice(0, 6);
  return {
    answer: top.length
      ? `已从图谱文字中找到与“${query.trim()}”最接近的知识点。`
      : "图谱文字中暂未找到足够接近的内容，请换一个关键词或粘贴更完整的题干。",
    matches: top,
    localOnly: true,
  };
}
