"use client";

import { useEffect, useRef } from "react";
import { useNarrationAudio } from "@/app/campaigns/[campaignId]/useNarrationAudio";
import { useAmbienceAudio } from "@/app/campaigns/[campaignId]/useAmbienceAudio";
import type { CampaignState } from "@/app/campaigns/[campaignId]/useCampaignStream";
import { useNarrationEngine } from "@/lib/native-speech";
import { passageKey } from "@/lib/phone-voice";
import { stripForSpeech } from "@/lib/speech-text";

// The table's two audio channels and how they meet. Narration is the DM's
// voice; ambience is the room. The room drops behind the voice while a
// passage is being read and comes back when it stops. Nothing else in the
// app knows how to do this, which is why the two hooks are joined here
// rather than inside either one.
//
// The DM's voice is the server's audio, or, on a device with a voice of its
// own, that voice reading the passage (src/lib/phone-voice.ts decides which;
// `engine` says). Never both: with the device's voice the server's audio is
// left unplayed.
export function useTableAudio(state: CampaignState) {
  const narration = useNarrationAudio();
  const engine = useNarrationEngine();
  const ambience = useAmbienceAudio(
    state.ambience,
    state.ambienceSting,
    Boolean(state.campaign?.gameSettings?.ambienceEnabled),
  );
  const duckAmbience = ambience.setDucked;
  useEffect(() => {
    duckAmbience(Boolean(narration.playingMessageId));
  }, [duckAmbience, narration.playingMessageId]);

  // Only tts_ready events newer than the seq present when the snapshot first
  // loaded autoplay; the backlog stays silent (replay buttons cover history).
  // Each narration is handed over exactly once: unrelated events (new chat
  // messages) must never re-trigger and restart playback.
  const mountSeqRef = useRef<number | null>(null);
  const handedTtsRef = useRef<string | null>(null);
  const handedPassageRef = useRef<string | null>(null);
  const { latestTts, latestPassage, messages, loading, lastSeq } = state;
  const { onTtsReady, onPassage } = narration;
  const ttsEnabled = Boolean(state.campaign?.gameSettings?.ttsEnabled);
  useEffect(() => {
    if (mountSeqRef.current === null) {
      if (!loading) {
        mountSeqRef.current = lastSeq;
      }
      return;
    }
    if (latestTts && latestTts.messageId !== handedTtsRef.current) {
      handedTtsRef.current = latestTts.messageId;
      if (engine === "phone") {
        return;
      }
      // A stream is only ever offered live; a finished file is live when it
      // is newer than the snapshot.
      onTtsReady(latestTts.messageId, latestTts.url, Boolean(latestTts.live) || latestTts.seq > mountSeqRef.current);
    }
  }, [latestTts, onTtsReady, loading, lastSeq, engine]);

  // The device's own voice reads each new passage, or new prose for one,
  // once, as the server would have narrated it: only with the table's
  // narration on, and never the backlog from before the table opened.
  useEffect(() => {
    const mountSeq = mountSeqRef.current;
    if (mountSeq === null || !latestPassage) {
      return;
    }
    const key = passageKey(latestPassage.messageId, latestPassage.seq);
    if (key === handedPassageRef.current) {
      return;
    }
    handedPassageRef.current = key;
    if (engine !== "phone" || !ttsEnabled || latestPassage.seq <= mountSeq) {
      return;
    }
    const message = messages.find((entry) => entry.id === latestPassage.messageId);
    if (message) {
      onPassage(message.id, stripForSpeech(message.content));
    }
  }, [latestPassage, messages, onPassage, engine, ttsEnabled]);

  return { narration, ambience, engine };
}
