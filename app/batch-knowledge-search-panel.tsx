"use client";

import {
  type CSSProperties,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  parseReviewClipboard,
  type ReviewClipItem,
} from "./lib/batch-knowledge-search";
import { searchKnowledge } from "./lib/knowledge-api";
import type { KnowledgeAnswer, KnowledgeEntry } from "./lib/knowledge-search";
import {
  friendlyKnowledgeError,
  isTransientKnowledgeError,
  waitForKnowledgeRetry,
} from "./lib/knowledge-request";

type Props = {
  open: boolean;
  onClose: () => void;
  onLocate: (entry: KnowledgeEntry) => void;
};

type BatchStatus = "queued" | "searching" | "retrying" | "done" | "error";

type BatchItem = ReviewClipItem & {
  query: string;
  status: BatchStatus;
  answer?: KnowledgeAnswer;
  error?: string;
  retryCount?: number;
};

type FloatingPosition = {
  left: number;
  top: number;
};

type CopyFeedback = {
  itemId: string;
  state: "copied" | "failed";
};

const BATCH_CONCURRENCY = 2;
const BATCH_REQUEST_GAP_MS = 1_200;
const BATCH_RETRY_DELAYS_MS = [
  2_500,
  5_000,
  10_000,
  16_000,
  24_000,
  30_000,
  45_000,
  60_000,
];

export function BatchKnowledgeSearchPanel({
  open,
  onClose,
  onLocate,
}: Props) {
  const [sourceText, setSourceText] = useState("");
  const [items, setItems] = useState<BatchItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [importError, setImportError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [floatingPosition, setFloatingPosition] =
    useState<FloatingPosition | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);
  const batchRunId = useRef(0);
  const batchController = useRef<AbortController | null>(null);
  const itemControllers = useRef(new Map<string, AbortController>());
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null>(null);

  const parsedPreview = useMemo(
    () => parseReviewClipboard(sourceText),
    [sourceText],
  );
  const currentItem = items[currentIndex] ?? null;
  const completedCount = items.filter(
    (item) => item.status === "done" || item.status === "error",
  ).length;
  const successCount = items.filter((item) => item.status === "done").length;
  const errorCount = items.filter((item) => item.status === "error").length;
  const progressPercent = items.length
    ? Math.round((completedCount / items.length) * 100)
    : 0;

  const updateItem = useCallback(
    (index: number, patch: Partial<BatchItem>) => {
      setItems((current) =>
        current.map((item, itemIndex) =>
          itemIndex === index ? { ...item, ...patch } : item,
        ),
      );
    },
    [],
  );

  const cancelAll = useCallback(() => {
    batchRunId.current += 1;
    batchController.current?.abort();
    batchController.current = null;
    itemControllers.current.forEach((controller) => controller.abort());
    itemControllers.current.clear();
    setRunning(false);
    setItems((current) =>
      current.map((item) =>
        item.status === "searching" || item.status === "retrying"
          ? { ...item, status: "queued", error: undefined }
          : item,
      ),
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  useEffect(
    () => () => {
      batchController.current?.abort();
      itemControllers.current.forEach((controller) => controller.abort());
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
    },
    [],
  );

  const copyCurrentItem = async (item: BatchItem) => {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(item.query);
        copied = true;
      }
    } catch {
      // Use the selection fallback below when clipboard permission is unavailable.
    }

    if (!copied) {
      const textarea = document.createElement("textarea");
      textarea.value = item.query;
      textarea.readOnly = true;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        textarea.remove();
      }
    }

    setCopyFeedback({
      itemId: item.id,
      state: copied ? "copied" : "failed",
    });
    if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
    copyFeedbackTimer.current = setTimeout(
      () => setCopyFeedback(null),
      copied ? 1_500 : 2_200,
    );
  };

  const handleHeaderPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select")) return;
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
  };

  const handleHeaderPointerMove = (
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    setFloatingPosition({
      left: Math.min(
        Math.max(8, drag.left + event.clientX - drag.startX),
        Math.max(8, window.innerWidth - rect.width - 8),
      ),
      top: Math.min(
        Math.max(8, drag.top + event.clientY - drag.startY),
        Math.max(8, window.innerHeight - rect.height - 8),
      ),
    });
  };

  const stopHeaderDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const startBatch = async () => {
    const parsed = parseReviewClipboard(sourceText);
    if (!parsed.length) {
      setImportError("没有识别到可检索的条目，请粘贴完整复习剪贴文本");
      return;
    }
    cancelAll();
    const runId = batchRunId.current + 1;
    batchRunId.current = runId;
    const controller = new AbortController();
    batchController.current = controller;
    const prepared = parsed.map((item) => ({
      ...item,
      query: item.content,
      status: "queued" as const,
    }));
    setImportError("");
    setItems(prepared);
    setCurrentIndex(0);
    setEditing(false);
    setRunning(true);

    let nextIndex = 0;
    let nextRequestAt = 0;
    let requestGate: Promise<void> = Promise.resolve();
    const waitForRequestSlot = () => {
      const slot = requestGate.then(async () => {
        const delay = Math.max(0, nextRequestAt - Date.now());
        if (delay > 0) {
          await waitForKnowledgeRetry(delay, controller.signal);
        }
        nextRequestAt = Date.now() + BATCH_REQUEST_GAP_MS;
      });
      requestGate = slot.catch(() => undefined);
      return slot;
    };

    const searchItemWithRetry = async (itemIndex: number) => {
      const item = prepared[itemIndex];
      let retryCount = 0;
      while (!controller.signal.aborted) {
        if (retryCount > 0) {
          const retryDelay = BATCH_RETRY_DELAYS_MS[retryCount - 1];
          updateItem(itemIndex, {
            status: "retrying",
            retryCount,
            error: `AI 服务繁忙，正在自动等待后继续（第 ${retryCount} 次重试）`,
          });
          await waitForKnowledgeRetry(retryDelay, controller.signal);
        }

        await waitForRequestSlot();
        updateItem(itemIndex, {
          status: "searching",
          retryCount,
          answer: undefined,
          error: undefined,
        });
        try {
          return await searchKnowledge(item.query, controller.signal);
        } catch (reason) {
          if (
            controller.signal.aborted ||
            (reason instanceof DOMException && reason.name === "AbortError")
          ) {
            throw reason;
          }
          if (
            isTransientKnowledgeError(reason) &&
            retryCount < BATCH_RETRY_DELAYS_MS.length
          ) {
            retryCount += 1;
            continue;
          }
          throw reason;
        }
      }
      throw new DOMException("Aborted", "AbortError");
    };

    const worker = async () => {
      while (nextIndex < prepared.length && !controller.signal.aborted) {
        const itemIndex = nextIndex;
        nextIndex += 1;
        try {
          const answer = await searchItemWithRetry(itemIndex);
          if (
            controller.signal.aborted ||
            batchRunId.current !== runId
          ) return;
          updateItem(itemIndex, {
            status: "done",
            answer,
            error: undefined,
          });
        } catch (reason) {
          if (
            controller.signal.aborted ||
            batchRunId.current !== runId ||
            (reason instanceof DOMException && reason.name === "AbortError")
          ) return;
          updateItem(itemIndex, {
            status: "error",
            answer: undefined,
            retryCount: undefined,
            error: friendlyKnowledgeError(reason),
          });
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(BATCH_CONCURRENCY, prepared.length) },
        () => worker(),
      ),
    );
    if (batchRunId.current === runId) {
      batchController.current = null;
      setRunning(false);
    }
  };

  const rerunItem = async (index: number, nextQuery?: string) => {
    const item = items[index];
    if (!item || running) return;
    const query = (nextQuery ?? item.query).trim();
    if (query.length < 2) {
      updateItem(index, { status: "error", error: "本条内容不能为空" });
      return;
    }
    itemControllers.current.get(item.id)?.abort();
    const controller = new AbortController();
    itemControllers.current.set(item.id, controller);
    updateItem(index, {
      query,
      content: query,
      status: "searching",
      answer: undefined,
      error: undefined,
    });
    setEditing(false);
    try {
      const answer = await searchKnowledge(query, controller.signal);
      if (itemControllers.current.get(item.id) !== controller) return;
      updateItem(index, { status: "done", answer, error: undefined });
    } catch (reason) {
      if (
        controller.signal.aborted ||
        (reason instanceof DOMException && reason.name === "AbortError")
      ) return;
      updateItem(index, {
        status: "error",
        answer: undefined,
        error: friendlyKnowledgeError(reason),
      });
    } finally {
      if (itemControllers.current.get(item.id) === controller) {
        itemControllers.current.delete(item.id);
      }
    }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setSourceText(await file.text());
      setImportError("");
    } catch {
      setImportError("文件读取失败，请改为直接粘贴文本");
    }
  };

  const returnToImport = () => {
    cancelAll();
    setItems([]);
    setCurrentIndex(0);
    setEditing(false);
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="knowledge-backdrop batch-knowledge-backdrop"
      role="presentation"
    >
      <section
        ref={sheetRef}
        className="knowledge-sheet batch-knowledge-sheet"
        role="dialog"
        aria-labelledby="batch-knowledge-title"
        style={
          floatingPosition
            ? {
                left: `${floatingPosition.left}px`,
                top: `${floatingPosition.top}px`,
                right: "auto",
              } as CSSProperties
            : undefined
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header
          className="knowledge-sheet-header batch-knowledge-header"
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={handleHeaderPointerMove}
          onPointerUp={stopHeaderDrag}
          onPointerCancel={stopHeaderDrag}
        >
          <div>
            <span>复习剪贴 · 批量定位</span>
            <h2 id="batch-knowledge-title">增强检索</h2>
            <p>拖动标题栏移动 · 右下角缩放 · 按 B 打开或关闭</p>
          </div>
          <button
            type="button"
            className="sheet-close"
            aria-label="关闭增强检索"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {!items.length ? (
          <div className="batch-import-view">
            <div className="batch-import-actions">
              <label className="batch-file-button">
                导入 TXT / Markdown
                <input
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  onChange={importFile}
                />
              </label>
              <span>
                {sourceText
                  ? `已识别 ${parsedPreview.length} 条`
                  : "也可以直接粘贴完整复习剪贴"}
              </span>
            </div>
            <textarea
              autoFocus
              value={sourceText}
              onChange={(event) => {
                setSourceText(event.target.value);
                setImportError("");
              }}
              placeholder={`粘贴“# 复习剪贴”文本……\n\n---\n\n## 1\n\n第一条复习内容\n\n---`}
              aria-label="批量检索复习剪贴内容"
            />
            {importError && <p className="knowledge-error">{importError}</p>}
            <footer className="batch-import-footer">
              <p>图片链接、编号标题和“收集于”信息不会发送给 AI。</p>
              <button
                type="button"
                disabled={!parsedPreview.length}
                onClick={() => void startBatch()}
              >
                开始检索 {parsedPreview.length || ""} 条
              </button>
            </footer>
          </div>
        ) : (
          <div className="batch-results-view">
            <div className="batch-progress-summary" aria-live="polite">
              <div>
                <strong>
                  {running
                    ? `正在批量检索 ${completedCount}/${items.length}`
                    : `批量检索结束 · 成功 ${successCount}/${items.length}`}
                </strong>
                <span>
                  {running
                    ? "自动限速处理；服务繁忙时会等待后继续，无需手动点击"
                    : errorCount
                      ? `${errorCount} 条需要检查，可编辑后重新检索`
                      : "全部完成，可逐条查看或编辑"}
                </span>
              </div>
              <div className="batch-progress-actions">
                {running && (
                  <button type="button" className="is-cancel" onClick={cancelAll}>
                    取消全部
                  </button>
                )}
                <button type="button" disabled={running} onClick={returnToImport}>
                  重新导入
                </button>
              </div>
              <div
                className="batch-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
              >
                <span style={{ width: `${progressPercent}%` }} />
              </div>
            </div>

            {currentItem && (
              <>
                <section className="batch-current-source">
                  <header>
                    <div>
                      <span>第 {currentIndex + 1} / {items.length} 条</span>
                      <strong>复习剪贴 #{currentItem.label}</strong>
                    </div>
                    {!editing && (
                      <div className="batch-current-source-actions">
                        <button
                          type="button"
                          className={
                            copyFeedback?.itemId === currentItem.id
                              ? `is-${copyFeedback.state}`
                              : undefined
                          }
                          aria-live="polite"
                          onClick={() => void copyCurrentItem(currentItem)}
                        >
                          {copyFeedback?.itemId === currentItem.id
                            ? copyFeedback.state === "copied"
                              ? "已复制"
                              : "复制失败"
                            : "复制本条"}
                        </button>
                        <button
                          type="button"
                          disabled={running || currentItem.status === "searching"}
                          onClick={() => {
                            setEditDraft(currentItem.query);
                            setEditing(true);
                          }}
                        >
                          编辑本条
                        </button>
                      </div>
                    )}
                  </header>
                  {editing ? (
                    <div className="batch-edit-source">
                      <textarea
                        autoFocus
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                      />
                      <div>
                        <button type="button" onClick={() => setEditing(false)}>
                          取消
                        </button>
                        <button
                          type="button"
                          disabled={editDraft.trim().length < 2}
                          onClick={() =>
                            void rerunItem(currentIndex, editDraft)
                          }
                        >
                          保存并重新检索本条
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p>{currentItem.query}</p>
                  )}
                </section>

                <section className="batch-current-answer">
                  {currentItem.status === "queued" && (
                    <div className="batch-status-card">
                      <strong>等待检索</strong>
                      <span>轮到本条后会自动开始。</span>
                    </div>
                  )}
                  {currentItem.status === "searching" && (
                    <div className="batch-status-card is-searching">
                      <strong>正在定位对应知识点…</strong>
                      <span>正在检索全书文字并让模型判断。</span>
                    </div>
                  )}
                  {currentItem.status === "retrying" && (
                    <div className="batch-status-card is-retrying">
                      <strong>{currentItem.error}</strong>
                      <span>任务仍在运行，请保持页面打开，无需手动重试。</span>
                    </div>
                  )}
                  {currentItem.status === "error" && (
                    <div className="batch-status-card is-error">
                      <strong>{currentItem.error || "本条检索失败"}</strong>
                      <button
                        type="button"
                        disabled={running}
                        onClick={() => void rerunItem(currentIndex)}
                      >
                        重新检索本条
                      </button>
                    </div>
                  )}
                  {currentItem.status === "done" && currentItem.answer && (
                    <>
                      <div className="knowledge-results">
                        <div className="knowledge-results-header">
                          <strong>对应考点</strong>
                          <span>{currentItem.answer.matches.length} 项</span>
                        </div>
                        {currentItem.answer.matches.map((match, matchIndex) => (
                          <button
                            type="button"
                            className="knowledge-result"
                            key={`${match.id}-${matchIndex}`}
                            onClick={() => onLocate(match)}
                          >
                            <span className="knowledge-result-rank">
                              {matchIndex + 1}
                            </span>
                            <span className="knowledge-result-copy">
                              <strong>{match.title}</strong>
                              <small>
                                {match.breadcrumb.join(" › ") || "图谱正文"}
                                {" · "}
                                图谱第 {match.page} 页
                              </small>
                              {match.reason && <em>{match.reason}</em>}
                            </span>
                            <span
                              className="knowledge-result-arrow"
                              aria-hidden="true"
                            >
                              ›
                            </span>
                          </button>
                        ))}
                      </div>
                      <div className="batch-model-summary">
                        <strong>模型判断</strong>
                        <p>{currentItem.answer.answer}</p>
                        {currentItem.answer.usage && (
                          <small>
                            本条消耗{" "}
                            {currentItem.answer.usage.totalTokens.toLocaleString(
                              "zh-CN",
                            )}{" "}
                            Tokens
                          </small>
                        )}
                      </div>
                    </>
                  )}
                </section>

                <nav className="batch-result-navigation" aria-label="切换批量检索结果">
                  <button
                    type="button"
                    disabled={currentIndex === 0}
                    onClick={() => {
                      setEditing(false);
                      setCurrentIndex((index) => Math.max(0, index - 1));
                    }}
                  >
                    ‹ 上一条
                  </button>
                  <div>
                    {items.map((item, itemIndex) => (
                      <button
                        type="button"
                        className={[
                          itemIndex === currentIndex ? "is-current" : "",
                          `is-${item.status}`,
                        ].join(" ")}
                        aria-label={`第 ${itemIndex + 1} 条，${item.status}`}
                        key={item.id}
                        onClick={() => {
                          setEditing(false);
                          setCurrentIndex(itemIndex);
                        }}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={currentIndex === items.length - 1}
                    onClick={() => {
                      setEditing(false);
                      setCurrentIndex((index) =>
                        Math.min(items.length - 1, index + 1),
                      );
                    }}
                  >
                    下一条 ›
                  </button>
                </nav>
              </>
            )}
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
