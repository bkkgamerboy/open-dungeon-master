// Which voice reads the table's passages on this device, decided without a
// DOM so scripts/test-phone-voice.mjs can drive it. The hooks that feed it
// live in src/lib/native-speech.ts.
//
//   server  the server renders each passage to audio (Kokoro, OpenAI or a
//           compatible service) and every seat plays the same file.
//   phone   this device reads the passage's text with its own voice (the
//           Android app's text-to-speech engine): free, instant, offline,
//           and nothing to download.
//
// The phone's voice is used where the server cannot narrate (narration
// switched off in Admin > Speech, which is how the world a phone hosts
// starts, or a speech service with no model picked) and, when the player
// asks for it, everywhere. A device without a voice of its own always
// follows the server.

export type NarrationEngine = "server" | "phone";

export function pickNarrationEngine(input: {
  // This device offers a voice (window.odmSpeech).
  phone: boolean;
  // The player chose the phone's voice even where the server narrates.
  always: boolean;
  // What the server says about its narration (/api/capabilities' tts);
  // null until it answers. provider is missing from servers older than
  // 0.24.5, which say configured: false when they have no narration.
  server: { provider?: string; configured?: boolean } | null | undefined;
}): NarrationEngine {
  if (!input.phone) {
    return "server";
  }
  if (input.always) {
    return "phone";
  }
  return serverCannotNarrate(input.server) ? "phone" : "server";
}

export function serverCannotNarrate(server: { provider?: string; configured?: boolean } | null | undefined): boolean {
  if (!server) {
    return false;
  }
  return server.provider === "off" || server.configured === false;
}

export const PHONE_RATE_MIN = 0.5;
export const PHONE_RATE_MAX = 2;
export const PHONE_RATE_DEFAULT = 1;

// A saved speed, read defensively: anything unreadable is normal speed.
export function phoneRateFrom(stored: string | null): number {
  if (stored === null || stored.trim() === "") {
    return PHONE_RATE_DEFAULT;
  }
  const value = Number(stored);
  if (!Number.isFinite(value)) {
    return PHONE_RATE_DEFAULT;
  }
  return Math.min(PHONE_RATE_MAX, Math.max(PHONE_RATE_MIN, value));
}

// A passage is handed to the phone's voice once per take: a reroll or a
// continued scene changes its text, and that new text is a new take, as
// it is for the server's narration.
export function passageKey(messageId: string, seq: number): string {
  return `${messageId}@${seq}`;
}
