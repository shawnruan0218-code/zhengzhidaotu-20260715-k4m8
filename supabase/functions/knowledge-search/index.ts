import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  KNOWLEDGE_SYSTEM_PROMPT,
  formatKnowledgeCandidates,
  type ModelCandidate,
} from "./prompt.ts";
import {
  parseKnowledgeModelOutput,
  recoverKnowledgeModelOutput,
  type ParsedKnowledgeModelOutput,
} from "./model-output.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function isCandidate(value: unknown): value is ModelCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelCandidate>;
  return (
    typeof candidate.id === "string" &&
    (candidate.kind === "line" || candidate.kind === "area") &&
    typeof candidate.page === "number" &&
    typeof candidate.title === "string" &&
    typeof candidate.text === "string" &&
    Array.isArray(candidate.breadcrumb) &&
    candidate.breadcrumb.every((part) => typeof part === "string") &&
    (candidate.queryLabels === undefined ||
      (Array.isArray(candidate.queryLabels) &&
        candidate.queryLabels.every((label) => typeof label === "string")))
  );
}

function tokenPrice(model: string, promptTokens: number) {
  if (model === "Qwen/Qwen3.5-35B-A3B") {
    return promptTokens < 128_000
      ? { promptPerMillionCny: 0.4, completionPerMillionCny: 3.2 }
      : { promptPerMillionCny: 1.6, completionPerMillionCny: 12.8 };
  }
  return { promptPerMillionCny: 0, completionPerMillionCny: 0 };
}

async function requestModelCompletion({
  siliconFlowKey,
  model,
  query,
  candidateText,
  signal,
  repair = false,
}: {
  siliconFlowKey: string;
  model: string;
  query: string;
  candidateText: string;
  signal: AbortSignal;
  repair?: boolean;
}) {
  let response: Response;
  try {
    response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${siliconFlowKey}`,
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 1800,
        enable_thinking: false,
        temperature: repair ? 0 : 0.1,
        top_p: repair ? 0.5 : 0.65,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: repair
              ? `${KNOWLEDGE_SYSTEM_PROMPT}\n上一次输出格式不完整。请重新判断并只输出语法完全正确、可以直接 JSON.parse 的单个 JSON 对象。`
              : KNOWLEDGE_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: `用户查询：\n${query}\n\n图谱候选词条：\n${candidateText}`,
          },
        ],
      }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    console.error("SiliconFlow request failed", error);
    throw new Error("AI 服务连接不稳定，请重新检索");
  }
  if (!response.ok) {
    const details = await response.text();
    console.error("SiliconFlow error", response.status, details.slice(0, 500));
    throw new Error("硅基流动暂时不可用");
  }
  const completion = await response.json();
  if (typeof completion?.choices?.[0]?.message?.content !== "string") {
    throw new Error("模型未返回结果");
  }
  return completion;
}

function completionUsage(completion: Record<string, unknown>) {
  const usage =
    completion.usage && typeof completion.usage === "object"
      ? completion.usage as Record<string, unknown>
      : {};
  const promptTokens =
    typeof usage.prompt_tokens === "number"
      ? Math.max(0, Math.round(usage.prompt_tokens))
      : 0;
  const completionTokens =
    typeof usage.completion_tokens === "number"
      ? Math.max(0, Math.round(usage.completion_tokens))
      : 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      typeof usage.total_tokens === "number"
        ? Math.max(0, Math.round(usage.total_tokens))
        : promptTokens + completionTokens,
    cachedTokens:
      typeof usage.prompt_cache_hit_tokens === "number"
        ? Math.max(0, Math.round(usage.prompt_cache_hit_tokens))
        : 0,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return jsonResponse({ error: "请先登录" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const siliconFlowKey = Deno.env.get("SILICONFLOW_API_KEY");
  const model = Deno.env.get("SILICONFLOW_MODEL") || "Qwen/Qwen3.5-35B-A3B";
  if (!supabaseUrl || !publishableKey) return jsonResponse({ error: "Supabase 配置缺失" }, 500);
  if (!siliconFlowKey) return jsonResponse({ error: "硅基流动 API 尚未配置" }, 503);

  const authClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(
    authorization.slice("Bearer ".length),
  );
  if (authError || !authData.user) return jsonResponse({ error: "登录状态已失效" }, 401);

  let body: { query?: unknown; candidates?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "请求内容不是有效 JSON" }, 400);
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const candidates = Array.isArray(body.candidates)
    ? body.candidates.filter(isCandidate).slice(0, 48)
    : [];
  if (query.length < 2 || query.length > 1800) return jsonResponse({ error: "题目长度不符合要求" }, 400);
  if (!candidates.length) return jsonResponse({ error: "没有可供判断的图谱候选" }, 400);

  const candidateText = formatKnowledgeCandidates(candidates);

  const completions: Record<string, unknown>[] = [];
  let parsed: ParsedKnowledgeModelOutput | null = null;
  let modelContent = "";
  try {
    const firstCompletion = await requestModelCompletion({
      siliconFlowKey,
      model,
      query,
      candidateText,
      signal: request.signal,
    });
    completions.push(firstCompletion);
    modelContent = firstCompletion.choices[0].message.content;
    try {
      parsed = parseKnowledgeModelOutput(modelContent);
    } catch (firstParseError) {
      console.warn("Retrying invalid model JSON", firstParseError, modelContent.slice(0, 500));
      const repairedCompletion = await requestModelCompletion({
        siliconFlowKey,
        model,
        query,
        candidateText,
        signal: request.signal,
        repair: true,
      });
      completions.push(repairedCompletion);
      modelContent = repairedCompletion.choices[0].message.content;
      try {
        parsed = parseKnowledgeModelOutput(modelContent);
      } catch (repairParseError) {
        console.error("Failed to repair model JSON", repairParseError, modelContent.slice(0, 500));
        parsed = recoverKnowledgeModelOutput(
          modelContent,
          candidates.map((candidate) => candidate.id),
        );
      }
    }
  } catch (error) {
    if (request.signal.aborted) {
      return jsonResponse({ error: "检索已取消" }, 499);
    }
    return jsonResponse({
      error: error instanceof Error ? error.message : "AI 服务连接不稳定，请重新检索",
    }, 502);
  }

  try {
    if (!parsed) throw new Error("模型未返回可恢复的 JSON");
    const allowedIds = new Set(candidates.map((candidate) => candidate.id));
    const matches = Array.isArray(parsed.matches)
      ? parsed.matches
          .filter((match: unknown) => {
            if (!match || typeof match !== "object") return false;
            const record = match as Record<string, unknown>;
            return typeof record.id === "string" && allowedIds.has(record.id);
          })
          .slice(0, 10)
      : [];
    if (!matches.length) return jsonResponse({ error: "模型未选出有效图谱词条" }, 502);
    const usage = completions
      .map(completionUsage)
      .reduce(
        (total, current) => ({
          promptTokens: total.promptTokens + current.promptTokens,
          completionTokens: total.completionTokens + current.completionTokens,
          totalTokens: total.totalTokens + current.totalTokens,
          cachedTokens: total.cachedTokens + current.cachedTokens,
        }),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
      );
    const { promptTokens, completionTokens, totalTokens, cachedTokens } = usage;
    const pricing = tokenPrice(model, promptTokens);
    const estimatedCostCny =
      (promptTokens * pricing.promptPerMillionCny +
        completionTokens * pricing.completionPerMillionCny) /
      1_000_000;

    if (serviceRoleKey) {
      const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      });
      const { error: usageError } = await serviceClient.rpc(
        "zhengzhidaotu_20260715_k4m8_record_ai_usage",
        {
          p_user_id: authData.user.id,
          p_prompt_tokens: promptTokens,
          p_completion_tokens: completionTokens,
          p_total_tokens: totalTokens,
          p_cached_tokens: cachedTokens,
          p_estimated_cost_cny: estimatedCostCny,
          p_model: model,
        },
      );
      if (usageError) console.error("Failed to record account usage", usageError.message);
    }

    return jsonResponse({
      answer: typeof parsed.answer === "string" ? parsed.answer : "已找到对应知识点。",
      matches,
      model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
      },
    });
  } catch (error) {
    console.error("Invalid model result", error, modelContent.slice(0, 500));
    return jsonResponse({ error: "模型未能稳定生成结果，请重新检索" }, 502);
  }
});
