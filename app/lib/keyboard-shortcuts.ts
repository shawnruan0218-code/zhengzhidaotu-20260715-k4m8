type KeyboardShortcutEvent = Pick<KeyboardEvent, "code" | "key">;

export function shortcutKey(event: KeyboardShortcutEvent): string {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  return event.key.toLowerCase();
}
