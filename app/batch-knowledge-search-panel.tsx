"use client";

import {
  type ChangeEvent,
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
import { friendlyKnowledgeError } from "./lib/knowledge-request";

type Props = {
  open: boolean;
  onClose: () => void;
  onLocate: (entry: KnowledgeEntry) => void;
};

type BatchStatus = "queued" | "searching" | "done" | "error";

type BatchItem = ReviewClipItem & {
  query: string;
  status: BatchStatus;
  answer?: KnowledgeAnswer;
  error?: string;
};

const BATCH_CONCURRENCY = 3;

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
  const batchRunId = useRef(0);
  const batchController = useRef<AbortController | null>(null);
  const itemControllers = useRef(new Map<string, AbortController>());

  const parsedPreview = useMemo(
    () => parseReviewClipboard(sourceText),
    [sourceText],
  );
  const currentItem = items[currentIndex] ?? null;
  const completedCount = items.filter(
    (item) => item.status === "done" || item.status === "error",
  ).length;
  const successCount = items.filter((item) => item.status === "done").length;
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
        item.status === "searching"
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
    },
    [],
  );

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
    const worker = async () => {
      while (nextIndex < prepared.length && !controller.signal.aborted) {
        const itemIndex = nextIndex;
        nextIndex += 1;
        updateItem(itemIndex, {
          status: "searching",
          answer: undefined,
          error: undefined,
        });
        try {
          const answer = await searchKnowledge(
            prepared[itemIndex].query,
            controller.signal,
          );
          if (
            controller.signal.aborted ||
            batchRunId.current !== runId
          ) return;
          updateItem(itemIndex, { status: "done", answer, error: undefined });
        } catch (reason) {
          if (
            controller.signal.aborted ||
            batchRunId.current !== runId ||
            (reason instanceof DOMException && reason.name === "AbortError")
          ) return;
          updateItem(itemIndex, {
            status: "error",
            answer: undefined,
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
      onMouseDown={onClose}
    >
      <section
        className="knowledge-sheet batch-knowledge-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-knowledge-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="knowledge-sheet-header batch-knowledge-header">
          <div>
            <span>复习剪贴 · 批量定位</span>
            <h2 id="batch-knowledge-title">增强检索</h2>
            <p>自动忽略图片与收集时间，按分割线逐条检索图谱。</p>
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
                    : `已完成 ${successCount}/${items.length}`}
                </strong>
                <span>{running ? "同时处理 3 条，可随时取消" : "可逐条查看、编辑或重新检索"}</span>
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
                            onClick={() => {
                              onLocate(match);
                              onClose();
                            }}
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
