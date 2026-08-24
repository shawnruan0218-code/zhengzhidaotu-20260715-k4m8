"use client";

import type { NoteHighlightRange } from "./lib/study-types";
import { resolveNoteHighlightRanges } from "./lib/note-highlights";

type Props = {
  text: string;
  ranges?: NoteHighlightRange[];
  entryId: string;
  versionId: string;
  className?: string;
};

export type SelectedNoteText = {
  entryId: string;
  versionId: string;
  start: number;
  end: number;
  quote: string;
};

let rememberedSelection: {
  value: SelectedNoteText;
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

export function HighlightedNoteText({
  text,
  ranges = [],
  entryId,
  versionId,
  className,
}: Props) {
  const resolved = mergedRanges(text, ranges);
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  resolved.forEach((range, index) => {
    if (range.start > cursor) pieces.push(text.slice(cursor, range.start));
    pieces.push(<mark key={`${range.start}-${range.end}-${index}`}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  });
  if (cursor < text.length) pieces.push(text.slice(cursor));

  return (
    <span
      className={["note-highlight-text", className].filter(Boolean).join(" ")}
      data-note-highlight-root="true"
      data-note-entry-id={entryId}
      data-note-version-id={versionId}
      onPointerDown={() => {
        rememberedSelection = null;
      }}
      onPointerUp={() => {
        requestAnimationFrame(() => rememberSelectedNoteText());
      }}
    >
      {pieces.length ? pieces : text}
    </span>
  );
}

function readLiveSelectedNoteText(): (SelectedNoteText & { root: HTMLElement }) | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const startElement =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const endElement =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement;
  const root = startElement?.closest<HTMLElement>("[data-note-highlight-root='true']");
  if (!root || !endElement || !root.contains(endElement)) return null;

  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const quote = range.toString();
  if (!quote.trim()) return null;

  const entryId = root.dataset.noteEntryId;
  const versionId = root.dataset.noteVersionId;
  if (!entryId || !versionId) return null;
  return { entryId, versionId, start, end: start + quote.length, quote, root };
}

export function rememberSelectedNoteText(): SelectedNoteText | null {
  const live = readLiveSelectedNoteText();
  if (!live) return null;
  const { root, ...value } = live;
  rememberedSelection = { value, root, capturedAt: Date.now() };
  return value;
}

export function clearRememberedNoteText(): void {
  rememberedSelection = null;
}

export function readSelectedNoteText(): SelectedNoteText | null {
  const live = rememberSelectedNoteText();
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
