import assert from "node:assert/strict";
import test from "node:test";
import { shortcutKey } from "../app/lib/keyboard-shortcuts.ts";

test("字母快捷键在中文输入法返回 Process 时仍按物理键识别", () => {
  assert.equal(shortcutKey({ key: "Process", code: "KeyD" }), "d");
  assert.equal(shortcutKey({ key: "Process", code: "KeyQ" }), "q");
  assert.equal(shortcutKey({ key: "Process", code: "KeyE" }), "e");
});

test("数字和普通键保持原有含义", () => {
  assert.equal(shortcutKey({ key: "!", code: "Digit1" }), "1");
  assert.equal(shortcutKey({ key: "Escape", code: "Escape" }), "escape");
});
