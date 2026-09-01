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
import {
  HighlightedEntryText,
  readSelectedEntryText,
  type SelectedEntryText,
} from "./entry-highlight-text";
import { STORAGE_KEYS } from "./lib/app-config";
import {
  createFiveDaySprintPlan,
  FIVE_DAY_SPRINT_DAYS,
  fiveDaySprintDayForRecord,
  recordsByFiveDaySprint,
  type FiveDaySprintDay,
  type FiveDaySprintPlan,
} from "./lib/five-day-sprint";
import { shortcutKey } from "./lib/keyboard-shortcuts";
import type { OutlineNode } from "./lib/outline-navigation";
import {
  createReviewBookmark,
  findReviewBookmarkRecord,
  type ReviewBookmark,
  type ReviewBookmarkScope,
} from "./lib/review-bookmark";
import type { AnnotationRecord, ReviewLibraryLevel } from "./lib/study-types";
import {
  HighlightedNoteText,
  readSelectedNoteText,
  type SelectedNoteText,
} from "./note-highlight-text";

type HistoryView = "calendar" | "chapter" | "sprint" | "library" | "quick";
type QuickScope = "all" | "chapter" | "sprint" | "library";

type QuickReviewStartOptions = {
  startRecordId?: string;
  chapterId?: string;
  sprintDay?: FiveDaySprintDay;
  libraryLevel?: ReviewLibraryLevel;
};

export type MiniReviewBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type Props = {
  open: boolean;
  records: AnnotationRecord[];
  reviewRecordsByLevel: Record<ReviewLibraryLevel, AnnotationRecord[]>;
  fiveDaySprintPlan: FiveDaySprintPlan | null;
  reviewBookmark: ReviewBookmark | null;
  outline: OutlineNode[];
  currentOutlineNodeId: string | null;
  noteFontScale: number;
  onNoteFontScaleChange: (scale: number) => void;
  onClose: () => void;
  onJump: (record: AnnotationRecord, options?: { showNote?: boolean }) => void;
  onUpdateNote: (record: AnnotationRecord, note: string) => void;
  onAddToReview: (record: AnnotationRecord, level: ReviewLibraryLevel) => void;
  onRemoveFromReview: (record: AnnotationRecord, level: ReviewLibraryLevel) => void;
  onHighlightNote: (selection: SelectedNoteText) => void;
  onRemoveNoteHighlight: (selection: SelectedNoteText) => void;
  onHighlightEntryText: (selection: SelectedEntryText) => void;
  onRemoveEntryTextHighlight: (selection: SelectedEntryText) => void;
  onCreateFiveDaySprintPlan: (plan: FiveDaySprintPlan) => boolean;
  onSaveReviewBookmark: (bookmark: ReviewBookmark) => boolean;
  onMiniBoundsChange: (bounds: MiniReviewBounds | null) => void;
};

function localDayKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function outlineIdPathForNode(nodes: OutlineNode[], targetId: string, parentIds: string[] = []): string[] {
  for (const node of nodes) {
    const path = [...parentIds, node.id];
    if (node.id === targetId) return path;
    const childPath = outlineIdPathForNode(node.children ?? [], targetId, path);
    if (childPath.length) return childPath;
  }
  return [];
}

type TodayReviewState = {
  day: string;
  ids: Set<string>;
};

type StoredQuickReviewActivity = {
  schemaVersion: 1;
  days: Record<string, string[]>;
};

function readQuickReviewActivity(): StoredQuickReviewActivity {
  if (typeof window === "undefined") return { schemaVersion: 1, days: {} };
  try {
    const candidate = JSON.parse(window.localStorage.getItem(STORAGE_KEYS.quickReviewActivity) ?? "null") as Partial<StoredQuickReviewActivity> | null;
    if (!candidate || candidate.schemaVersion !== 1 || !candidate.days || typeof candidate.days !== "object") {
      return { schemaVersion: 1, days: {} };
    }
    return {
      schemaVersion: 1,
      days: Object.fromEntries(
        Object.entries(candidate.days).flatMap(([day, ids]) =>
          /^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(ids)
            ? [[day, [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))]]]
            : [],
        ),
      ),
    };
  } catch {
    return { schemaVersion: 1, days: {} };
  }
}

function initialTodayReviewState(): TodayReviewState {
  const day = localDayKey(new Date().toISOString());
  return { day, ids: new Set(readQuickReviewActivity().days[day] ?? []) };
}

function persistQuickReviewVisit(state: TodayReviewState) {
  const stored = readQuickReviewActivity();
  const oldestDay = localDayKey(new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString());
  const days = Object.fromEntries(Object.entries(stored.days).filter(([day]) => day >= oldestDay));
  days[state.day] = [...state.ids];
  try {
    window.localStorage.setItem(STORAGE_KEYS.quickReviewActivity, JSON.stringify({ schemaVersion: 1, days } satisfies StoredQuickReviewActivity));
  } catch {
    // 阅读计数失败不能影响批注复习。
  }
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

function InlineNoteEditor({
  record,
  onSave,
  onHighlight,
  onRemoveHighlight,
}: {
  record: AnnotationRecord;
  onSave: (record: AnnotationRecord, note: string) => void;
  onHighlight: (selection: SelectedNoteText) => void;
  onRemoveHighlight: (selection: SelectedNoteText) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.note);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(72, textarea.scrollHeight)}px`;
  }, []);

  const saveDraft = useCallback((value = draft) => {
    const normalized = value.trim();
    if (!normalized || normalized === record.note) return;
    onSave(record, normalized);
  }, [draft, onSave, record]);

  useEffect(() => {
    if (!editing) return;
    resize();
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (draft.trim() && draft.trim() !== record.note) {
      saveTimerRef.current = setTimeout(() => saveDraft(draft), 450);
    }
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [draft, editing, record.note, resize, saveDraft]);

  const beginEditing = useCallback(() => {
    setDraft(record.note);
    setEditing(true);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resize();
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }, [record.note, resize]);

  return (
    <div className={`annotation-inline-note ${editing ? "is-editing" : ""}`}>
      <div className="annotation-inline-note-toolbar">
        <button
          type="button"
          className="annotation-inline-note-edit"
          aria-label={editing ? `完成修改“${record.entryText}”的批注` : `编辑“${record.entryText}”的批注`}
          onMouseDown={(event) => {
            if (editing) event.preventDefault();
          }}
          onClick={() => {
            if (editing) {
              saveDraft();
              setEditing(false);
            } else {
              beginEditing();
            }
          }}
        >
          {editing ? "完成" : "编辑"}
        </button>
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          className="annotation-inline-note-editor"
          aria-label={`直接修改“${record.entryText}”的批注`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            saveDraft();
            setEditing(false);
          }}
          onKeyDown={(event) => {
            const key = shortcutKey(event);
            const textarea = event.currentTarget;
            if (!event.metaKey && !event.ctrlKey && !event.altKey && (key === "d" || key === "f") && textarea.selectionEnd > textarea.selectionStart) {
              event.preventDefault();
              event.stopPropagation();
              if (event.repeat) return;
              const selection = {
                entryId: record.entryId,
                versionId: record.versionId,
                start: textarea.selectionStart,
                end: textarea.selectionEnd,
                quote: draft.slice(textarea.selectionStart, textarea.selectionEnd),
              } satisfies SelectedNoteText;
              if (key === "d") onHighlight(selection);
              else onRemoveHighlight(selection);
              return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              saveDraft();
              textarea.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(record.note);
              textarea.blur();
            }
          }}
        />
      ) : (
        <div
          role="textbox"
          tabIndex={0}
          className="annotation-inline-note-display"
          aria-label={`“${record.entryText}”的批注，只读；点上方编辑按钮可修改`}
          aria-readonly="true"
          onKeyDown={(event) => {
            const key = shortcutKey(event);
            if (!event.metaKey && !event.ctrlKey && !event.altKey && (key === "d" || key === "f")) {
              if (event.repeat) {
                event.preventDefault();
                return;
              }
              const selection = readSelectedNoteText();
              if (
                selection &&
                selection.entryId === record.entryId &&
                selection.versionId === record.versionId
              ) {
                event.preventDefault();
                event.stopPropagation();
                if (key === "d") onHighlight(selection);
                else onRemoveHighlight(selection);
              }
              return;
            }
          }}
        >
          {record.note ? <RecordNote record={record} /> : <span className="annotation-inline-note-placeholder">暂无批注，点上方“编辑”添加</span>}
        </div>
      )}
    </div>
  );
}

export function AnnotationHistoryDialog({
  open,
  records,
  reviewRecordsByLevel,
  fiveDaySprintPlan,
  reviewBookmark,
  outline,
  currentOutlineNodeId,
  noteFontScale,
  onNoteFontScaleChange,
  onClose,
  onJump,
  onUpdateNote,
  onAddToReview,
  onRemoveFromReview,
  onHighlightNote,
  onRemoveNoteHighlight,
  onHighlightEntryText,
  onRemoveEntryTextHighlight,
  onCreateFiveDaySprintPlan,
  onSaveReviewBookmark,
  onMiniBoundsChange,
}: Props) {
  const [showReturnToTop, setShowReturnToTop] = useState(false);
  const [lastVisitedRecordId, setLastVisitedRecordId] = useState<string | null>(null);
  const [miniMode, setMiniMode] = useState(false);
  const [miniCalendarOpen, setMiniCalendarOpen] = useState(false);
  const [miniPosition, setMiniPosition] = useState<{ left: number; top: number } | null>(null);
  const [view, setView] = useState<HistoryView>("calendar");
  const [quickScope, setQuickScope] = useState<QuickScope>("all");
  const [selectedLibraryLevel, setSelectedLibraryLevel] = useState<ReviewLibraryLevel>(1);
  const [quickLibraryLevel, setQuickLibraryLevel] = useState<ReviewLibraryLevel>(1);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [selectedSprintDay, setSelectedSprintDay] = useState<FiveDaySprintDay>(1);
  const [quickIndex, setQuickIndex] = useState(0);
  const [quickJumpDraft, setQuickJumpDraft] = useState("1");
  const [bookmarkFeedback, setBookmarkFeedback] = useState("");
  const [todayReviewState, setTodayReviewState] = useState<TodayReviewState>(initialTodayReviewState);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const quickIndexRef = useRef(0);
  const todayReviewStateRef = useRef(todayReviewState);
  const chapterRecordsRef = useRef<HTMLElement | null>(null);
  const chapterTreeRef = useRef<HTMLElement | null>(null);
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
  const sprintRecordsByDay = useMemo(
    () => recordsByFiveDaySprint(outline, records, fiveDaySprintPlan),
    [fiveDaySprintPlan, outline, records],
  );
  const selectedSprintRecords = sprintRecordsByDay[selectedSprintDay];
  const selectedLibraryRecords = reviewRecordsByLevel[selectedLibraryLevel];
  const quickRecords = quickScope === "library"
    ? reviewRecordsByLevel[quickLibraryLevel]
    : quickScope === "sprint"
      ? selectedSprintRecords
    : quickScope === "chapter" && selectedChapterId && chapterRecords.length
      ? chapterRecords
      : records;
  const targetLibraryLevel: ReviewLibraryLevel | null = quickScope === "library"
    ? quickLibraryLevel < 3 ? (quickLibraryLevel + 1) as ReviewLibraryLevel : null
    : 1;
  const targetReviewRecordIds = useMemo(
    () => new Set(targetLibraryLevel ? reviewRecordsByLevel[targetLibraryLevel].map((record) => record.id) : []),
    [reviewRecordsByLevel, targetLibraryLevel],
  );
  const safeQuickIndex = Math.min(quickIndex, Math.max(0, quickRecords.length - 1));
  const currentQuickRecord = quickRecords[safeQuickIndex] ?? null;
  const isCurrentQuickRecordBookmarked = Boolean(
    reviewBookmark && currentQuickRecord && (
      reviewBookmark.recordId === currentQuickRecord.id ||
      (reviewBookmark.versionId === currentQuickRecord.versionId && reviewBookmark.entryId === currentQuickRecord.entryId)
    ),
  );

  useEffect(() => { quickIndexRef.current = quickIndex; }, [quickIndex]);

  useEffect(() => {
    if (view !== "chapter" || !selectedChapterId) return;
    const frame = requestAnimationFrame(() => {
      chapterRecordsRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedChapterId, view]);

  useEffect(() => {
    if (view !== "chapter" || !selectedChapterId) return;
    const frame = requestAnimationFrame(() => {
      const tree = chapterTreeRef.current;
      const row = tree?.querySelector<HTMLElement>(`[data-chapter-id="${CSS.escape(selectedChapterId)}"]`);
      if (!tree || !row) return;
      const treeRect = tree.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      tree.scrollTo({
        top: Math.max(0, tree.scrollTop + rowRect.top - treeRect.top - tree.clientHeight / 2 + rowRect.height / 2),
        behavior: "auto",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedChapterId, view]);

  useEffect(() => {
    if (!open || !miniMode || !sheetRef.current) {
      onMiniBoundsChange(null);
      return;
    }
    const sheet = sheetRef.current;
    const publishBounds = () => {
      const rect = sheet.getBoundingClientRect();
      onMiniBoundsChange({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };
    const frame = requestAnimationFrame(publishBounds);
    const observer = new ResizeObserver(publishBounds);
    observer.observe(sheet);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [miniMode, onMiniBoundsChange, open]);

  useEffect(() => {
    if (!open || !miniMode) return;
    const frame = requestAnimationFrame(() => {
      const rect = sheetRef.current?.getBoundingClientRect();
      if (rect) onMiniBoundsChange({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    });
    return () => cancelAnimationFrame(frame);
  }, [miniMode, miniPosition, onMiniBoundsChange, open]);

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
      left: compact
        ? Math.max(12, Math.round(window.innerWidth - width - 12))
        : Math.max(12, Math.round((window.innerWidth - width) / 2)),
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

  const markQuickRecordViewed = useCallback((record: AnnotationRecord) => {
    const day = localDayKey(new Date().toISOString());
    const current = todayReviewStateRef.current;
    const ids = current.day === day ? new Set(current.ids) : new Set<string>();
    if (ids.has(record.id)) return;
    ids.add(record.id);
    const next = { day, ids };
    todayReviewStateRef.current = next;
    setTodayReviewState(next);
    persistQuickReviewVisit(next);
  }, []);

  const goToQuickIndex = useCallback((nextIndex: number) => {
    if (!quickRecords.length) return;
    const bounded = Math.max(0, Math.min(quickRecords.length - 1, nextIndex));
    quickIndexRef.current = bounded;
    setQuickIndex(bounded);
    setQuickJumpDraft(String(bounded + 1));
    markQuickRecordViewed(quickRecords[bounded]);
    visitRecord(quickRecords[bounded], true);
  }, [markQuickRecordViewed, quickRecords, visitRecord]);

  const submitQuickJump = useCallback(() => {
    const requested = Number.parseInt(quickJumpDraft, 10);
    if (!Number.isFinite(requested) || !quickRecords.length) {
      setQuickJumpDraft(String(safeQuickIndex + 1));
      return;
    }
    const bounded = Math.max(1, Math.min(quickRecords.length, requested));
    setQuickJumpDraft(String(bounded));
    goToQuickIndex(bounded - 1);
  }, [goToQuickIndex, quickJumpDraft, quickRecords.length, safeQuickIndex]);

  const startQuickReview = (scope: QuickScope = "all", options: QuickReviewStartOptions = {}) => {
    const libraryLevel = options.libraryLevel ?? selectedLibraryLevel;
    const sprintDay = options.sprintDay ?? selectedSprintDay;
    const chapterId = options.chapterId ?? selectedChapterId;
    const scopedChapterRecords = chapterId
      ? records.filter((record) => record.outlinePath.some((item) => item.id === chapterId))
      : [];
    const scopedRecords = scope === "library"
      ? reviewRecordsByLevel[libraryLevel]
      : scope === "sprint"
        ? sprintRecordsByDay[sprintDay]
      : scope === "chapter" && scopedChapterRecords.length
        ? scopedChapterRecords
        : records;
    if (!scopedRecords.length) return;
    setQuickScope(scope);
    if (scope === "library") setQuickLibraryLevel(libraryLevel);
    if (scope === "sprint") setSelectedSprintDay(sprintDay);
    if (scope === "chapter" && chapterId) setSelectedChapterId(chapterId);
    const preferredRecordId = options.startRecordId ?? lastVisitedRecordId;
    const rememberedIndex = scopedRecords.findIndex((record) => record.id === preferredRecordId);
    const initialIndex = Math.max(0, rememberedIndex);
    setView("quick");
    enterMiniMode(true);
    quickIndexRef.current = initialIndex;
    setQuickIndex(initialIndex);
    setQuickJumpDraft(String(initialIndex + 1));
    markQuickRecordViewed(scopedRecords[initialIndex]);
    visitRecord(scopedRecords[initialIndex], true);
  };

  const currentReviewBookmarkScope = (): ReviewBookmarkScope => {
    if (quickScope === "library") return { type: "library", level: quickLibraryLevel };
    if (quickScope === "sprint") return { type: "sprint", day: selectedSprintDay };
    if (quickScope === "chapter" && selectedChapterId) {
      return { type: "chapter", chapterId: selectedChapterId };
    }
    return { type: "all" };
  };

  const markCurrentReviewPosition = () => {
    if (!currentQuickRecord) return;
    const next = createReviewBookmark(currentQuickRecord, currentReviewBookmarkScope(), reviewBookmark);
    if (!onSaveReviewBookmark(next)) return;
    setBookmarkFeedback("已标记当前位置");
    window.setTimeout(() => setBookmarkFeedback(""), 1_800);
  };

  const returnToReviewBookmark = () => {
    if (!reviewBookmark) return;
    const record = findReviewBookmarkRecord(reviewBookmark, records);
    if (!record) {
      setBookmarkFeedback("书签对应的批注暂时不存在");
      return;
    }
    const { scope } = reviewBookmark;
    if (scope.type === "library") {
      startQuickReview("library", { libraryLevel: scope.level, startRecordId: record.id });
    } else if (scope.type === "sprint") {
      startQuickReview("sprint", { sprintDay: scope.day, startRecordId: record.id });
    } else if (scope.type === "chapter") {
      startQuickReview("chapter", { chapterId: scope.chapterId, startRecordId: record.id });
    } else {
      startQuickReview("all", { startRecordId: record.id });
    }
    setBookmarkFeedback("已回到标记位置");
    window.setTimeout(() => setBookmarkFeedback(""), 1_800);
  };

  const openChapterView = () => {
    const reviewingPath = view === "quick"
      ? currentQuickRecord?.outlinePath.map((item) => item.id) ?? []
      : [];
    const locationPath = reviewingPath.length
      ? reviewingPath
      : currentOutlineNodeId
        ? outlineIdPathForNode(outline, currentOutlineNodeId)
        : [];
    const targetId = [...locationPath].reverse().find((id) => (chapterCounts.get(id) ?? 0) > 0)
      ?? locationPath[0]
      ?? currentOutlineNodeId;
    if (targetId) setSelectedChapterId(targetId);
    setView("chapter");
  };

  const openFiveDaySprint = () => {
    let plan = fiveDaySprintPlan;
    if (!plan) {
      plan = createFiveDaySprintPlan(outline, records);
      if (!onCreateFiveDaySprintPlan(plan)) return;
    }
    if (view === "quick" && currentQuickRecord) {
      setSelectedSprintDay(fiveDaySprintDayForRecord(plan, currentQuickRecord));
    }
    setView("sprint");
  };

  useEffect(() => {
    if (!open) return;
    const handleReviewKeys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || target?.isContentEditable) return;

      const selectionKey = shortcutKey(event);
      if (!event.metaKey && !event.ctrlKey && !event.altKey && (selectionKey === "d" || selectionKey === "f")) {
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        const liveSelection = window.getSelection();
        const liveElement = liveSelection?.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? liveSelection.anchorNode as Element
          : liveSelection?.anchorNode?.parentElement;
        const isEntryTextSelection = Boolean(
          liveSelection &&
          !liveSelection.isCollapsed &&
          liveElement?.closest("[data-entry-highlight-root='true']"),
        );
        const entrySelection = isEntryTextSelection ? readSelectedEntryText() : null;
        if (entrySelection) {
          event.preventDefault();
          event.stopPropagation();
          if (selectionKey === "d") onHighlightEntryText(entrySelection);
          else onRemoveEntryTextHighlight(entrySelection);
          return;
        }
        const noteSelection = readSelectedNoteText();
        if (noteSelection) {
          event.preventDefault();
          event.stopPropagation();
          if (selectionKey === "d") onHighlightNote(noteSelection);
          else onRemoveNoteHighlight(noteSelection);
        }
        return;
      }
      if (view !== "quick" || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = shortcutKey(event);
      if (key === "1" && currentQuickRecord && targetLibraryLevel) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) onAddToReview(currentQuickRecord, targetLibraryLevel);
        return;
      }
      if (key !== "a" && key !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      goToQuickIndex(quickIndexRef.current + (key === "a" ? -1 : 1));
    };
    window.addEventListener("keydown", handleReviewKeys, true);
    return () => window.removeEventListener("keydown", handleReviewKeys, true);
  }, [currentQuickRecord, goToQuickIndex, onAddToReview, onHighlightEntryText, onHighlightNote, onRemoveEntryTextHighlight, onRemoveNoteHighlight, open, targetLibraryLevel, view]);

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
      <button type="button" className={view === "chapter" ? "is-active" : ""} onClick={openChapterView}>章节阅读</button>
      <button type="button" className={view === "sprint" ? "is-active" : ""} onClick={openFiveDaySprint}>五天冲刺</button>
      <button type="button" className={view === "library" ? "is-active" : ""} onClick={() => { setSelectedLibraryLevel(1); setView("library"); }}>复习库 1</button>
      <button type="button" className={view === "quick" ? "is-active" : ""} onClick={() => startQuickReview("all")}>快速复习</button>
    </nav>
  );

  const renderChapterNode = (node: OutlineNode, level = 1): React.ReactNode => {
    const count = chapterCounts.get(node.id) ?? 0;
    return (
      <div className={`annotation-chapter-node level-${level}`} key={node.id}>
        <button type="button" data-chapter-id={node.id} className={selectedChapterId === node.id ? "is-active" : ""} disabled={!count} onClick={() => setSelectedChapterId(node.id)}>
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
        className={`annotation-history-sheet ${miniMode ? "is-mini" : ""} ${reviewBookmark || (view === "quick" && currentQuickRecord) ? "has-review-bookmark-dock" : ""}`}
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
            <div><strong id="annotation-history-title">{view === "quick" ? "快速复习" : view === "chapter" ? "章节批注" : view === "sprint" ? "五天冲刺" : view === "library" ? "复习库" : "当日批注"}</strong><span>{view === "quick" ? "划选后按 D 高亮 · A / S 切换 · 右下角可标记当前位置" : "拖动标题栏移动 · 右下角缩放"}</span></div>
            <div className="annotation-history-mini-meta">{view === "quick" && <span className="annotation-history-today-count">今日共看了 {todayReviewState.ids.size.toLocaleString("zh-CN")} 条</span>}<span className="annotation-history-mini-grip" aria-hidden="true">•••</span></div>
          </header>
        ) : (
          <header className="annotation-history-header">
            <div className="annotation-history-heading"><span>批注历史 · 多模式复习</span><h2 id="annotation-history-title">我的批注</h2><p>快速复习按 A / S 切换；划选原文或批注后按 D 高亮、按 F 取消高亮。</p></div>
            <div className="annotation-history-summary" aria-label="批注历史统计">
              <div><strong>{records.length.toLocaleString("zh-CN")}</strong><span>条批注</span></div>
              <div><strong>{datedDayCount.toLocaleString("zh-CN")}</strong><span>个记录日</span></div>
              <button type="button" className="annotation-history-sprint-launch" onClick={openFiveDaySprint}><strong>5</strong><span>天冲刺</span></button>
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
              <aside ref={chapterTreeRef} className="annotation-chapter-tree" aria-label="按大纲章节选择批注"><header><strong>选择章节</strong><span>已自动定位当前章节</span></header>{outline.map((node) => renderChapterNode(node))}</aside>
              <section ref={chapterRecordsRef} className="annotation-chapter-records">
                <header><strong>{selectedChapterId ? `${chapterRecords.length} 条批注` : "请选择左侧章节"}</strong>{selectedChapterId && chapterRecords.length > 0 && <button type="button" onClick={() => startQuickReview("chapter")}>快速复习本章</button>}</header>
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

          {view === "sprint" && (
            <section className="annotation-sprint" aria-label="五天冲刺复习">
              <header>
                <div><strong>五天冲刺</strong><span>首次按章节顺序近似均分；以后新批注固定加入所属章节的这一天</span></div>
                <button type="button" disabled={!selectedSprintRecords.length} onClick={() => startQuickReview("sprint")}>快速复习第 {selectedSprintDay} 天</button>
              </header>
              <nav className="annotation-sprint-days" aria-label="选择冲刺天数">
                {FIVE_DAY_SPRINT_DAYS.map((day) => (
                  <button type="button" className={selectedSprintDay === day ? "is-active" : ""} onClick={() => setSelectedSprintDay(day)} key={day}>
                    <span>第 {day} 天</span><strong>{sprintRecordsByDay[day].length} 条</strong>
                  </button>
                ))}
              </nav>
              {!selectedSprintRecords.length && <p className="annotation-calendar-no-records">这一天暂无批注</p>}
              <div className="annotation-sprint-records">
                {selectedSprintRecords.map((record) => (
                  <article className={`annotation-review-library-card ${record.id === lastVisitedRecordId ? "is-last-visited" : ""}`} key={record.id}>
                    <div className="annotation-sprint-record-actions">
                      <button type="button" className="annotation-sprint-start" onClick={() => startQuickReview("sprint", { sprintDay: selectedSprintDay, startRecordId: record.id })}>
                        <strong><HighlightedEntryText text={record.entryText} ranges={record.entryTextHighlights} entryId={record.entryId} versionId={record.versionId} /></strong>
                        <span>从此条开始快速复习</span>
                      </button>
                      <button type="button" className="annotation-sprint-page" onClick={() => visitRecord(record, true)}>第 {record.page} 页 ›</button>
                    </div>
                    <InlineNoteEditor key={record.id} record={record} onSave={onUpdateNote} onHighlight={onHighlightNote} onRemoveHighlight={onRemoveNoteHighlight} />
                    <small>{record.outlinePath.map((item) => item.title).join(" › ")}</small>
                  </article>
                ))}
              </div>
            </section>
          )}

          {view === "library" && (
            <section className="annotation-review-library" aria-label="复习库">
              <header><div><strong>复习库 {selectedLibraryLevel}</strong><span>{selectedLibraryRecords.length} 个独立词条</span></div><button type="button" disabled={!selectedLibraryRecords.length} onClick={() => startQuickReview("library", { libraryLevel: selectedLibraryLevel })}>开始复习</button></header>
              <nav className="annotation-review-levels" aria-label="选择复习库层级">
                {([1, 2, 3] as const).map((level) => <button type="button" className={selectedLibraryLevel === level ? "is-active" : ""} onClick={() => setSelectedLibraryLevel(level)} key={level}><span>复习库 {level}</span><strong>{reviewRecordsByLevel[level].length}</strong></button>)}
              </nav>
              {!selectedLibraryRecords.length && <p className="annotation-calendar-no-records">{selectedLibraryLevel === 1 ? "快速复习时按 1，或点击“加入复习库”" : `在复习库 ${selectedLibraryLevel - 1} 复习时按 1 加入`}</p>}
              {selectedLibraryRecords.map((record) => (
                <article className="annotation-review-library-card" key={record.id}>
                  <div><button type="button" onClick={() => visitRecord(record, true)}><strong>{record.entryText}</strong><span>第 {record.page} 页 ›</span></button><button type="button" className="annotation-review-remove" onClick={() => onRemoveFromReview(record, selectedLibraryLevel)}>移出</button></div>
                  <InlineNoteEditor key={record.id} record={record} onSave={onUpdateNote} onHighlight={onHighlightNote} onRemoveHighlight={onRemoveNoteHighlight} />
                  <small>{record.outlinePath.map((item) => item.title).join(" › ")}</small>
                </article>
              ))}
            </section>
          )}

          {view === "quick" && (
            <section className="annotation-quick-review" aria-live="polite">
              {currentQuickRecord ? <>
                <header><div className="annotation-quick-progress"><span>{safeQuickIndex + 1} / {quickRecords.length}</span><form onSubmit={(event) => { event.preventDefault(); submitQuickJump(); }}><label>快速跳到第<input aria-label="快速跳到第几条" inputMode="numeric" pattern="[0-9]*" value={quickJumpDraft} onChange={(event) => setQuickJumpDraft(event.target.value.replace(/\D/g, ""))} onFocus={(event) => event.currentTarget.select()} onBlur={submitQuickJump} />条</label></form></div><div className="annotation-quick-membership"><small>{quickScope === "library" ? `复习库 ${quickLibraryLevel}` : quickScope === "chapter" ? "当前章节" : quickScope === "sprint" ? `冲刺第 ${selectedSprintDay} 天` : "全部批注"}</small>{targetLibraryLevel ? <button type="button" className={targetReviewRecordIds.has(currentQuickRecord.id) ? "is-added" : ""} onClick={() => onAddToReview(currentQuickRecord, targetLibraryLevel)} disabled={targetReviewRecordIds.has(currentQuickRecord.id)}><kbd>1</kbd>{targetReviewRecordIds.has(currentQuickRecord.id) ? `已加入复习库 ${targetLibraryLevel}` : `加入复习库 ${targetLibraryLevel}`}</button> : <button type="button" className="is-added" disabled><kbd>1</kbd>已到复习库 3</button>}</div></header>
                <div className="annotation-quick-source"><strong><HighlightedEntryText text={currentQuickRecord.entryText} ranges={currentQuickRecord.entryTextHighlights} entryId={currentQuickRecord.entryId} versionId={currentQuickRecord.versionId} /></strong><button type="button" onClick={() => visitRecord(currentQuickRecord, true)}>第 {currentQuickRecord.page} 页 ›</button></div>
                <div className="annotation-quick-note"><InlineNoteEditor key={currentQuickRecord.id} record={currentQuickRecord} onSave={onUpdateNote} onHighlight={onHighlightNote} onRemoveHighlight={onRemoveNoteHighlight} /></div>
                <footer><button type="button" disabled={safeQuickIndex === 0} onClick={() => goToQuickIndex(safeQuickIndex - 1)}><kbd>A</kbd> 上一条</button><button type="button" disabled={safeQuickIndex >= quickRecords.length - 1} onClick={() => goToQuickIndex(safeQuickIndex + 1)}>下一条 <kbd>S</kbd></button></footer>
              </> : <p className="annotation-calendar-no-records">当前范围没有批注</p>}
            </section>
          )}
        </div>
        {(reviewBookmark || (view === "quick" && currentQuickRecord)) && (
          <aside className="annotation-review-bookmark-dock" aria-label="复习书签">
            {bookmarkFeedback && <span role="status">{bookmarkFeedback}</span>}
            {reviewBookmark && !(view === "quick" && isCurrentQuickRecordBookmarked) && (
              <button type="button" className="is-return" onClick={returnToReviewBookmark}>↩ 回到标记</button>
            )}
            {view === "quick" && currentQuickRecord && (
              <button type="button" className={isCurrentQuickRecordBookmarked ? "is-marked" : ""} onClick={markCurrentReviewPosition} disabled={isCurrentQuickRecordBookmarked}>
                {isCurrentQuickRecordBookmarked ? "✓ 已标记此处" : "⌑ 标记当前位置"}
              </button>
            )}
          </aside>
        )}
        {!miniMode && showReturnToTop && <button type="button" className="annotation-history-return-top" aria-label="回到历史记录顶部" onClick={() => contentRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>↑</button>}
      </section>
    </div>,
    document.body,
  );
}
