"use client";

import { UIEvent, useEffect, useMemo, useRef, useState } from "react";
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
  const contentRef = useRef<HTMLDivElement | null>(null);
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

  const handleContentScroll = (event: UIEvent<HTMLDivElement>) => {
    setShowReturnToTop(event.currentTarget.scrollTop > 180);
  };

  const returnToTop = () => {
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (!portalReady || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="annotation-history-backdrop"
      role="presentation"
      hidden={!open}
      onMouseDown={onClose}
    >
      <section
        className="annotation-history-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="annotation-history-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
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
            <kbd>H</kbd>
          </div>
          <button
            type="button"
            className="sheet-close"
            aria-label="关闭批注历史"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div
          ref={contentRef}
          className="annotation-history-content"
          onScroll={handleContentScroll}
        >
          <AnnotationCalendar
            active={open}
            lastVisitedRecordId={lastVisitedRecordId}
            records={records}
            onJump={(record) => {
              setLastVisitedRecordId(record.id);
              onClose();
              onJump(record);
            }}
          />
        </div>
        {showReturnToTop && (
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
