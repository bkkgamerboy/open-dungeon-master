"use client";

// The Android client installs this bridge only on a device-hosted game.
// No API keys, audio uploads or network requests are involved in speaking.
export type NativeNarration = {
  speak(text: string): void;
  stop(): void;
};

declare global {
  interface Window {
    odmNarration?: NativeNarration;
  }
}

export function nativeNarration(): NativeNarration | null {
  if (typeof window === "undefined") return null;
  const bridge = window.odmNarration;
  return bridge && typeof bridge.speak === "function" ? bridge : null;
}
