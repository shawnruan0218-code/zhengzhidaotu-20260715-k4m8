"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  UIEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnnotationCalendar } from "./annotation-calendar";
import type { AnnotationRecord } from "./lib/study-types";

type Props = {
  open: boolean;
  records: AnnotationRecord[];
  onClose: () => void;
  onJump: (record: AnnotationRecord) => void;
};

function localDayKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

type MiniPosition = {
  left: number;
  top: number;
};

export function AnnotationHistoryDialog({
  open,
  records,
  onClose,
  onJump,
}: Props) {
  const [portalReady, setPortalReady] = useState(false);
  const [showReturnToTop, setShowReturnToTop] = useState(false);
  const [lastVisitedRecordId, setLastVisitedRecordId] = useState<string | null>(
    null,
  );
  const [miniMode, setMiniMode] = useState(false);
  const [miniCalendarOpen, setMiniCalendarOpen] = useState(false);
  const [miniPosition, setMiniPosition] = useState<MiniPosition | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const miniDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null>(null);
  const datedDayCount = useMemo(
    () =>
      new Set(
        records.flatMap((record) =>
          record.createdAt ? [localDayKey(record.createdAt)] : [],
        ),
      ).size,
    [records],
  );

  useEffect(() => {
    setPortalReady(true);
  }, []);

  const resetSheetDimensions = () => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.style.removeProperty("width");
    sheet.style.removeProperty("height");
  };

  const handleContentScroll = (event: UIEvent<HTMLDivElement>) => {
    setShowReturnToTop(event.currentTarget.scrollTop > 180);
  };

  const returnToTop = () => {
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const closeHistory = () => {
    miniDragRef.current = null;
    resetSheetDimensions();
    setMiniMode(false);
    setMiniCalendarOpen(false);
    setMiniPosition(null);
    onClose();
  };

  const enterMiniMode = () => {
    resetSheetDimensions();
    const width = Math.min(520, Math.max(340, window.innerWidth - 24));
    const height = Math.min(640, Math.max(360, window.innerHeight - 24));
    setMiniPosition({
      left: Math.max(12, Math.round((window.innerWidth - width) / 2)),
      top: Math.max(12, Math.round((window.innerHeight - height) / 2)),
    });
    setShowReturnToTop(false);
    setMiniMode(true);
  };

  const handleMiniPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!miniMode || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    miniDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
  };

  const handleMiniPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = miniDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nextLeft = drag.left + event.clientX - drag.startX;
    const nextTop = drag.top + event.clientY - drag.startY;
    setMiniPosition({
      left: Math.min(
        Math.max(8, nextLeft),
        Math.max(8, window.innerWidth - rect.width - 8),
      ),
      top: Math.min(
        Math.max(8, nextTop),
        Math.max(8, window.innerHeight - rect.height - 8),
      ),
    });
  };

  const stopMiniDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = miniDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    miniDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!portalReady || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={[
        "annotation-history-backdrop",
        miniMode ? "is-mini" : "",
      ].filter(Boolean).join(" ")}
      role="presentation"
      hidden={!open}
      onMouseDown={miniMode ? undefined : closeHistory}
    >
      <section
        ref={sheetRef}
        className={[
          "annotation-history-sheet",
          miniMode ? "is-mini" : "",
        ].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal={miniMode ? undefined : true}
        aria-labelledby="annotation-history-title"
        style={
          miniMode && miniPosition
            ? {
                left: `${miniPosition.left}px`,
                top: `${miniPosition.top}px`,
              } as CSSProperties
            : undefined
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        {miniMode ? (
          <header
            className="annotation-history-mini-header"
            onPointerDown={handleMiniPointerDown}
            onPointerMove={handleMiniPointerMove}
            onPointerUp={stopMiniDrag}
            onPointerCancel={stopMiniDrag}
          >
            <div className="annotation-history-mini-controls">
              <button
                type="button"
                className="annotation-history-mini-close"
                aria-label="关闭批注历史小窗"
                title="关闭小窗"
                onClick={closeHistory}
              >
                ×
              </button>
              <button
                type="button"
                className={[
                  "annotation-history-mini-calendar",
                  miniCalendarOpen ? "is-active" : "",
                ].filter(Boolean).join(" ")}
                aria-label="切换其它日期"
                aria-expanded={miniCalendarOpen}
                title="打开日历切换日期"
                onClick={() => setMiniCalendarOpen((current) => !current)}
              >
                日
              </button>
            </div>
            <div>
              <strong id="annotation-history-title">当日批注</strong>
              <span>拖动标题栏移动 · 右下角缩放</span>
            </div>
            <span className="annotation-history-mini-grip" aria-hidden="true">•••</span>
          </header>
        ) : (
          <header className="annotation-history-header">
            <div className="annotation-history-heading">
              <span>批注历史 · 每日复习</span>
              <h2 id="annotation-history-title">我的批注日历</h2>
              <p>选择日期查看当天词条；悬停记录后按空格预览批注，点击记录跳转原文。</p>
            </div>
            <div className="annotation-history-summary" aria-label="批注历史统计">
              <div>
                <strong>{records.length.toLocaleString("zh-CN")}</strong>
                <span>条批注</span>
              </div>
              <div>
                <strong>{datedDayCount.toLocaleString("zh-CN")}</strong>
                <span>个记录日</span>
              </div>
              <button
                type="button"
                className="annotation-history-mini-launch"
                onClick={enterMiniMode}
              >
                小窗复习
              </button>
              <kbd>H / ·</kbd>
            </div>
            <button
              type="button"
              className="sheet-close"
              aria-label="关闭批注历史"
              onClick={closeHistory}
            >
              ×
            </button>
          </header>
        )}

        <div
          ref={contentRef}
          className={[
            "annotation-history-content",
            miniMode ? "is-mini" : "",
          ].filter(Boolean).join(" ")}
          onScroll={handleContentScroll}
        >
          <AnnotationCalendar
            active={open}
            dayOnly={miniMode}
            lastVisitedRecordId={lastVisitedRecordId}
            showDayPicker={miniMode && miniCalendarOpen}
            records={records}
            onDayPicked={() => setMiniCalendarOpen(false)}
            onJump={(record) => {
              setLastVisitedRecordId(record.id);
              onJump(record);
            }}
          />
        </div>
        {!miniMode && showReturnToTop && (
          <button
            type="button"
            className="annotation-history-return-top"
            aria-label="回到历史记录顶部"
            title="回到顶部"
            onClick={returnToTop}
          >
            ↑
          </button>
        )}
      </section>
    </div>,
    document.body,
  );
}
