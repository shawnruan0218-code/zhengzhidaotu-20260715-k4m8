/// <reference types="@cloudflare/workers-types" />

import {
  KNOWLEDGE_SYSTEM_PROMPT,
  formatKnowledgeCandidates,
  type ModelCandidate,
} from "../../supabase/functions/knowledge-search/prompt.ts";
import {
  parseKnowledgeModelOutput,
  recoverKnowledgeModelOutput,
  type ParsedKnowledgeModelOutput,
} from "../../supabase/functions/knowledge-search/model-output.ts";

const NAMESPACE = "zhengzhidaotu_20260715_k4m8";
const ITEM_PREFIX = `${NAMESPACE}:`;
const USERS = `${NAMESPACE}_users`;
const OAUTH_STATES = `${NAMESPACE}_oauth_states`;
const SESSIONS = `${NAMESPACE}_sessions`;
const ITEMS = `${NAMESPACE}_items`;
const AI_USAGE = `${NAMESPACE}_ai_usage`;
const MAX_SYNC_RECORDS = 100;
const PULL_PAGE_SIZE = 200;

interface Env {
  DB: D1Database;
  APP_ORIGINS: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SILICONFLOW_API_KEY: string;
  SILICONFLOW_MODEL?: string;
}

type CloudUser = {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
};

type StoredItem = {
  id: string;
  user_id: string;
  item_key: string;
  item_type: string;
  item_data: string;
  added_at: string;
  updated_at: string;
  server_changed_at: string;
  deleted_at: string | null;
};

type IncomingItem = {
  item_key: string;
  item_type: string;
  item_data: Record<string, unknown>;
  added_at: string;
  updated_at: string;
  deleted_at: string | null;
};

function allowedOrigins(env: Env): string[] {
  return env.APP_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function requestOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  return origin && allowedOrigins(env).includes(origin) ? origin : null;
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = requestOrigin(request, env);
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(request: Request, env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeReturnTo(raw: string | null, env: Env): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!allowedOrigins(env).includes(url.origin)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/auth/callback`;
}

async function startGithubLogin(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return json(request, env, { error: "GitHub 登录尚未配置" }, 503);
  }
  const returnTo = normalizeReturnTo(new URL(request.url).searchParams.get("return_to"), env);
  if (!returnTo) return json(request, env, { error: "登录返回地址不受信任" }, 400);
  const state = randomToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO ${OAUTH_STATES} (state_hash,return_to,expires_at,created_at) VALUES (?1,?2,?3,?4)`,
  ).bind(await sha256(state), returnTo, expiresAt, createdAt).run();
  await env.DB.prepare(`DELETE FROM ${OAUTH_STATES} WHERE expires_at < ?1`).bind(createdAt).run();

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callbackUrl(request));
  authorize.searchParams.set("scope", "read:user user:email");
  authorize.searchParams.set("state", state);
  return redirect(authorize.toString());
}

async function githubJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "zhengzhidaotu-20260715-k4m8",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return (await response.json()) as T;
}

async function finishGithubLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const stateHash = await sha256(state);
  const stored = await env.DB.prepare(
    `SELECT return_to,expires_at FROM ${OAUTH_STATES} WHERE state_hash = ?1`,
  ).bind(stateHash).first<{ return_to: string; expires_at: string }>();
  if (!stored || stored.expires_at < nowIso()) {
    return json(request, env, { error: "GitHub 登录请求已过期，请重新登录" }, 400);
  }
  await env.DB.prepare(`DELETE FROM ${OAUTH_STATES} WHERE state_hash = ?1`).bind(stateHash).run();
  if (!code) return redirect(`${stored.return_to}#cloudflare_auth_error=cancelled`);

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(request),
    }),
  });
  const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
  const githubToken = typeof tokenPayload.access_token === "string" ? tokenPayload.access_token : "";
  if (!tokenResponse.ok || !githubToken) {
    return redirect(`${stored.return_to}#cloudflare_auth_error=github`);
  }

  const profile = await githubJson<{
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  }>("https://api.github.com/user", githubToken);
  let email = profile.email;
  if (!email) {
    const emails = await githubJson<Array<{ email: string; primary: boolean; verified: boolean }>>(
      "https://api.github.com/user/emails",
      githubToken,
    ).catch(() => []);
    email = emails.find((entry) => entry.primary && entry.verified)?.email ?? null;
  }

  const userId = `github:${profile.id}`;
  const timestamp = nowIso();
  await env.DB.prepare(
    `INSERT INTO ${USERS} (id,github_id,github_login,display_name,email,avatar_url,created_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?7)
     ON CONFLICT(id) DO UPDATE SET github_login=excluded.github_login,display_name=excluded.display_name,
       email=excluded.email,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at`,
  ).bind(userId, String(profile.id), profile.login, profile.name, email, profile.avatar_url, timestamp).run();

  const sessionToken = randomToken(48);
  const sessionHash = await sha256(sessionToken);
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO ${SESSIONS} (token_hash,user_id,expires_at,created_at,last_seen_at) VALUES (?1,?2,?3,?4,?4)`,
  ).bind(sessionHash, userId, expiresAt, timestamp).run();
  await env.DB.prepare(`DELETE FROM ${SESSIONS} WHERE expires_at < ?1`).bind(timestamp).run();

  return redirect(`${stored.return_to}#cloudflare_auth=${encodeURIComponent(sessionToken)}`);
}

async function authenticatedUser(request: Request, env: Env): Promise<CloudUser | null> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id,u.github_login,u.display_name,u.email,u.avatar_url,s.expires_at
     FROM ${SESSIONS} s JOIN ${USERS} u ON u.id=s.user_id
     WHERE s.token_hash=?1`,
  ).bind(tokenHash).first<{
    id: string;
    github_login: string;
    display_name: string | null;
    email: string | null;
    avatar_url: string | null;
    expires_at: string;
  }>();
  if (!row || row.expires_at < nowIso()) {
    if (row) await env.DB.prepare(`DELETE FROM ${SESSIONS} WHERE token_hash=?1`).bind(tokenHash).run();
    return null;
  }
  void env.DB.prepare(`UPDATE ${SESSIONS} SET last_seen_at=?1 WHERE token_hash=?2`)
    .bind(nowIso(), tokenHash).run();
  return {
    id: row.id,
    login: row.github_login,
    name: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
  };
}

async function requireUser(request: Request, env: Env): Promise<CloudUser | Response> {
  const user = await authenticatedUser(request, env);
  return user ?? json(request, env, { error: "GitHub 登录状态已失效，请重新登录" }, 401);
}

async function logout(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (authorization.startsWith("Bearer ")) {
    await env.DB.prepare(`DELETE FROM ${SESSIONS} WHERE token_hash=?1`)
      .bind(await sha256(authorization.slice(7).trim())).run();
  }
  return json(request, env, { ok: true });
}

function decodeCursor(raw: string | null): { changedAt: string; itemKey: string } | null {
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized)) as Record<string, unknown>;
    return validIso(decoded.changedAt) && typeof decoded.itemKey === "string"
      ? { changedAt: decoded.changedAt, itemKey: decoded.itemKey }
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(changedAt: string, itemKey: string): string {
  return btoa(JSON.stringify({ changedAt, itemKey }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function serializeItem(row: StoredItem) {
  let itemData: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.item_data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) itemData = parsed;
  } catch {
    // Corrupt payloads are ignored rather than breaking every future sync.
  }
  const { server_changed_at: _serverChangedAt, ...record } = row;
  return { ...record, item_data: itemData };
}

async function pullItems(request: Request, env: Env, user: CloudUser): Promise<Response> {
  const cursor = decodeCursor(new URL(request.url).searchParams.get("cursor"));
  const statement = cursor
    ? env.DB.prepare(
        `SELECT id,user_id,item_key,item_type,item_data,added_at,updated_at,server_changed_at,deleted_at
         FROM ${ITEMS} WHERE user_id=?1 AND item_key LIKE ?2
           AND (server_changed_at>?3 OR (server_changed_at=?3 AND item_key>?4))
         ORDER BY server_changed_at,item_key LIMIT ?5`,
      ).bind(user.id, `${ITEM_PREFIX}%`, cursor.changedAt, cursor.itemKey, PULL_PAGE_SIZE + 1)
    : env.DB.prepare(
        `SELECT id,user_id,item_key,item_type,item_data,added_at,updated_at,server_changed_at,deleted_at
         FROM ${ITEMS} WHERE user_id=?1 AND item_key LIKE ?2
         ORDER BY server_changed_at,item_key LIMIT ?3`,
      ).bind(user.id, `${ITEM_PREFIX}%`, PULL_PAGE_SIZE + 1);
  const result = await statement.all<StoredItem>();
  const rows = result.results ?? [];
  const page = rows.slice(0, PULL_PAGE_SIZE);
  const last = page.at(-1);
  return json(request, env, {
    records: page.map(serializeItem),
    cursor: last ? encodeCursor(last.server_changed_at, last.item_key) : new URL(request.url).searchParams.get("cursor"),
    hasMore: rows.length > PULL_PAGE_SIZE,
  });
}

function normalizeIncomingItem(value: unknown): IncomingItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.item_key !== "string" ||
    !record.item_key.startsWith(ITEM_PREFIX) ||
    record.item_key.length > 300 ||
    typeof record.item_type !== "string" ||
    record.item_type.length > 80 ||
    !record.item_data ||
    typeof record.item_data !== "object" ||
    Array.isArray(record.item_data) ||
    !validIso(record.added_at) ||
    !validIso(record.updated_at) ||
    !(record.deleted_at === null || validIso(record.deleted_at))
  ) return null;
  const payload = JSON.stringify(record.item_data);
  if (payload.length > 2_000_000) return null;
  return {
    item_key: record.item_key,
    item_type: record.item_type,
    item_data: record.item_data as Record<string, unknown>,
    added_at: record.added_at,
    updated_at: record.updated_at,
    deleted_at: record.deleted_at,
  };
}

async function pushItems(request: Request, env: Env, user: CloudUser): Promise<Response> {
  const payload = await request.json().catch(() => ({})) as { records?: unknown };
  const values = Array.isArray(payload.records) ? payload.records : [];
  if (!values.length || values.length > MAX_SYNC_RECORDS) {
    return json(request, env, { error: "同步批次为空或过大" }, 400);
  }
  const records = values.map(normalizeIncomingItem);
  if (records.some((record) => record === null)) {
    return json(request, env, { error: "同步数据格式不正确" }, 400);
  }
  const statements = (records as IncomingItem[]).map((record) =>
    env.DB.prepare(
      `INSERT INTO ${ITEMS} (id,user_id,item_key,item_type,item_data,added_at,updated_at,server_changed_at,deleted_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
       ON CONFLICT(user_id,item_key) DO UPDATE SET
         item_type=excluded.item_type,item_data=excluded.item_data,updated_at=excluded.updated_at,
         server_changed_at=excluded.server_changed_at,deleted_at=excluded.deleted_at
       WHERE excluded.updated_at>${ITEMS}.updated_at
          OR (excluded.updated_at=${ITEMS}.updated_at AND excluded.deleted_at IS NOT NULL AND ${ITEMS}.deleted_at IS NULL)
          OR (excluded.updated_at=${ITEMS}.updated_at AND COALESCE(excluded.deleted_at,'')=COALESCE(${ITEMS}.deleted_at,'')
              AND excluded.item_data>${ITEMS}.item_data)`,
    ).bind(
      `${user.id}::${record.item_key}`,
      user.id,
      record.item_key,
      record.item_type,
      JSON.stringify(record.item_data),
      record.added_at,
      record.updated_at,
      nowIso(),
      record.deleted_at,
    ),
  );
  await env.DB.batch(statements);
  return json(request, env, { ok: true, accepted: records.length });
}

function isCandidate(value: unknown): value is ModelCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelCandidate>;
  return typeof candidate.id === "string" &&
    (candidate.kind === "line" || candidate.kind === "area") &&
    typeof candidate.page === "number" &&
    typeof candidate.title === "string" &&
    typeof candidate.text === "string" &&
    Array.isArray(candidate.breadcrumb) &&
    candidate.breadcrumb.every((part) => typeof part === "string") &&
    (candidate.queryLabels === undefined ||
      (Array.isArray(candidate.queryLabels) && candidate.queryLabels.every((label) => typeof label === "string")));
}

function completionUsage(completion: Record<string, unknown>) {
  const usage = completion.usage && typeof completion.usage === "object"
    ? completion.usage as Record<string, unknown>
    : {};
  const promptTokens = typeof usage.prompt_tokens === "number" ? Math.max(0, Math.round(usage.prompt_tokens)) : 0;
  const completionTokens = typeof usage.completion_tokens === "number" ? Math.max(0, Math.round(usage.completion_tokens)) : 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: typeof usage.total_tokens === "number"
      ? Math.max(0, Math.round(usage.total_tokens))
      : promptTokens + completionTokens,
    cachedTokens: typeof usage.prompt_cache_hit_tokens === "number"
      ? Math.max(0, Math.round(usage.prompt_cache_hit_tokens))
      : 0,
  };
}

function tokenPrice(model: string, promptTokens: number) {
  return model === "Qwen/Qwen3.5-35B-A3B"
    ? promptTokens < 128_000
      ? { prompt: 0.4, completion: 3.2 }
      : { prompt: 1.6, completion: 12.8 }
    : { prompt: 0, completion: 0 };
}

async function modelCompletion(
  env: Env,
  query: string,
  candidateText: string,
  signal: AbortSignal,
  repair = false,
): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SILICONFLOW_API_KEY}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: env.SILICONFLOW_MODEL || "Qwen/Qwen3.5-35B-A3B",
      stream: false,
      max_tokens: 1800,
      enable_thinking: false,
      temperature: repair ? 0 : 0.1,
      top_p: repair ? 0.5 : 0.65,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: repair
          ? `${KNOWLEDGE_SYSTEM_PROMPT}\n上一次输出格式不完整。请重新判断并只输出语法完全正确、可以直接 JSON.parse 的单个 JSON 对象。`
          : KNOWLEDGE_SYSTEM_PROMPT },
        { role: "user", content: `用户查询：\n${query}\n\n图谱候选词条：\n${candidateText}` },
      ],
    }),
  });
  if (!response.ok) throw new Error(response.status === 429 ? "当前检索人数较多，请稍后重试" : "硅基流动暂时不可用");
  const completion = (await response.json()) as Record<string, unknown>;
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  if (typeof first?.message?.content !== "string") throw new Error("模型未返回结果");
  return completion;
}

function modelContent(completion: Record<string, unknown>): string {
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content : "";
}

async function recordAiUsage(env: Env, userId: string, model: string, usage: ReturnType<typeof completionUsage>) {
  const price = tokenPrice(model, usage.promptTokens);
  const cost = (usage.promptTokens * price.prompt + usage.completionTokens * price.completion) / 1_000_000;
  await env.DB.prepare(
    `INSERT INTO ${AI_USAGE} (user_id,prompt_tokens,completion_tokens,total_tokens,cached_tokens,request_count,estimated_cost_cny,last_model,updated_at)
     VALUES (?1,?2,?3,?4,?5,1,?6,?7,?8)
     ON CONFLICT(user_id) DO UPDATE SET
       prompt_tokens=prompt_tokens+excluded.prompt_tokens,
       completion_tokens=completion_tokens+excluded.completion_tokens,
       total_tokens=total_tokens+excluded.total_tokens,
       cached_tokens=cached_tokens+excluded.cached_tokens,
       request_count=request_count+1,
       estimated_cost_cny=estimated_cost_cny+excluded.estimated_cost_cny,
       last_model=excluded.last_model,updated_at=excluded.updated_at`,
  ).bind(userId, usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.cachedTokens, cost, model, nowIso()).run();
}

async function knowledgeSearch(request: Request, env: Env, user: CloudUser): Promise<Response> {
  if (!env.SILICONFLOW_API_KEY) return json(request, env, { error: "AI 检索尚未配置" }, 503);
  const body = await request.json().catch(() => ({})) as { query?: unknown; candidates?: unknown };
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const candidates = Array.isArray(body.candidates) ? body.candidates.filter(isCandidate).slice(0, 48) : [];
  if (query.length < 2 || query.length > 1800 || !candidates.length) {
    return json(request, env, { error: "检索内容格式不正确" }, 400);
  }
  const candidateText = formatKnowledgeCandidates(candidates);
  const completions: Record<string, unknown>[] = [];
  let parsed: ParsedKnowledgeModelOutput | null = null;
  let content = "";
  try {
    const first = await modelCompletion(env, query, candidateText, request.signal);
    completions.push(first);
    content = modelContent(first);
    try {
      parsed = parseKnowledgeModelOutput(content);
    } catch {
      const repaired = await modelCompletion(env, query, candidateText, request.signal, true);
      completions.push(repaired);
      content = modelContent(repaired);
      try {
        parsed = parseKnowledgeModelOutput(content);
      } catch {
        parsed = recoverKnowledgeModelOutput(content, candidates.map((candidate) => candidate.id));
      }
    }
  } catch (error) {
    return json(request, env, { error: error instanceof Error ? error.message : "AI 服务连接不稳定" }, 502);
  }
  if (!parsed) return json(request, env, { error: "模型未能稳定生成结果，请重新检索" }, 502);
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const matches = Array.isArray(parsed.matches)
    ? parsed.matches.filter((match) => {
        if (!match || typeof match !== "object") return false;
        const id = (match as Record<string, unknown>).id;
        return typeof id === "string" && allowed.has(id);
      }).slice(0, 10)
    : [];
  if (!matches.length) return json(request, env, { error: "模型未选出有效图谱词条" }, 502);
  const usage = completions.map(completionUsage).reduce(
    (total, current) => ({
      promptTokens: total.promptTokens + current.promptTokens,
      completionTokens: total.completionTokens + current.completionTokens,
      totalTokens: total.totalTokens + current.totalTokens,
      cachedTokens: total.cachedTokens + current.cachedTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
  );
  const model = env.SILICONFLOW_MODEL || "Qwen/Qwen3.5-35B-A3B";
  await recordAiUsage(env, user.id, model, usage).catch(() => undefined);
  return json(request, env, {
    answer: typeof parsed.answer === "string" ? parsed.answer : "已找到对应知识点。",
    matches,
    model,
    usage,
  });
}

async function usageSummary(request: Request, env: Env, user: CloudUser): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT prompt_tokens,completion_tokens,total_tokens,cached_tokens,request_count,estimated_cost_cny,last_model
     FROM ${AI_USAGE} WHERE user_id=?1`,
  ).bind(user.id).first<Record<string, unknown>>();
  return json(request, env, { usage: row ?? null });
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  const url = new URL(request.url);
  if (url.pathname === "/health") return json(request, env, { ok: true, service: NAMESPACE });
  if (url.pathname === "/auth/login" && request.method === "GET") return startGithubLogin(request, env);
  if (url.pathname === "/auth/callback" && request.method === "GET") return finishGithubLogin(request, env);
  if (url.pathname === "/auth/logout" && request.method === "POST") return logout(request, env);

  const authenticated = await requireUser(request, env);
  if (authenticated instanceof Response) return authenticated;
  if (url.pathname === "/auth/me" && request.method === "GET") return json(request, env, { user: authenticated });
  if (url.pathname === "/sync/pull" && request.method === "GET") return pullItems(request, env, authenticated);
  if (url.pathname === "/sync/push" && request.method === "POST") return pushItems(request, env, authenticated);
  if (url.pathname === "/usage" && request.method === "GET") return usageSummary(request, env, authenticated);
  if (url.pathname === "/knowledge-search" && request.method === "POST") return knowledgeSearch(request, env, authenticated);
  return json(request, env, { error: "Not found" }, 404);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env).catch((error) => {
      console.error(error);
      return json(request, env, { error: "云端服务暂时不可用" }, 500);
    });
  },
};
