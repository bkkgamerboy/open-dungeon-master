// When Enter sends a message box (src/lib/enter-sends.ts): on a touch screen
// only the send button sends and Enter starts a new line; with a keyboard,
// Enter sends and Shift+Enter starts a new line; Ctrl or Cmd+Enter sends on
// either; and an Enter that commits an input method's word never sends.
import assert from "node:assert/strict";
import { enterSends, touchScreen } from "../src/lib/enter-sends.ts";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

const press = (key, mods = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });
const PHONE = true;
const COMPUTER = false;

test("on a phone, Enter and Shift+Enter start a new line", () => {
  assert.equal(enterSends(press("Enter"), PHONE), false);
  assert.equal(enterSends(press("Enter", { shiftKey: true }), PHONE), false);
});

test("on a computer, Enter sends and Shift+Enter starts a new line", () => {
  assert.equal(enterSends(press("Enter"), COMPUTER), true);
  assert.equal(enterSends(press("Enter", { shiftKey: true }), COMPUTER), false);
});

test("Ctrl or Cmd+Enter sends on either", () => {
  for (const touch of [PHONE, COMPUTER]) {
    assert.equal(enterSends(press("Enter", { ctrlKey: true }), touch), true);
    assert.equal(enterSends(press("Enter", { metaKey: true }), touch), true);
  }
});

test("an input method's Enter never sends", () => {
  for (const touch of [PHONE, COMPUTER]) {
    assert.equal(enterSends(press("Enter", { isComposing: true }), touch), false);
    assert.equal(enterSends(press("Enter", { nativeEvent: { isComposing: true } }), touch), false);
    assert.equal(enterSends(press("Enter", { ctrlKey: true, nativeEvent: { isComposing: true } }), touch), false);
  }
});

test("other keys never send", () => {
  for (const key of ["a", " ", "Tab", "Escape", "Unidentified"]) {
    assert.equal(enterSends(press(key), COMPUTER), false);
    assert.equal(enterSends(press(key, { ctrlKey: true }), PHONE), false);
  }
});

test("with no window (the server), it is not a touch screen", () => {
  assert.equal(touchScreen(), false);
  assert.equal(enterSends(press("Enter")), true);
});

test("a coarse main pointer is a touch screen", () => {
  const saved = globalThis.window;
  try {
    globalThis.window = { matchMedia: (query) => ({ matches: query === "(pointer: coarse)" }) };
    assert.equal(touchScreen(), true);
    assert.equal(enterSends(press("Enter")), false);
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    assert.equal(touchScreen(), false);
    assert.equal(enterSends(press("Enter")), true);
  } finally {
    globalThis.window = saved;
  }
});

console.log(`enter-sends: ${passed} passed`);
