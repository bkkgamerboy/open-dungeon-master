"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { registerOutput, releaseOutput } from "@/lib/audio-devices";
import { AUDIO_PREF_FIELDS, hydrateAudioPrefs, writeAudioPref } from "@/lib/audio-prefs";
import { nativeSpeech, phoneSpeakOptions } from "@/lib/native-speech";

// Plays DM narration: the server's audio (tts_ready events) or, on a device
// with a voice of its own, the passage's text read by that voice
// (src/lib/native-speech.ts). Only passages that arrive AFTER mount
// autoplay; reconnect backlog never replays old narration. Narrations
// queue: a new one never interrupts the one playing, it waits its turn
// (manual replay is explicit intent and may interrupt). Mute and volume are
// per-user (localStorage), exposed through useSyncExternalStore so server
// render stays muted and the client snapshot takes over at hydration
// without a setState cascade. The account keeps a copy so another browser
// starts the same way; audio-prefs.ts owns that sync.
//
// Playback that fails is never dropped in silence (issue 88): a browser that
// refuses to autoplay hands the narration back to wait for the next gesture,
// and an audio file that will not load or decode is named in playbackFailure
// so the passage can say so.
//
// A passage only holds the queue while it is really being heard. One the
// device paused on its own (a phone call, another app taking the sound), or
// an element left loaded but paused, would otherwise keep every later
// passage waiting behind it for the rest of the session.

const MUTED_KEY = AUDIO_PREF_FIELDS.narrationMuted.key;
const VOLUME_KEY = AUDIO_PREF_FIELDS.narrationVolume.key;
const PREFS_EVENT = AUDIO_PREF_FIELDS.narrationMuted.event;

function subscribePrefs(callback: () => void) {
  window.addEventListener(PREFS_EVENT, callback);
  return () => window.removeEventListener(PREFS_EVENT, callback);
}

function readMuted() {
  const stored = window.localStorage.getItem(MUTED_KEY);
  return stored === null ? false : stored === "1";
}

export function readVolume() {
  const stored = window.localStorage.getItem(VOLUME_KEY);
  if (stored === null) {
    return 0.8;
  }
  const value = Number(stored);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
}

// One passage to be heard: the server's audio for it, or its words for the
// device's own voice.
type Passage = { messageId: string; url: string; text?: undefined } | { messageId: string; text: string; url?: undefined };

export type NarrationAudio = {
  muted: boolean;
  volume: number;
  unlocked: boolean;
  playingMessageId: string | null;
  // The message whose audio this device last failed to play, if any.
  playbackFailure: string | null;
  setMuted: (muted: boolean) => void;
  setVolume: (volume: number) => void;
  unlock: () => void;
  play: (messageId: string, url: string) => void;
  // Explicit replay with the device's own voice: interrupts, like play.
  say: (messageId: string, text: string) => void;
  audioByMessage: Map<string, string>;
  onTtsReady: (messageId: string, url: string, live: boolean) => void;
  // A new passage for the device's own voice; queues like onTtsReady.
  onPassage: (messageId: string, text: string) => void;
};

export function useNarrationAudio(): NarrationAudio {
  const muted = useSyncExternalStore(subscribePrefs, readMuted, () => true);
  const volume = useSyncExternalStore(subscribePrefs, readVolume, () => 0.8);
  const [unlocked, setUnlocked] = useState(false);
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [playbackFailure, setPlaybackFailure] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioByMessage] = useState(() => new Map<string, string>());
  const unlockedRef = useRef(false);
  const playingRef = useRef<string | null>(null);
  // True while the device's own voice is reading the passage in playingRef.
  const speakingRef = useRef(false);
  // Narrations wait for the current one instead of cutting it off.
  const queueRef = useRef<Passage[]>([]);
  // Every messageId ever started or queued; guards against replays when the
  // same tts_ready re-enters through re-renders or reducer echoes.
  const handledRef = useRef(new Set<string>());
  // Narration that landed before the first user gesture. SessionView hands
  // each message over exactly once, so dropping these would lose them for
  // good; they wait here and play from unlock().
  const pendingRef = useRef<Passage[]>([]);

  // The account copy of the prefs, applied over localStorage unless the
  // user touched a control first.
  useEffect(() => {
    hydrateAudioPrefs();
  }, []);

  // Everything heard or waiting stops: muted, or the table left.
  const silence = useCallback(() => {
    audioRef.current?.pause();
    if (speakingRef.current) {
      speakingRef.current = false;
      void nativeSpeech()?.stop();
    }
    queueRef.current = [];
    pendingRef.current = [];
    playingRef.current = null;
  }, []);

  // Unmount: the one element this hook owns stops and leaves the output
  // router, which otherwise keeps it for the life of the page, and the
  // device's voice stops mid-sentence rather than reading to an empty room.
  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.src = "";
        releaseOutput(audio);
        audioRef.current = null;
      }
      if (speakingRef.current) {
        speakingRef.current = false;
        void nativeSpeech()?.stop();
      }
    };
  }, []);

  const setMuted = useCallback(
    (next: boolean) => {
      writeAudioPref("narrationMuted", next);
      if (next) {
        silence();
        setPlayingMessageId(null);
      }
    },
    [silence],
  );

  // Muted from anywhere else (the Settings switch, another tab, the account
  // copy arriving) stops what is playing too, as the header's button does.
  useEffect(() => {
    if (muted && playingRef.current) {
      silence();
      setPlayingMessageId(null);
    }
  }, [muted, silence]);

  const setVolume = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(1, next));
    writeAudioPref("narrationVolume", clamped);
    if (audioRef.current) {
      audioRef.current.volume = clamped;
    }
  }, []);

  // Whether a passage is really being heard, rather than only marked as
  // playing: the device's voice is reading, or the element is playing or
  // waiting for more of a stream. Paused or ended is not heard.
  const busy = useCallback((): boolean => {
    if (!playingRef.current) {
      return false;
    }
    if (speakingRef.current) {
      return true;
    }
    const audio = audioRef.current;
    return Boolean(audio && !audio.paused && !audio.ended);
  }, []);

  const startPlayback = useCallback((first: Passage) => {
    // Named plain function so playback can chain into the queued narration
    // when the current one ends.
    function run(passage: Passage) {
      const id = passage.messageId;
      const finish = () => {
        if (playingRef.current !== id) {
          return;
        }
        playingRef.current = null;
        speakingRef.current = false;
        setPlayingMessageId(null);
        const next = queueRef.current.shift();
        if (next && !readMuted()) {
          run(next);
        }
      };
      const fail = () => {
        if (playingRef.current === id) {
          setPlaybackFailure(id);
        }
        finish();
      };
      playingRef.current = id;
      setPlayingMessageId(id);
      setPlaybackFailure((current) => (current === id ? null : current));

      if (passage.text !== undefined) {
        // The device's own voice. Whatever the element held stops first.
        audioRef.current?.pause();
        const speech = nativeSpeech();
        if (!speech) {
          fail();
          return;
        }
        speakingRef.current = true;
        speech.speak(passage.text, phoneSpeakOptions(readVolume())).then(
          // Done, or stopped: by a newer passage (which already moved
          // playingRef on, so finish does nothing), by mute (likewise), or
          // by the device itself, in which case the queue moves on.
          () => {
            if (playingRef.current === id) {
              speakingRef.current = false;
            }
            finish();
          },
          () => {
            if (playingRef.current === id) {
              speakingRef.current = false;
            }
            fail();
          },
        );
        return;
      }

      if (speakingRef.current) {
        speakingRef.current = false;
        void nativeSpeech()?.stop();
      }
      if (!audioRef.current) {
        audioRef.current = registerOutput(new Audio());
      }
      const audio = audioRef.current;
      audio.onended = finish;
      audio.onerror = fail;
      const src = passage.url;
      audio.src = src;
      audio.volume = readVolume();
      audio.play().catch((error: unknown) => {
        if (playingRef.current !== id) {
          return;
        }
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          // The browser wants a gesture first (a tab that was never
          // touched, or one that sat idle). This narration is offered only
          // once, so it goes back to wait, along with whatever queued
          // behind it, and the header shows the "enable audio" state again.
          pendingRef.current = [{ messageId: id, url: src }, ...queueRef.current, ...pendingRef.current];
          queueRef.current = [];
          playingRef.current = null;
          setPlayingMessageId(null);
          unlockedRef.current = false;
          setUnlocked(false);
          return;
        }
        // A pause() that interrupts a play() rejects with AbortError: that
        // is this hook stopping it, not a failure.
        if (error instanceof DOMException && error.name === "AbortError") {
          finish();
          return;
        }
        fail();
      });
    }
    run(first);
  }, []);

  // A passage that may not cut in: it waits behind one really being heard,
  // and otherwise the oldest waiting passage starts now. A passage marked as
  // playing but not heard (paused by the device, or never started) is let
  // go here rather than left to hold the queue.
  const enqueue = useCallback(
    (passage: Passage) => {
      queueRef.current.push(passage);
      if (busy()) {
        return;
      }
      playingRef.current = null;
      const next = queueRef.current.shift();
      if (next) {
        startPlayback(next);
      }
    },
    [busy, startPlayback],
  );

  // Explicit replay: interrupts whatever is playing and clears the queue.
  const play = useCallback(
    (messageId: string, url: string) => {
      queueRef.current = [];
      startPlayback({ messageId, url });
    },
    [startPlayback],
  );

  const say = useCallback(
    (messageId: string, text: string) => {
      queueRef.current = [];
      startPlayback({ messageId, text });
    },
    [startPlayback],
  );

  // The browser requires a user gesture before audio can play; the header
  // speaker toggle doubles as that gesture.
  const unlock = useCallback(() => {
    setUnlocked(true);
    unlockedRef.current = true;
    // Anything that arrived before this gesture starts now, oldest first,
    // on the same "never interrupt what is playing" rule as live narration.
    const held = pendingRef.current;
    pendingRef.current = [];
    if (!held.length || readMuted()) {
      return;
    }
    for (const passage of held) {
      enqueue(passage);
    }
  }, [enqueue]);

  // Any first interaction with the page (click, key press) also counts as
  // the unlock gesture, so narration autoplays without hunting for the
  // speaker button.
  useEffect(() => {
    if (unlocked) {
      return;
    }
    const handle = () => unlock();
    window.addEventListener("pointerdown", handle, { once: true });
    window.addEventListener("keydown", handle, { once: true });
    return () => {
      window.removeEventListener("pointerdown", handle);
      window.removeEventListener("keydown", handle);
    };
  }, [unlocked, unlock]);

  const onTtsReady = useCallback(
    (messageId: string, url: string, live: boolean) => {
      audioByMessage.set(messageId, url);
      if (!live || readMuted() || handledRef.current.has(messageId)) {
        return;
      }
      handledRef.current.add(messageId);
      // The browser refuses to play before a user gesture, so hold rather
      // than drop: this narration is never offered a second time.
      if (!unlockedRef.current) {
        pendingRef.current.push({ messageId, url });
        return;
      }
      enqueue({ messageId, url });
    },
    [audioByMessage, enqueue],
  );

  // The device's own voice needs no gesture: it is not the page's audio.
  // The caller hands each take over once (useTableAudio), so a passage read
  // again after a reroll is not refused here.
  const onPassage = useCallback(
    (messageId: string, text: string) => {
      if (readMuted() || !text.trim()) {
        return;
      }
      enqueue({ messageId, text });
    },
    [enqueue],
  );

  // One object per real change, so the memoized header and the chat column
  // are not handed a new narration prop on every table render.
  return useMemo(
    () => ({
      muted,
      volume,
      unlocked,
      playingMessageId,
      playbackFailure,
      setMuted,
      setVolume,
      unlock,
      play,
      say,
      audioByMessage,
      onTtsReady,
      onPassage,
    }),
    [muted, volume, unlocked, playingMessageId, playbackFailure, setMuted, setVolume, unlock, play, say, audioByMessage, onTtsReady, onPassage],
  );
}
