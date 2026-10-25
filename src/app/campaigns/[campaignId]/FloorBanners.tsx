"use client";

import { SessionBanner, bannerButtonClass } from "@/app/campaigns/[campaignId]/SessionBanner";
import type { Floor } from "@/lib/db/campaigns";
import type { PublicEncounter } from "@/lib/db/encounter-view";

// The held-responses banners above the composer, with the lead's release
// button. A fight has no banner here (build 24): the round's red banner took
// a line of the screen for what the board and the hand already show; End is
// beside the hand's pips, and the lead's Skip turn is a card in the hand on
// others' turns (and stays in the Lead panel).
//
// Nor does a spotlight (build 28). Its card named every hero the DM was
// waiting on and repeated the DM's question, which on a phone took half the
// screen from the story the question was about. The box's own placeholder
// already says whose move it is ("Waiting on ..." when it is not yours);
// the DM asks its question in the narration (turn.ts playerInputResult);
// and the Lead tab's floor card still shows the question and has Open
// floor, so a stuck spotlight is still the lead's to lift.
export function FloorBanners({
  floor,
  heldSpotlightNames,
  encounter,
  steersStory,
  onRelease,
}: {
  // Kept for callers; the fight's banner that used them is gone.
  campaignId: string;
  floor: Floor;
  heldSpotlightNames: string[];
  encounter?: PublicEncounter | null;
  steersStory: boolean;
  meUserId?: string;
  onRelease: () => void;
}) {
  return (
    <>
      {floor.mode === "hold" && floor.next.mode === "initiative" && encounter?.enemyTurns ? (
        // A fight held for the enemies' turns (src/lib/dm/enemies-due.ts).
        // Reactions still go through. Held responses wrap the fight's floor
        // too, and keep their own banner below.
        <SessionBanner
          glyph="tab-battle"
          title="Enemy turns"
          actions={
            steersStory ? (
              <button type="button" onClick={onRelease} className={bannerButtonClass(true)}>
                Hand on the turn
              </button>
            ) : null
          }
        >
          <span>
            The enemies act before {floor.next.currentName || "the next turn"}; the DM hands on the turn.
          </span>
        </SessionBanner>
      ) : floor.mode === "hold" ? (
        <SessionBanner
          glyph="rest-inspiration"
          title="Responses held"
          actions={
            steersStory ? (
              <button type="button" onClick={onRelease} className={bannerButtonClass(true)}>
                Allow responses
              </button>
            ) : null
          }
        >
          <span>
            Talk it over; the lead opens the floor.
            {heldSpotlightNames.length ? (
              <span className="opacity-80">
                {" "}
                Next: spotlight on {heldSpotlightNames.join(", ")}
              </span>
            ) : null}
          </span>
        </SessionBanner>
      ) : null}
    </>
  );
}
