"use client";

import { useEffect } from "react";

// A phone's on-screen keyboard, open: marked on the page as
// <html data-keyboard="open"> (build 24), so the table's stylesheet can give
// the box being typed in the room the keyboard took. With the keyboard up a
// phone shows a few hundred pixels of page; the bottom tab bar, the hand's
// fan and the strips above the message box used to squeeze the box until
// its own text and Send slid under the tab bar.
//
// There is no event for the keyboard itself, so it is read the way a person
// would: a box to type in has the focus on a touch screen, and the view is
// well short of the tallest it has been at this width (the app's WebView and
// the browser alike shrink the page for the keyboard: adjustResize in the
// app, interactive-widget=resizes-content in layout.tsx). A turn of the phone
// changes the width and starts the measure again.
const SHORTER_BY = 120;

function typingBox(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }
  if (element instanceof HTMLInputElement) {
    return (
      !element.disabled &&
      !element.readOnly &&
      !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(element.type)
    );
  }
  return false;
}

export function useKeyboardOpen(): void {
  useEffect(() => {
    const root = document.documentElement;
    const touch = navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches;
    if (!touch) {
      return;
    }
    let width = 0;
    let tallest = 0;
    let timer = 0;
    const update = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        tallest = height;
      }
      tallest = Math.max(tallest, height);
      const open = typingBox(document.activeElement) && tallest - height > SHORTER_BY;
      if (open) {
        root.dataset.keyboard = "open";
      } else {
        delete root.dataset.keyboard;
      }
    };
    // Focus moves before the keyboard has finished opening or closing; a
    // second look a moment later catches the height it settles at.
    const soon = () => {
      update();
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 350);
    };
    update();
    window.addEventListener("resize", soon);
    window.visualViewport?.addEventListener("resize", soon);
    document.addEventListener("focusin", soon);
    document.addEventListener("focusout", soon);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", soon);
      window.visualViewport?.removeEventListener("resize", soon);
      document.removeEventListener("focusin", soon);
      document.removeEventListener("focusout", soon);
      delete root.dataset.keyboard;
    };
  }, []);
}
