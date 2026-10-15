// Where a chat model reads the game state (src/lib/dm/prompt.ts
// buildGameStateBlock), or its turn-to-turn part (the fight, recent rolls,
// retrieved lore: src/lib/prompt-boundary.ts THIS_MOMENT_HEADING), decided
// without a request so scripts/test-harness-logic.mjs can drive it.
//
//   system         at the end of the system message, before the transcript.
//                  The newest player line is the last thing the model
//                  reads. But the part changes every turn, so a provider
//                  that caches the prompt's start can reuse only the rules:
//                  the whole transcript is sent, and on OpenAI's GPT-5.6
//                  and later written to its cache at 1.25x the input price,
//                  again on every turn.
//   after-history  after the whole transcript, closed by MOMENT_INSTRUCTION
//                  (DM_MOMENT_AFTER_HISTORY=1). The transcript is reused,
//                  but the newest player line is no longer the last thing
//                  read, and the default local model then skipped rolls it
//                  should have asked for (src/lib/dm/turn.ts).
//   before-newest  the moment after the transcript up to the last
//                  narration, before the players' lines since it. The
//                  newest player line is still the last thing the model
//                  reads, as with "system". But the standing state stays in
//                  the system message, and in play it changes on most turns
//                  too (the arc's planned events re-picked by the newest
//                  line, the scene line, hit points, the clock), so the
//                  transcript after it was still written again on most
//                  turns: 4.4M of an evening's 15.9M input tokens on
//                  GPT-6 Luna.
//   state-before-newest
//                  the whole game state, standing part and moment, where
//                  before-newest puts the moment. The system message is the
//                  rules alone, which change only with the settings, a fight
//                  starting or ending, or a whisper waiting; the transcript
//                  to the last narration follows it unchanged from one turn
//                  to the next, and the transcript is cut from the front in
//                  steps, not a message at a time (src/lib/dm/context-budget.ts
//                  fitHistory). Each turn writes the game state and the lines
//                  since the last turn, not the whole transcript.
//
// A paid public API (OpenAI, OpenRouter: a key sent to a public host, the
// same test as the paid-AI policy, src/lib/model-client.ts
// customBackendIsPaid) bills every token it re-reads uncached, so it reads
// state-before-newest. A model on this machine or the LAN keeps "system",
// which is what its scripted runs were tuned on. An agent program renders
// the turn itself (src/lib/harness/render.ts) and is left alone. The
// environment overrides for an operator who has measured otherwise.

export type MomentPlacement = "system" | "after-history" | "before-newest" | "state-before-newest";

const PLACEMENTS: readonly MomentPlacement[] = ["system", "after-history", "before-newest", "state-before-newest"];

export function pickMomentPlacement(input: {
  // StorySettings.textProvider.
  provider: string;
  // The story backend sends a key to a public host (customBackendIsPaid).
  paid: boolean;
  env?: { DM_MOMENT_PLACEMENT?: string; DM_MOMENT_AFTER_HISTORY?: string };
}): MomentPlacement {
  if (input.provider === "harness") {
    return "system";
  }
  const forced = (input.env?.DM_MOMENT_PLACEMENT ?? "").trim().toLowerCase();
  if ((PLACEMENTS as readonly string[]).includes(forced)) {
    return forced as MomentPlacement;
  }
  if (input.env?.DM_MOMENT_AFTER_HISTORY === "1") {
    return "after-history";
  }
  return input.provider === "custom" && input.paid ? "state-before-newest" : "system";
}
