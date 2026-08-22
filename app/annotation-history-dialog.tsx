"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnnotationCalendar } from "./annotation-calendar";
import type { OutlineNode } from "./lib/outline-navigation";
import type { AnnotationRecord } from "./lib/study-types";
import {
  HighlightedNoteText,
  readSelectedNoteText,
  type SelectedNoteText,
} from "./note-highlight-text";

type HistoryView = "calendar" | "chapter" | "quick";

type Props = {
  open: boolean;
  records: AnnotationRecord[];
  outline: OutlineNode[];
  noteFontScale: number;
  onNoteFontScaleChange: (scale: number) => void;
  onClose: () => void;
  onJump: (record: AnnotationRecord, options?: { showNote?: boolean }) => void;
  onHighlightNote: (selection: SelectedNoteText) => void;
};

function localDayKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function RecordNote({ record }: { record: AnnotationRecord }) {
  return (
    <HighlightedNoteText
      text={record.note}
      ranges={record.noteHighlights}
      entryId={record.entryId}
      versionId={record.versionId}
    />
  );
}

export function AnnotationHistoryDialog({
  open,
  records,
  outline,
  noteFontScale,
  onNoteFontScaleChange,
  onClose,
  onJump,
  onHighlightNote,
}: Props) {
  const [showReturnToTop, setShowReturnToTop] = useState(false);
  const [lastVisitedRecordId, setLastVisitedRecordId] = useState<string | null>(null);
  const [miniMode, setMiniMode] = useState(false);
  const [miniCalendarOpen, setMiniCalendarOpen] = useState(false);
  const [miniPosition, setMiniPosition] = useState<{ left: number; top: number } | null>(null);
  const [view, setView] = useState<HistoryView>("calendar");
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [quickIndex, setQuickIndex] = useState(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const quickIndexRef = useRef(0);
  const miniDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null>(null);

  const datedDayCount = useMemo(
    () => new Set(records.flatMap((record) => record.createdAt ? [localDayKey(record.createdAt)] : [])).size,
    [records],
  );
  const chapterCounts = useMemo(() => {
    const counts = new Map<string, number>();
    records.forEach((record) => record.outlinePath.forEach((item) => counts.set(item.id, (counts.get(item.id) ?? 0) + 1)));
    return counts;
  }, [records]);
  const chapterRecords = useMemo(
    () => selectedChapterId
      ? records.filter((record) => record.outlinePath.some((item) => item.id === selectedChapterId))
      : [],
    [records, selectedChapterId],
  );
  const quickRecords = selectedChapterId && chapterRecords.length ? chapterRecords : records;
  const safeQuickIndex = Math.min(quickIndex, Math.max(0, quickRecords.length - 1));
  const currentQuickRecord = quickRecords[safeQuickIndex] ?? null;

  useEffect(() => { quickIndexRef.current = quickIndex; }, [quickIndex]);

  const resetSheetDimensions = () => {
    sheetRef.current?.style.removeProperty("width");
    sheetRef.current?.style.removeProperty("height");
  };

  const closeHistory = () => {
    miniDragRef.current = null;
    resetSheetDimensions();
    setMiniMode(false);
    setMiniCalendarOpen(false);
    setMiniPosition(null);
    onClose();
  };

  const enterMiniMode = (compact = false) => {
    resetSheetDimensions();
    const width = Math.min(compact ? 430 : 520, Math.max(300, window.innerWidth - 24));
    const height = Math.min(compact ? 500 : 640, Math.max(300, window.innerHeight - 24));
    setMiniPosition({
      left: Math.max(12, Math.round((window.innerWidth - width) / 2)),
      top: Math.max(12, Math.round((window.innerHeight - height) / 2)),
    });
    requestAnimationFrame(() => {
      if (!sheetRef.current) return;
      sheetRef.current.style.width = `${width}px`;
      sheetRef.current.style.height = `${height}px`;
    });
    setShowReturnToTop(false);
    setMiniMode(true);
  };

  const visitRecord = useCallback((record: AnnotationRecord, showNote = false) => {
    setLastVisitedRecordId(record.id);
    onJump(record, { showNote });
  }, [onJump]);

  const goToQuickIndex = useCallback((nextIndex: number) => {
    if (!quickRecords.length) return;
    const bounded = Math.max(0, Math.min(quickRecords.length - 1, nextIndex));
    quickIndexRef.current = bounded;
    setQuickIndex(bounded);
    visitRecord(quickRecords[bounded], true);
  }, [quickRecords, visitRecord]);

  const startQuickReview = () => {
    const rememberedIndex = quickRecords.findIndex((record) => record.id === lastVisitedRecordId);
    const initialIndex = Math.max(0, rememberedIndex);
    setView("quick");
    enterMiniMode(true);
    goToQuickIndex(initialIndex);
  };

  useEffect(() => {
    if (!open) return;
    const handleReviewKeys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || target?.isContentEditable) return;

      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "d") {
        const selection = readSelectedNoteText();
        if (selection) {
          event.preventDefault();
          event.stopPropagation();
          onHighlightNote(selection);
        }
        return;
      }
      if (view !== "quick" || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "a" && key !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      goToQuickIndex(quickIndexRef.current + (key === "a" ? -1 : 1));
    };
    window.addEventListener("keydown", handleReviewKeys, true);
    return () => window.removeEventListener("keydown", handleReviewKeys, true);
  }, [goToQuickIndex, onHighlightNote, open, view]);

  const handleMiniPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!miniMode || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    miniDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
  };

  const handleMiniPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = miniDragRef.current;
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !rect) return;
    setMiniPosition({
      left: Math.min(Math.max(8, drag.left + event.clientX - drag.startX), Math.max(8, window.innerWidth - rect.width - 8)),
      top: Math.min(Math.max(8, drag.top + event.clientY - drag.startY), Math.max(8, window.innerHeight - rect.height - 8)),
    });
  };

  const stopMiniDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = miniDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    miniDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const modeTabs = (
    <nav className="annotation-history-modes" aria-label="批注复习方式">
      <button type="button" className={view === "calendar" ? "is-active" : ""} onClick={() => setView("calendar")}>日历阅读</button>
      <button type="button" className={view === "chapter" ? "is-active" : ""} onClick={() => setView("chapter")}>章节阅读</button>
      <button type="button" className={view === "quick" ? "is-active" : ""} onClick={startQuickReview}>快速复习</button>
    </nav>
  );

  const renderChapterNode = (node: OutlineNode, level = 1): React.ReactNode => {
    const count = chapterCounts.get(node.id) ?? 0;
    return (
      <div className={`annotation-chapter-node level-${level}`} key={node.id}>
        <button type="button" className={selectedChapterId === node.id ? "is-active" : ""} disabled={!count} onClick={() => setSelectedChapterId(node.id)}>
          <span>{node.title}</span><strong>{count} 条</strong>
        </button>
        {level < 3 && count > 0 && (node.children ?? []).map((child) => renderChapterNode(child, level + 1))}
      </div>
    );
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className={`annotation-history-backdrop ${miniMode ? "is-mini" : ""}`} role="presentation" onMouseDown={miniMode ? undefined : closeHistory}>
      <section
        ref={sheetRef}
        className={`annotation-history-sheet ${miniMode ? "is-mini" : ""}`}
        role="dialog"
        aria-modal={miniMode ? undefined : true}
        aria-labelledby="annotation-history-title"
        style={{
          ...(miniMode && miniPosition ? { left: `${miniPosition.left}px`, top: `${miniPosition.top}px` } : {}),
          "--note-font-scale": noteFontScale,
        } as CSSProperties}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {miniMode ? (
          <header className="annotation-history-mini-header" onPointerDown={handleMiniPointerDown} onPointerMove={handleMiniPointerMove} onPointerUp={stopMiniDrag} onPointerCancel={stopMiniDrag}>
            <div className="annotation-history-mini-controls">
              <button type="button" className="annotation-history-mini-close" aria-label="关闭批注历史小窗" onClick={closeHistory}>×</button>
              {view === "calendar" && <button type="button" className={`annotation-history-mini-calendar ${miniCalendarOpen ? "is-active" : ""}`} aria-label="切换其它日期" onClick={() => setMiniCalendarOpen((current) => !current)}>日</button>}
            </div>
            <div><strong id="annotation-history-title">{view === "quick" ? "快速复习" : view === "chapter" ? "章节批注" : "当日批注"}</strong><span>{view === "quick" ? "A 上一条 · S 下一条" : "拖动标题栏移动 · 右下角缩放"}</span></div>
            <span className="annotation-history-mini-grip" aria-hidden="true">•••</span>
          </header>
        ) : (
          <header className="annotation-history-header">
            <div className="annotation-history-heading"><span>批注历史 · 多模式复习</span><h2 id="annotation-history-title">我的批注</h2><p>按日期或章节阅读；快速复习中按 A / S 切换，划选批注文字后按 D 高亮。</p></div>
            <div className="annotation-history-summary" aria-label="批注历史统计">
              <div><strong>{records.length.toLocaleString("zh-CN")}</strong><span>条批注</span></div>
              <div><strong>{datedDayCount.toLocaleString("zh-CN")}</strong><span>个记录日</span></div>
              <button type="button" className="annotation-history-mini-launch" onClick={() => enterMiniMode()}>小窗复习</button><kbd>H / ·</kbd>
            </div>
            <button type="button" className="sheet-close" aria-label="关闭批注历史" onClick={closeHistory}>×</button>
          </header>
        )}

        <div className="annotation-history-tools">
          {modeTabs}
          <div className="annotation-note-font-controls" aria-label="批注字体大小">
            <span>批注字号</span>
            <button type="button" aria-label="缩小批注字体" onClick={() => onNoteFontScaleChange(Math.max(0.9, Number((noteFontScale - 0.1).toFixed(1))))}>A−</button>
            <output>{Math.round(noteFontScale * 100)}%</output>
            <button type="button" aria-label="放大批注字体" onClick={() => onNoteFontScaleChange(Math.min(1.7, Number((noteFontScale + 0.1).toFixed(1))))}>A＋</button>
          </div>
        </div>

        <div ref={contentRef} className={`annotation-history-content ${miniMode ? "is-mini" : ""} is-${view}`} onScroll={(event: UIEvent<HTMLDivElement>) => setShowReturnToTop(event.currentTarget.scrollTop > 180)}>
          {view === "calendar" && (
            <AnnotationCalendar active={open} dayOnly={miniMode} lastVisitedRecordId={lastVisitedRecordId} showDayPicker={miniMode && miniCalendarOpen} records={records} onDayPicked={() => setMiniCalendarOpen(false)} onJump={(record) => visitRecord(record)} />
          )}

          {view === "chapter" && (
            <div className="annotation-chapter-reader">
              <aside className="annotation-chapter-tree" aria-label="按大纲章节选择批注"><header><strong>选择章节</strong><span>数字为该范围内批注数</span></header>{outline.map((node) => renderChapterNode(node))}</aside>
              <section className="annotation-chapter-records">
                <header><strong>{selectedChapterId ? `${chapterRecords.length} 条批注` : "请选择左侧章节"}</strong>{selectedChapterId && chapterRecords.length > 0 && <button type="button" onClick={startQuickReview}>快速复习本章</button>}</header>
                {chapterRecords.map((record) => (
                  <article className={`annotation-reading-card ${record.id === lastVisitedRecordId ? "is-last-visited" : ""}`} key={record.id}>
                    <button type="button" onClick={() => visitRecord(record, true)}><strong>{record.entryText}</strong><span>第 {record.page} 页 ›</span></button>
                    <p><RecordNote record={record} /></p>
                    <small>{record.outlinePath.map((item) => item.title).join(" › ")}</small>
                  </article>
                ))}
              </section>
            </div>
          )}

          {view === "quick" && (
            <section className="annotation-quick-review" aria-live="polite">
              {currentQuickRecord ? <>
                <header><span>{safeQuickIndex + 1} / {quickRecords.length}</span><small>{selectedChapterId ? "当前章节" : "全部批注"}</small></header>
                <div className="annotation-quick-source"><strong>{currentQuickRecord.entryText}</strong><button type="button" onClick={() => visitRecord(currentQuickRecord, true)}>第 {currentQuickRecord.page} 页 ›</button></div>
                <p className="annotation-quick-note"><RecordNote record={currentQuickRecord} /></p>
                <footer><button type="button" disabled={safeQuickIndex === 0} onClick={() => goToQuickIndex(safeQuickIndex - 1)}><kbd>A</kbd> 上一条</button><button type="button" disabled={safeQuickIndex >= quickRecords.length - 1} onClick={() => goToQuickIndex(safeQuickIndex + 1)}>下一条 <kbd>S</kbd></button></footer>
              </> : <p className="annotation-calendar-no-records">当前范围没有批注</p>}
            </section>
          )}
        </div>
        {!miniMode && showReturnToTop && <button type="button" className="annotation-history-return-top" aria-label="回到历史记录顶部" onClick={() => contentRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>↑</button>}
      </section>
    </div>,
    document.body,
  );
}
