"use client";

type SelectionSnapshot = {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
};

function sameSelection(selection: Selection, snapshot: SelectionSnapshot) {
  return selection.anchorNode === snapshot.anchorNode &&
    selection.anchorOffset === snapshot.anchorOffset &&
    selection.focusNode === snapshot.focusNode &&
    selection.focusOffset === snapshot.focusOffset;
}

/**
 * Keep the native (yellow-styled) selection visible until React has painted the
 * durable highlight. The identity check prevents an older highlight action
 * from clearing a brand-new selection the user has already started.
 */
export function clearSelectionAfterHighlightPaint() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const snapshot: SelectionSnapshot = {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const current = window.getSelection();
        if (current && sameSelection(current, snapshot)) current.removeAllRanges();
      });
    });
  });
}
