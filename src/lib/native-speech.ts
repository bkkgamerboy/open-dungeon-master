"use client";

import { useSyncExternalStore } from "react";
import { phoneRateFrom, pickNarrationEngine, type NarrationEngine } from "@/lib/phone-voice";
import { useCapabilities } from "@/lib/use-capabilities";

// A device's own text-to-speech, offered by an app shell. The Android app
// installs one at window.odmSpeech (the phone's TextToSpeech engine), so a
// table can hear its passages read aloud with no speech server at all, and
// a player can choose the phone's voice over a paid one. The browser never
// has one. The contract lives here; the shell's half is the client's
// mobile/src/speech-core.ts.

export type NativeSpeechVoice = {
  // The engine's own name for it ("en-us-x-iob-local").
  id: string;
  // Readable: "English (United States), iob".
  name: string;
  // BCP-47.
  language: string;
  // Works without the internet.
  local: boolean;
};

export type NativeSpeakOptions = {
  // A NativeSpeechVoice id; the engine's default when absent or not there.
  voice?: string;
  // 1 is the engine's normal speed and pitch.
  rate?: number;
  pitch?: number;
  // 0 to 1, against the media volume.
  volume?: number;
};

export type NativeSpeech = {
  // Resolves "done" once the last word is spoken, "stopped" when stop() or
  // a newer speak() cut it short; rejects with a sentence to show when the
  // engine fails. Long text is the shell's to split.
  speak(text: string, options?: NativeSpeakOptions): Promise<"done" | "stopped">;
  stop(): Promise<void>;
  voices(): Promise<NativeSpeechVoice[]>;
};

declare global {
  interface Window {
    odmSpeech?: NativeSpeech;
  }
}

// Fired on window when a shell installs (or replaces) window.odmSpeech,
// which it may do after the page has drawn: the engine starts in native
// code and answers asynchronously.
export const NATIVE_SPEECH_EVENT = "odm-speech";

export function subscribeNativeSpeech(listener: () => void): () => void {
  window.addEventListener(NATIVE_SPEECH_EVENT, listener);
  return () => window.removeEventListener(NATIVE_SPEECH_EVENT, listener);
}

export function nativeSpeech(): NativeSpeech | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = window.odmSpeech;
  return bridge && typeof bridge.speak === "function" ? bridge : null;
}

function hasNativeSpeech(): boolean {
  return nativeSpeech() !== null;
}

function noNativeOnServer(): boolean {
  return false;
}

// Whether this device can read aloud by itself. False on the server render,
// so markup never mismatches; a shell that installs a voice later says so
// with NATIVE_SPEECH_EVENT.
export function useHasNativeSpeech(): boolean {
  return useSyncExternalStore(subscribeNativeSpeech, hasNativeSpeech, noNativeOnServer);
}

// The phone's voice settings. Per device, like the microphone (they name
// this device's voices and suit its speaker), so they are not synced to the
// account the way the narration volume is.
const ALWAYS_KEY = "odm_phone_voice_always";
const VOICE_KEY = "odm_phone_voice_id";
const RATE_KEY = "odm_phone_voice_rate";
export const PHONE_VOICE_EVENT = "odm-phone-voice-prefs";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing and similar: the change still reaches this page.
  }
  window.dispatchEvent(new Event(PHONE_VOICE_EVENT));
}

function subscribePrefs(listener: () => void): () => void {
  window.addEventListener(PHONE_VOICE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(PHONE_VOICE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function readPhoneVoiceAlways(): boolean {
  return read(ALWAYS_KEY) === "1";
}

export function readPhoneVoiceId(): string {
  return read(VOICE_KEY) ?? "";
}

export function readPhoneVoiceRate(): number {
  return phoneRateFrom(read(RATE_KEY));
}

export function writePhoneVoiceAlways(on: boolean) {
  write(ALWAYS_KEY, on ? "1" : "0");
}

export function writePhoneVoiceId(id: string) {
  write(VOICE_KEY, id);
}

export function writePhoneVoiceRate(rate: number) {
  write(RATE_KEY, String(phoneRateFrom(String(rate))));
}

export function usePhoneVoiceAlways(): boolean {
  return useSyncExternalStore(subscribePrefs, readPhoneVoiceAlways, () => false);
}

export function usePhoneVoiceId(): string {
  return useSyncExternalStore(subscribePrefs, readPhoneVoiceId, () => "");
}

export function usePhoneVoiceRate(): number {
  return useSyncExternalStore(subscribePrefs, readPhoneVoiceRate, () => 1);
}

// What a passage is read with, at the moment it is read: a voice or speed
// changed mid-session is heard from the next passage on.
export function phoneSpeakOptions(volume: number): NativeSpeakOptions {
  const voice = readPhoneVoiceId();
  return { ...(voice ? { voice } : {}), rate: readPhoneVoiceRate(), volume };
}

// Which voice reads this table's passages on this device (src/lib/phone-voice.ts).
export function useNarrationEngine(): NarrationEngine {
  const capabilities = useCapabilities();
  const phone = useHasNativeSpeech();
  const always = usePhoneVoiceAlways();
  return pickNarrationEngine({ phone, always, server: capabilities?.tts });
}
