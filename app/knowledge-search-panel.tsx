"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { loadKnowledgeIndex, searchKnowledge } from "./lib/knowledge-api";
import type { KnowledgeAnswer, KnowledgeEntry } from "./lib/knowledge-search";
import { friendlyKnowledgeError } from "./lib/knowledge-request";

type Props = {
  open: boolean;
  onClose: () => void;
  onLocate: (entry: KnowledgeEntry) => void;
};

export function KnowledgeSearchPanel({ open, onClose, onLocate }: Props) {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState("");
  const [entryCount, setEntryCount] = useState<number | null>(null);
  const requestId = useRef(0);
  const searchStartedAt = useRef<number | null>(null);
  const abortController = useRef<AbortController | null>(null);

  const cancelSearch = useCallback(() => {
    requestId.current += 1;
    abortController.current?.abort();
    abortController.current = null;
    searchStartedAt.current = null;
    setElapsedMs(0);
    setBusy(false);
    setError("");
  }, []);

  const closePanel = useCallback(() => {
    cancelSearch();
    onClose();
  }, [cancelSearch, onClose]);

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
      if (event.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closePanel, open]);

  useEffect(
    () => () => {
      abortController.current?.abort();
    },
    [],
  );

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
    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;
    searchStartedAt.current = Date.now();
    setElapsedMs(0);
    setBusy(true);
    setError("");
    setAnswer(null);

    try {
      const modelAnswer = await searchKnowledge(
        requestedQuery,
        controller.signal,
      );
      if (requestId.current !== currentRequest) return;
      setAnswer(modelAnswer);
    } catch (reason) {
      if (requestId.current !== currentRequest) return;
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(friendlyKnowledgeError(reason));
    } finally {
      if (requestId.current === currentRequest) {
        abortController.current = null;
        searchStartedAt.current = null;
        setBusy(false);
      }
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="knowledge-backdrop" role="presentation" onMouseDown={closePanel}>
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
          <button type="button" className="sheet-close" aria-label="关闭" onClick={closePanel}>×</button>
        </header>

        <form className="knowledge-search-form" onSubmit={search}>
          <textarea
            autoFocus
            rows={3}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="粘贴题目、选项，或输入一个知识点…"
            onKeyDown={(event) => {
              if (
                event.key !== "Enter"
                || event.shiftKey
                || event.nativeEvent.isComposing
              ) return;
              event.preventDefault();
              if (canSearch) event.currentTarget.form?.requestSubmit();
            }}
          />
          <button
            type={busy ? "button" : "submit"}
            className={busy ? "is-cancel" : ""}
            disabled={busy ? false : !canSearch}
            onClick={busy ? cancelSearch : undefined}
          >
            {busy ? "取消检索" : "查找对应知识点"}
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
