"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnnotationRecord } from "./lib/study-types";

type Props = {
  active?: boolean;
  lastVisitedRecordId?: string | null;
  records: AnnotationRecord[];
  onJump: (record: AnnotationRecord) => void;
};

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function localDayKey(value: string | number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthStart(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function formatSelectedDay(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  if (!year || !month || !day) return "选择日期";
  return `${year}年${month}月${day}日`;
}

export function AnnotationCalendar({
  active = true,
  lastVisitedRecordId = null,
  records,
  onJump,
}: Props) {
  const today = useMemo(() => new Date(), []);
  const todayKey = localDayKey(today);
  const [month, setMonth] = useState(() => monthStart(today));
  const [selectedDay, setSelectedDay] = useState(todayKey);
  const [hoveredRecordId, setHoveredRecordId] = useState<string | null>(null);
  const [revealedRecordIds, setRevealedRecordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [showAllNotes, setShowAllNotes] = useState(false);
  const [hiddenFromAllIds, setHiddenFromAllIds] = useState<Set<string>>(
    () => new Set(),
  );

  const recordsByDay = useMemo(() => {
    const result = new Map<string, AnnotationRecord[]>();
    records.forEach((record) => {
      if (!record.createdAt) return;
      const dayKey = localDayKey(record.createdAt);
      if (!dayKey) return;
      result.set(dayKey, [...(result.get(dayKey) ?? []), record]);
    });
    result.forEach((items) =>
      items.sort((left, right) =>
        (right.createdAt ?? "").localeCompare(left.createdAt ?? ""),
      ),
    );
    return result;
  }, [records]);

  const undatedRecords = useMemo(
    () => records.filter((record) => !record.createdAt),
    [records],
  );
  const selectedRecords = recordsByDay.get(selectedDay) ?? [];
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const leadingDays = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const dayCount = new Date(year, monthIndex + 1, 0).getDate();
  const calendarCells = Array.from(
    { length: Math.ceil((leadingDays + dayCount) / 7) * 7 },
    (_, index) => {
      const day = index - leadingDays + 1;
      if (day < 1 || day > dayCount) return null;
      const dayKey = localDayKey(new Date(year, monthIndex, day));
      return {
        day,
        dayKey,
        count: recordsByDay.get(dayKey)?.length ?? 0,
      };
    },
  );

  const chooseToday = () => {
    setMonth(monthStart(today));
    setSelectedDay(todayKey);
  };

  const changeMonth = (offset: number) => {
    const next = new Date(year, monthIndex + offset, 1);
    setMonth(next);
    setSelectedDay(localDayKey(next));
  };

  useEffect(() => {
    if (!active) {
      setHoveredRecordId(null);
      return;
    }

    const handleSpacePreview = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        !hoveredRecordId ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select") ||
        target?.isContentEditable
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (showAllNotes) {
        setHiddenFromAllIds((current) => {
          const next = new Set(current);
          if (next.has(hoveredRecordId)) next.delete(hoveredRecordId);
          else next.add(hoveredRecordId);
          return next;
        });
        return;
      }
      setRevealedRecordIds((current) => {
        const next = new Set(current);
        if (next.has(hoveredRecordId)) next.delete(hoveredRecordId);
        else next.add(hoveredRecordId);
        return next;
      });
    };

    window.addEventListener("keydown", handleSpacePreview, true);
    return () =>
      window.removeEventListener("keydown", handleSpacePreview, true);
  }, [active, hoveredRecordId, showAllNotes]);

  const toggleAllNotes = () => {
    setShowAllNotes((current) => !current);
    setHiddenFromAllIds(new Set());
  };

  const renderRecord = (record: AnnotationRecord) => {
    const noteVisible = showAllNotes
      ? !hiddenFromAllIds.has(record.id)
      : revealedRecordIds.has(record.id);
    return (
      <button
        type="button"
        className={[
          "annotation-record",
          noteVisible ? "is-note-visible" : "",
          record.id === lastVisitedRecordId ? "is-last-visited" : "",
        ].filter(Boolean).join(" ")}
        key={record.id}
        aria-expanded={noteVisible}
        onMouseEnter={() => setHoveredRecordId(record.id)}
        onMouseLeave={() =>
          setHoveredRecordId((current) =>
            current === record.id ? null : current,
          )
        }
        onFocus={() => setHoveredRecordId(record.id)}
        onBlur={() =>
          setHoveredRecordId((current) =>
            current === record.id ? null : current,
          )
        }
        onClick={() => onJump(record)}
      >
        {record.id === lastVisitedRecordId && (
          <span className="annotation-record-last-visited">上次看到这里</span>
        )}
        <span className="annotation-record-title">
          <strong>{record.entryText}</strong>
          <i>第 {record.page} 页 ›</i>
        </span>
        {noteVisible && <p>{record.note}</p>}
        <small>
          {record.versionName}
          {record.createdAt &&
            ` · ${new Date(record.createdAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}`}
          {!noteVisible && " · 悬停按空格查看批注"}
        </small>
      </button>
    );
  };

  return (
    <div className="annotation-calendar">
      <header className="annotation-calendar-header">
        <div>
          <strong>{year}年{monthIndex + 1}月</strong>
          <span>点击有数字的日期查看批注</span>
        </div>
        <div className="annotation-calendar-nav">
          <button type="button" aria-label="上个月" onClick={() => changeMonth(-1)}>‹</button>
          <button type="button" onClick={chooseToday}>今天</button>
          <button type="button" aria-label="下个月" onClick={() => changeMonth(1)}>›</button>
        </div>
      </header>

      <div className="annotation-calendar-grid" aria-label={`${year}年${monthIndex + 1}月批注日历`}>
        {WEEKDAYS.map((weekday) => (
          <span className="annotation-weekday" key={weekday}>{weekday}</span>
        ))}
        {calendarCells.map((cell, index) =>
          cell ? (
            <button
              type="button"
              className={[
                "annotation-calendar-day",
                cell.dayKey === selectedDay ? "is-selected" : "",
                cell.dayKey === todayKey ? "is-today" : "",
                cell.count ? "has-records" : "",
              ].filter(Boolean).join(" ")}
              aria-label={`${cell.day}日${cell.count ? `，${cell.count}条批注` : "，无批注"}`}
              aria-pressed={cell.dayKey === selectedDay}
              key={cell.dayKey}
              onClick={() => setSelectedDay(cell.dayKey)}
            >
              <span>{cell.day}</span>
              {cell.count > 0 && <i>{cell.count}</i>}
            </button>
          ) : (
            <span className="annotation-calendar-empty" key={`empty-${index}`} />
          ),
        )}
      </div>

      <section className="annotation-day-records" aria-label={`${formatSelectedDay(selectedDay)}批注记录`}>
        <header>
          <div>
            <strong>{formatSelectedDay(selectedDay)}</strong>
            <span>{selectedRecords.length} 条</span>
          </div>
          <button
            type="button"
            className={showAllNotes ? "is-active" : ""}
            aria-pressed={showAllNotes}
            onClick={toggleAllNotes}
          >
            {showAllNotes ? "隐藏全部批注" : "显示全部批注"}
          </button>
        </header>
        {selectedRecords.length ? (
          <div className="annotation-record-list">
            {selectedRecords.map(renderRecord)}
          </div>
        ) : (
          <p className="annotation-calendar-no-records">这一天没有新增批注</p>
        )}
      </section>

      {undatedRecords.length > 0 && (
        <details className="annotation-undated">
          <summary>历史批注（日期未记录） · {undatedRecords.length} 条</summary>
          <div className="annotation-record-list">
            {undatedRecords.map(renderRecord)}
          </div>
        </details>
      )}
    </div>
  );
}
