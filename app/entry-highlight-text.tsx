"use client";

import type { NoteHighlightRange } from "./lib/study-types";
import { resolveNoteHighlightRanges } from "./lib/note-highlights";
import { clearSelectionAfterHighlightPaint } from "./lib/selection-feedback";

type Props = {
  text: string;
  ranges?: NoteHighlightRange[];
  entryId: string;
  versionId: string;
};

export type SelectedEntryText = {
  entryId: string;
  versionId: string;
  text: string;
  start: number;
  end: number;
  quote: string;
};

let rememberedSelection: {
  value: SelectedEntryText;
  capturedAt: number;
  root: HTMLElement;
} | null = null;

function mergedRanges(text: string, ranges: NoteHighlightRange[]) {
  return resolveNoteHighlightRanges(text, ranges)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .reduce<Array<{ start: number; end: number }>>((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push({ ...range });
      }
      return merged;
    }, []);
}

export function HighlightedEntryText({ text, ranges = [], entryId, versionId }: Props) {
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  mergedRanges(text, ranges).forEach((range, index) => {
    if (range.start > cursor) pieces.push(text.slice(cursor, range.start));
    pieces.push(<mark key={`${range.start}-${range.end}-${index}`}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  });
  if (cursor < text.length) pieces.push(text.slice(cursor));

  return (
    <span
      className="entry-highlight-text"
      data-entry-highlight-root="true"
      data-entry-id={entryId}
      data-entry-version-id={versionId}
      onPointerDown={() => {
        rememberedSelection = null;
      }}
      onPointerUp={() => {
        if (!rememberSelectedEntryText()) queueMicrotask(() => rememberSelectedEntryText());
      }}
    >
      {pieces.length ? pieces : text}
    </span>
  );
}

function readLiveSelectedEntryText(): (SelectedEntryText & { root: HTMLElement }) | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
    ? range.endContainer as Element
    : range.endContainer.parentElement;
  const root = startElement?.closest<HTMLElement>("[data-entry-highlight-root='true']");
  if (!root || !endElement || !root.contains(endElement)) return null;

  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const quote = range.toString();
  if (!quote.trim()) return null;

  const entryId = root.dataset.entryId;
  const versionId = root.dataset.entryVersionId;
  if (!entryId || !versionId) return null;
  return { entryId, versionId, text: root.textContent ?? "", start, end: start + quote.length, quote, root };
}

export function rememberSelectedEntryText(): SelectedEntryText | null {
  const live = readLiveSelectedEntryText();
  if (!live) return null;
  const { root, ...value } = live;
  rememberedSelection = { value, root, capturedAt: Date.now() };
  return value;
}

export function clearRememberedEntryText(): void {
  rememberedSelection = null;
}

export function clearRememberedEntryTextAfterPaint(): void {
  rememberedSelection = null;
  clearSelectionAfterHighlightPaint();
}

export function readSelectedEntryText(): SelectedEntryText | null {
  const live = rememberSelectedEntryText();
  if (live) return live;
  if (
    rememberedSelection &&
    rememberedSelection.root.isConnected &&
    Date.now() - rememberedSelection.capturedAt <= 5_000
  ) {
    return rememberedSelection.value;
  }
  rememberedSelection = null;
  return null;
}
