import { registerPlugin } from "@capacitor/core";

// Capacitor's native method speaks through the phone's installed TTS engine.
// The game screens use this bridge only when their server narration is off.
const OdmNarration = registerPlugin<{
  speak(options: { text: string }): Promise<void>;
  stop(): Promise<void>;
}>("OdmNarration");

declare global {
  interface Window {
    odmNarration?: {
      speak(text: string): void;
      stop(): void;
    };
  }
}

export function offerNativeNarration(): void {
  window.odmNarration = {
    speak(text: string) {
      if (!text.trim()) return;
      void OdmNarration.speak({ text }).catch((error) => {
        console.warn("[native narration]", error);
      });
    },
    stop() {
      void OdmNarration.stop().catch(() => undefined);
    },
  };
}
