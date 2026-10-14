// Where a chat model reads the game state's turn-to-turn part (the fight,
// recent rolls, retrieved lore: src/lib/prompt-boundary.ts
// THIS_MOMENT_HEADING), decided without a request so
// scripts/test-harness-logic.mjs can drive it.
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
//   before-newest  after the transcript up to the last narration, before
//                  the players' lines since it. The transcript up to the
//                  previous turn's moment is the prompt's unchanged start,
//                  so it is reused, and the newest player line is still the
//                  last thing the model reads, as with "system".
//
// A paid public API (OpenAI, OpenRouter: a key sent to a public host, the
// same test as the paid-AI policy, src/lib/model-client.ts
// customBackendIsPaid) bills every token it re-reads uncached, so it reads
// before-newest. A model on this machine or the LAN keeps "system", which
// is what its scripted runs were tuned on. An agent program renders the
// turn itself (src/lib/harness/render.ts) and is left alone. The
// environment overrides for an operator who has measured otherwise.

export type MomentPlacement = "system" | "after-history" | "before-newest";

const PLACEMENTS: readonly MomentPlacement[] = ["system", "after-history", "before-newest"];

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
  return input.provider === "custom" && input.paid ? "before-newest" : "system";
}
