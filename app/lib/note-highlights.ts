import type { NoteHighlightRange } from "./study-types";

export function resolveNoteHighlightRanges(text: string, ranges: NoteHighlightRange[]) {
  return ranges.flatMap((range) => {
    let start = Math.max(0, Math.min(text.length, Math.floor(range.start)));
    let end = Math.max(start, Math.min(text.length, Math.floor(range.end)));
    if (range.quote && text.slice(start, end) !== range.quote) {
      const relocated = text.indexOf(range.quote);
      if (relocated >= 0) {
        start = relocated;
        end = relocated + range.quote.length;
      }
    }
    return end > start ? [{ start, end, quote: text.slice(start, end) }] : [];
  });
}

export function removeNoteHighlightSelection(
  text: string,
  ranges: NoteHighlightRange[],
  selection: { start: number; end: number },
) {
  const selectionStart = Math.max(0, Math.min(text.length, selection.start));
  const selectionEnd = Math.max(selectionStart, Math.min(text.length, selection.end));
  let changed = false;

  const nextRanges = resolveNoteHighlightRanges(text, ranges).flatMap((range) => {
    if (range.end <= selectionStart || range.start >= selectionEnd) return [range];
    changed = true;
    const fragments: NoteHighlightRange[] = [];
    if (range.start < selectionStart) {
      fragments.push({
        start: range.start,
        end: selectionStart,
        quote: text.slice(range.start, selectionStart),
      });
    }
    if (range.end > selectionEnd) {
      fragments.push({
        start: selectionEnd,
        end: range.end,
        quote: text.slice(selectionEnd, range.end),
      });
    }
    return fragments;
  });

  return { changed, ranges: nextRanges };
}
