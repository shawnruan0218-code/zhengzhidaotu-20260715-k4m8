export type ParsedKnowledgeModelOutput = {
  answer?: unknown;
  matches?: unknown;
};

function balancedJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function escapeStringControlCharacters(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) {
        result += character;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        result += character;
        escaped = true;
        continue;
      }
      if (character === '"') {
        result += character;
        inString = false;
        continue;
      }
      if (character === "\n") {
        result += "\\n";
        continue;
      }
      if (character === "\r") {
        result += "\\r";
        continue;
      }
      if (character === "\t") {
        result += "\\t";
        continue;
      }
      result += character;
      continue;
    }
    result += character;
    if (character === '"') inString = true;
  }
  return result;
}

export function parseKnowledgeModelOutput(
  value: string,
): ParsedKnowledgeModelOutput {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced ?? value).replace(/^\uFEFF/, "").trim();
  const balanced = balancedJsonObject(source);
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  const raw =
    balanced ??
    (start >= 0 && end > start ? source.slice(start, end + 1) : source);
  const variants = [
    raw,
    raw.replace(/,\s*([}\]])/g, "$1"),
    escapeStringControlCharacters(raw).replace(/,\s*([}\]])/g, "$1"),
  ];
  let lastError: unknown;
  for (const candidate of [...new Set(variants)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed as ParsedKnowledgeModelOutput;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("模型未返回有效 JSON");
}

export function recoverKnowledgeModelOutput(
  value: string,
  allowedIds: string[],
): ParsedKnowledgeModelOutput | null {
  const matches = allowedIds
    .map((id) => ({ id, offset: value.indexOf(id) }))
    .filter((item) => item.offset >= 0)
    .sort((left, right) => left.offset - right.offset)
    .slice(0, 10)
    .map(({ id }) => ({
      id,
      reason: "模型已定位到该知识点，返回格式已自动恢复",
      confidence: 0.7,
    }));
  if (!matches.length) return null;
  return {
    answer: "已自动恢复模型返回的知识点，请点击对应考点查看原文。",
    matches,
  };
}
