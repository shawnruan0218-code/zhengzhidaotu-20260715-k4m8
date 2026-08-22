import assert from "node:assert/strict";
import test from "node:test";
import { removeNoteHighlightSelection } from "../app/lib/note-highlights.ts";

test("removes only the selected part of an existing note highlight", () => {
  const text = "世界是运动变化的，也具有相对稳定的一面";
  const result = removeNoteHighlightSelection(
    text,
    [{ start: 3, end: 11, quote: text.slice(3, 11) }],
    { start: 6, end: 8 },
  );
  assert.equal(result.changed, true);
  assert.deepEqual(result.ranges, [
    { start: 3, end: 6, quote: text.slice(3, 6) },
    { start: 8, end: 11, quote: text.slice(8, 11) },
  ]);
});

test("does not change unrelated note highlights", () => {
  const text = "abcdef";
  const ranges = [{ start: 0, end: 2, quote: "ab" }];
  const result = removeNoteHighlightSelection(text, ranges, { start: 3, end: 5 });
  assert.equal(result.changed, false);
  assert.deepEqual(result.ranges, ranges);
});
