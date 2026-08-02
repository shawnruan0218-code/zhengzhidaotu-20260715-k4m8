import { withBasePath } from "./app-config";
import {
  type KnowledgeAnswer,
  type KnowledgeIndex,
  type KnowledgeMatch,
  rankKnowledgeCandidates,
} from "./knowledge-search";
import {
  knowledgeHttpErrorMessage,
  shouldRetryKnowledgeRequest,
  waitForKnowledgeRetry,
} from "./knowledge-request";
import {
  CloudflareHttpError,
  cloudflareRequest,
  isCloudflareConfigured,
  readCloudflareSession,
} from "./cloudflare-client";

type FunctionResponse = {
  answer?: unknown;
  matches?: unknown;
  model?: unknown;
  usage?: unknown;
  error?: unknown;
};

let indexPromise: Promise<KnowledgeIndex> | null = null;

export function loadKnowledgeIndex() {
  if (!indexPromise) {
    indexPromise = fetch(withBasePath("/data/knowledge-index.json")).then(
      async (response) => {
        if (!response.ok) throw new Error("图谱文字索引加载失败");
        return (await response.json()) as KnowledgeIndex;
      },
    );
  }
  return indexPromise;
}

function normalizeFunctionAnswer(
  payload: FunctionResponse,
  candidates: KnowledgeMatch[],
): KnowledgeAnswer | null {
  if (typeof payload.answer !== "string" || !Array.isArray(payload.matches)) {
    return null;
  }
  const candidatesById = new Map(candidates.map((entry) => [entry.id, entry]));
  const matches = payload.matches
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const candidate =
        typeof record.id === "string" ? candidatesById.get(record.id) : null;
      if (!candidate) return null;
      return {
        ...candidate,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        queryLabels: Array.isArray(record.queryLabels)
          ? record.queryLabels.filter(
              (label): label is string => typeof label === "string",
            )
          : typeof record.queryLabel === "string"
            ? [record.queryLabel]
            : candidate.queryLabels,
        confidence:
          typeof record.confidence === "number"
            ? Math.max(0, Math.min(1, record.confidence))
            : undefined,
      };
    })
    .filter((match): match is NonNullable<typeof match> => match !== null);
  if (!matches.length) return null;
  return {
    answer: payload.answer,
    matches,
    model: typeof payload.model === "string" ? payload.model : undefined,
    usage:
      payload.usage &&
      typeof payload.usage === "object" &&
      typeof (payload.usage as Record<string, unknown>).promptTokens ===
        "number" &&
      typeof (payload.usage as Record<string, unknown>).completionTokens ===
        "number" &&
      typeof (payload.usage as Record<string, unknown>).totalTokens === "number"
        ? {
            promptTokens: (payload.usage as Record<string, number>).promptTokens,
            completionTokens: (payload.usage as Record<string, number>)
              .completionTokens,
            totalTokens: (payload.usage as Record<string, number>).totalTokens,
            cachedTokens:
              typeof (payload.usage as Record<string, unknown>).cachedTokens ===
              "number"
                ? (payload.usage as Record<string, number>).cachedTokens
                : 0,
          }
        : undefined,
    localOnly: false,
  };
}

function candidatePayload(entry: KnowledgeMatch) {
  return {
    id: entry.id,
    kind: entry.kind,
    page: entry.page,
    title: entry.title,
    text: entry.text,
    breadcrumb: entry.breadcrumb,
    queryLabels: entry.queryLabels,
  };
}

export async function searchKnowledge(
  rawQuery: string,
  signal: AbortSignal,
): Promise<KnowledgeAnswer> {
  const query = rawQuery.trim();
  if (query.length < 2) throw new Error("请输入至少两个字");
  const index = await loadKnowledgeIndex();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const candidates = rankKnowledgeCandidates(query, index.entries, 48);
  if (!candidates.length) {
    throw new Error("没有找到足够接近的图谱内容，请补充更完整的原文");
  }

  if (!isCloudflareConfigured()) {
    throw new Error("AI 检索服务尚未配置");
  }
  if (!readCloudflareSession()) throw new Error("请先使用 GitHub 登录后使用 AI 检索");

  let data: FunctionResponse = {};
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      data = await cloudflareRequest<FunctionResponse>("/knowledge-search", {
        method: "POST",
        body: { query, candidates: candidates.map(candidatePayload) },
        signal,
      });
      break;
    } catch (error) {
      if (
        error instanceof CloudflareHttpError &&
        attempt === 0 &&
        shouldRetryKnowledgeRequest(error.status)
      ) {
        await waitForKnowledgeRetry(650, signal);
        continue;
      }
      if (error instanceof CloudflareHttpError) {
        throw new Error(knowledgeHttpErrorMessage(error.status, error.message));
      }
      throw error;
    }
  }

  const answer = normalizeFunctionAnswer(data, candidates);
  if (!answer) throw new Error("模型返回内容无法匹配图谱词条");
  return answer;
}
