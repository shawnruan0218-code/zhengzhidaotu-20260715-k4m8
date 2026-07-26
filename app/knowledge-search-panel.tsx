"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type KnowledgeAnswer,
  type KnowledgeEntry,
  type KnowledgeIndex,
  type KnowledgeMatch,
  rankKnowledgeCandidates,
} from "./lib/knowledge-search";
import { withBasePath } from "./lib/app-config";
import { getSupabaseClient } from "./lib/supabase-client";

type Props = {
  open: boolean;
  onClose: () => void;
  onLocate: (entry: KnowledgeEntry) => void;
};

type FunctionResponse = {
  answer?: unknown;
  matches?: unknown;
  model?: unknown;
  usage?: unknown;
};

let indexPromise: Promise<KnowledgeIndex> | null = null;

function loadKnowledgeIndex() {
  if (!indexPromise) {
    indexPromise = fetch(withBasePath("/data/knowledge-index.json")).then(async (response) => {
      if (!response.ok) throw new Error("图谱文字索引加载失败");
      return (await response.json()) as KnowledgeIndex;
    });
  }
  return indexPromise;
}

function normalizeFunctionAnswer(
  payload: FunctionResponse,
  candidates: KnowledgeMatch[],
): KnowledgeAnswer | null {
  if (typeof payload.answer !== "string" || !Array.isArray(payload.matches)) return null;
  const candidatesById = new Map(candidates.map((entry) => [entry.id, entry]));
  const matches = payload.matches
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const candidate = typeof record.id === "string" ? candidatesById.get(record.id) : null;
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
      typeof (payload.usage as Record<string, unknown>).promptTokens === "number" &&
      typeof (payload.usage as Record<string, unknown>).completionTokens === "number" &&
      typeof (payload.usage as Record<string, unknown>).totalTokens === "number"
        ? {
            promptTokens: (payload.usage as Record<string, number>).promptTokens,
            completionTokens: (payload.usage as Record<string, number>).completionTokens,
            totalTokens: (payload.usage as Record<string, number>).totalTokens,
            cachedTokens:
              typeof (payload.usage as Record<string, unknown>).cachedTokens === "number"
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

export function KnowledgeSearchPanel({ open, onClose, onLocate }: Props) {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState("");
  const [entryCount, setEntryCount] = useState<number | null>(null);
  const requestId = useRef(0);
  const searchStartedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    void loadKnowledgeIndex()
      .then((index) => setEntryCount(index.entryCount))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "图谱文字索引加载失败"),
      );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  useEffect(() => {
    if (!busy || searchStartedAt.current === null) {
      setElapsedMs(0);
      return;
    }
    const updateElapsed = () => {
      if (searchStartedAt.current !== null) {
        setElapsedMs(Date.now() - searchStartedAt.current);
      }
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [busy]);

  const canSearch = useMemo(() => query.trim().length >= 2 && !busy, [busy, query]);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const expectedWaitSeconds = 10;
  const estimatedRemainingSeconds = Math.max(
    1,
    Math.ceil(expectedWaitSeconds - elapsedMs / 1000),
  );
  const progressPercent = Math.round(
    elapsedMs <= expectedWaitSeconds * 1000
      ? 8 + (elapsedMs / (expectedWaitSeconds * 1000)) * 77
      : Math.min(94, 85 + ((elapsedMs - expectedWaitSeconds * 1000) / 20000) * 9),
  );

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const requestedQuery = query.trim();
    if (requestedQuery.length < 2) return;
    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    searchStartedAt.current = Date.now();
    setElapsedMs(0);
    setBusy(true);
    setError("");
    setAnswer(null);

    try {
      const index = await loadKnowledgeIndex();
      if (requestId.current !== currentRequest) return;
      const candidates = rankKnowledgeCandidates(requestedQuery, index.entries, 48);
      if (!candidates.length) {
        throw new Error("没有找到足够接近的图谱内容，请粘贴更完整的题干");
      }

      const client = getSupabaseClient();
      const session = client ? (await client.auth.getSession()).data.session : null;
      if (!client || !session) {
        throw new Error("请先登录账号后使用 AI 检索");
      }

      const { data, error: invokeError } = await client.functions.invoke("knowledge-search", {
        body: {
          query: requestedQuery,
          candidates: candidates.map(candidatePayload),
        },
      });
      if (invokeError) throw invokeError;
      if (requestId.current !== currentRequest) return;
      const modelAnswer = normalizeFunctionAnswer((data ?? {}) as FunctionResponse, candidates);
      if (!modelAnswer) throw new Error("模型返回内容无法匹配图谱词条");
      setAnswer(modelAnswer);
    } catch (reason) {
      if (requestId.current !== currentRequest) return;
      setError(reason instanceof Error ? reason.message : "检索失败，请稍后重试");
    } finally {
      if (requestId.current === currentRequest) setBusy(false);
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="knowledge-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="knowledge-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="knowledge-search-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="knowledge-sheet-header">
          <div>
            <span>图谱文字检索</span>
            <h2 id="knowledge-search-title">AI 找知识点</h2>
            <p>{entryCount ? `已索引 ${entryCount.toLocaleString("zh-CN")} 个文字条目` : "正在读取全书文字…"}</p>
          </div>
          <button type="button" className="sheet-close" aria-label="关闭" onClick={onClose}>×</button>
        </header>

        <form className="knowledge-search-form" onSubmit={search}>
          <textarea
            autoFocus
            rows={3}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="粘贴题目、选项，或输入一个知识点…"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSearch) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button type="submit" disabled={!canSearch}>
            {busy ? "正在检索…" : "查找对应知识点"}
          </button>
        </form>

        {busy && (
          <div className="knowledge-progress" aria-live="polite">
            <div className="knowledge-progress-copy">
              <strong>
                {elapsedMs < 1000 ? "正在检索全书文字…" : "正在让模型判断对应知识点…"}
              </strong>
              <span>
                {elapsedMs < expectedWaitSeconds * 1000
                  ? `预计还需约 ${estimatedRemainingSeconds} 秒`
                  : `已等待 ${elapsedSeconds} 秒，模型仍在处理`}
              </span>
            </div>
            <div
              className="knowledge-progress-track"
              role="progressbar"
              aria-label="AI 检索预计进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
            >
              <span style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        )}

        {answer && (
          <div className="knowledge-answer" aria-live="polite">
            <div className="knowledge-results">
              <div className="knowledge-results-header">
                <strong>对应考点</strong>
                <span>{answer.matches.length} 项</span>
              </div>
              {answer.matches.map((match, index) => (
                <button
                  type="button"
                  className="knowledge-result"
                  key={`${match.id}-${index}`}
                  onClick={() => {
                    onLocate(match);
                    onClose();
                  }}
                >
                  <span className="knowledge-result-rank">{index + 1}</span>
                  <span className="knowledge-result-copy">
                    <strong>
                      {match.queryLabels?.length
                        ? `${match.queryLabels.join("、")} · `
                        : ""}
                      {match.title}
                    </strong>
                    <small>
                      {match.breadcrumb.join(" › ") || "图谱正文"}
                      {" · "}
                      图谱第 {match.page} 页
                    </small>
                    {match.reason && <em>{match.reason}</em>}
                  </span>
                  <span className="knowledge-result-arrow" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
            <div className="knowledge-answer-copy">
              <span>模型判断</span>
              <p>{answer.answer}</p>
              {answer.model && <small>{answer.model}</small>}
              {answer.usage && (
                <small className="knowledge-token-usage">
                  本次消耗：输入 {answer.usage.promptTokens.toLocaleString("zh-CN")} ·
                  输出 {answer.usage.completionTokens.toLocaleString("zh-CN")} ·
                  合计 {answer.usage.totalTokens.toLocaleString("zh-CN")} Tokens
                  {answer.usage.cachedTokens > 0 &&
                    ` · 缓存命中 ${answer.usage.cachedTokens.toLocaleString("zh-CN")}`}
                </small>
              )}
            </div>
            {answer.warning && <p className="knowledge-warning">{answer.warning}</p>}
          </div>
        )}

        {error && <p className="knowledge-error">{error}</p>}
        {!answer && !busy && (
          <p className="knowledge-empty">输入题干后，系统会先检索全书文字，再让模型只从候选词条中判断。</p>
        )}
      </section>
    </div>,
    document.body,
  );
}
