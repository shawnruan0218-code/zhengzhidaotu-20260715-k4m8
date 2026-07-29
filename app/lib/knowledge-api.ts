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
import { getSupabaseClient } from "./supabase-client";

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

  const client = getSupabaseClient();
  const session = client ? (await client.auth.getSession()).data.session : null;
  if (!client || !session) throw new Error("请先登录账号后使用 AI 检索");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    throw new Error("AI 检索服务尚未配置");
  }

  const endpoint = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/knowledge-search`;
  const requestBody = JSON.stringify({
    query,
    candidates: candidates.map(candidatePayload),
  });
  let data: FunctionResponse = {};
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: publishableKey,
        "Content-Type": "application/json",
      },
      body: requestBody,
      signal,
    });
    data = (await response.json().catch(() => ({}))) as FunctionResponse;
    if (response.ok) break;
    if (attempt === 0 && shouldRetryKnowledgeRequest(response.status)) {
      await waitForKnowledgeRetry(650, signal);
      continue;
    }
    throw new Error(
      knowledgeHttpErrorMessage(
        response.status,
        typeof data.error === "string" ? data.error : undefined,
      ),
    );
  }

  const answer = normalizeFunctionAnswer(data, candidates);
  if (!answer) throw new Error("模型返回内容无法匹配图谱词条");
  return answer;
}
