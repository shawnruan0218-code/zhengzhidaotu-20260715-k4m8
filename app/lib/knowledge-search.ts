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
  focusX?: number;
  focusY?: number;
  focusWidth?: number;
  focusHeight?: number;
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
  queryLabels?: string[];
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

function distinctiveAnchors(rawQuery: string) {
  const anchors = new Set<string>();
  const patterns = [
    /(?:中国共产党|中共|党(?:的)?)?第?[一二三四五六七八九十百0-9]+届(?:[一二三四五六七八九十0-9]+中)?全会/g,
    /(?:中国共产党|中共|党(?:的)?)?[一二三四五六七八九十百0-9]+大/g,
    /《[^》\r\n]{2,30}》/g,
    /(?:邓小平|毛泽东|习近平)?南方谈话/g,
  ];
  patterns.forEach((pattern) => {
    rawQuery.match(pattern)?.forEach((match) => {
      const anchor = normalize(match);
      if (anchor.length >= 4) anchors.add(anchor);
    });
  });
  return [...anchors];
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
  const queryAnchors = distinctiveAnchors(rawQuery);

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
      queryAnchors.forEach((anchor) => {
        if (text.includes(anchor)) score += 86;
        else if (context.includes(anchor)) score += 42;
      });

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

export type KnowledgeQueryUnit = {
  label: string;
  text: string;
};

export function extractKnowledgeQueryUnits(
  rawQuery: string,
): KnowledgeQueryUnit[] {
  const optionPattern =
    /(^|[\r\n]|\s)([A-Ja-j])\s*(?:[.．、:：)）]\s*|(?=[对错](?:\s*[:：]|\s*(?:\r?\n|$))))/g;
  const markers: Array<{
    label: string;
    markerStart: number;
    contentStart: number;
  }> = [];
  let optionMatch: RegExpExecArray | null;
  while ((optionMatch = optionPattern.exec(rawQuery)) !== null) {
    markers.push({
      label: optionMatch[2].toUpperCase(),
      markerStart: optionMatch.index,
      contentStart: optionPattern.lastIndex,
    });
  }

  if (markers.length >= 2) {
    return markers
      .map((marker, index) => ({
        label: marker.label,
        text: rawQuery
          .slice(
            marker.contentStart,
            markers[index + 1]?.markerStart ?? rawQuery.length,
          )
          .trim(),
      }))
      .filter((unit) => normalize(unit.text).length >= 4)
      .slice(0, 10);
  }

  const rawSegments = rawQuery
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const structuredLinePattern =
    /^(?:[-•·]\s*|[（(]?\d{1,3}[）).．、:：]\s*|[一二三四五六七八九十]+[、.．）)]\s*|(?:19|20)\d{2}\s+)/u;
  const sentenceLines = rawSegments.filter((line) => /[。！？!?]$/.test(line));
  const structuredLines = rawSegments.filter(
    (line) => structuredLinePattern.test(line) || /[\t|｜]/.test(line),
  );
  const paragraphLike =
    rawSegments.length >= 2 &&
    sentenceLines.length >= 2 &&
    structuredLines.length < 2;
  if (paragraphLike) return [];

  const segments = rawSegments
    .map((line) =>
      line
        .replace(/^[\s|｜:：\-—]+|[\s|｜:：\-—]+$/g, "")
        .replace(/^(会议|核心标志性提法|知识点|题目|选项)$/u, "")
        .trim(),
    )
    .filter((line) => normalize(line).length >= 6);

  return segments.length >= 2
    ? [...new Set(segments)]
        .slice(0, 10)
        .map((text, index) => ({ label: `第${index + 1}项`, text }))
    : [];
}

export function rankKnowledgeCandidates(
  rawQuery: string,
  entries: KnowledgeEntry[],
  limit = 48,
): KnowledgeMatch[] {
  const units = extractKnowledgeQueryUnits(rawQuery);
  if (!units.length) return rankKnowledgeEntries(rawQuery, entries, limit);

  const merged = new Map<string, KnowledgeMatch>();
  const addMatches = (matches: KnowledgeMatch[], queryLabel?: string) => {
    matches.forEach((match) => {
      const existing = merged.get(match.id);
      const queryLabels = queryLabel
        ? [...new Set([...(existing?.queryLabels ?? []), queryLabel])]
        : existing?.queryLabels;
      if (!existing || match.score > existing.score) {
        merged.set(match.id, { ...match, queryLabels });
      } else if (queryLabels !== existing.queryLabels) {
        merged.set(match.id, { ...existing, queryLabels });
      }
    });
  };

  // A/B/C/D 选项、表格或分行输入中的每一项都是独立语义单元。
  // 先按轮次为每项保留自己的候选名额，避免某一选项的高分结果
  // 在最终截断时挤掉其他选项，再用整段召回补足剩余名额。
  const groupedMatches = units.map((unit) => ({
    unit,
    matches: rankKnowledgeEntries(unit.text, entries, 10),
  }));
  for (let rank = 0; rank < 10 && merged.size < limit; rank += 1) {
    groupedMatches.forEach(({ unit, matches }) => {
      const match = matches[rank];
      if (match && merged.size < limit) addMatches([match], unit.label);
    });
  }
  addMatches(rankKnowledgeEntries(rawQuery, entries, 24));

  return [...merged.values()].slice(0, limit);
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
