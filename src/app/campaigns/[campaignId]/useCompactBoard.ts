"use client";

import { useSyncExternalStore } from "react";

// A phone held upright: the battle board gets its own layout there (the
// compact board in BattleMapPanel.tsx). The board fills the screen, close
// up on whoever's turn it is; the turn order and what you have left sit in
// two slim rows above it instead of over it; the actions come up in a sheet
// under the board when you tap your figure, not in a wheel across it. A
// phone on its side, a tablet and a computer keep the board as it was.
export const COMPACT_BOARD_QUERY = "(max-width: 640px) and (orientation: portrait)";

function subscribe(callback: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => undefined;
  }
  const query = window.matchMedia(COMPACT_BOARD_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function read(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.(COMPACT_BOARD_QUERY).matches);
}

export function useCompactBoard(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
