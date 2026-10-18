// Whether a key press in one of the table's message boxes sends it.
//
// On a touch screen (the phone), Enter starts a new line and only the send
// button sends. The on-screen keyboard's Enter sits among the letters, so a
// reflexive press sent a move half written, and there was no way to write a
// second line at all. With a keyboard (a computer), Enter sends as before and
// Shift+Enter starts a new line. Ctrl+Enter or Cmd+Enter sends anywhere, for a
// keyboard plugged into the phone.
//
// An Enter that commits a word in an input method (Thai, Chinese, Japanese,
// a phone keyboard's suggestion) never sends.
//
// Pure apart from touchScreen(), and free of alias imports, so
// scripts/test-enter-sends.mjs reads it directly.

export type EnterPress = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  // React's synthetic event keeps the browser's isComposing here.
  nativeEvent?: { isComposing?: boolean };
};

// A touch screen is the device's main pointer: a phone or tablet, not a
// laptop that also takes a finger.
export function touchScreen(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

export function enterSends(event: EnterPress, touch: boolean = touchScreen()): boolean {
  if (event.key !== "Enter") return false;
  if (event.isComposing || event.nativeEvent?.isComposing) return false;
  if (event.ctrlKey || event.metaKey) return true;
  if (touch) return false;
  return !event.shiftKey;
}
