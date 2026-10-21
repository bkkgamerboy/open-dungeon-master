"use client";

import { Check } from "lucide-react";
import { SessionBanner, bannerButtonClass } from "@/app/campaigns/[campaignId]/SessionBanner";
import type { Floor } from "@/lib/db/campaigns";
import type { PublicEncounter } from "@/lib/db/encounter-view";
import type { CharacterSheet } from "@/lib/schemas/sheet";

// Spotlight and held-responses banners above the composer, with the lead's
// release button. A fight has no banner here (build 24): the round's red
// banner took a line of the screen for what the board and the hand already
// show; End is beside the hand's pips, and the lead's Skip turn is a card in
// the hand on others' turns (and stays in the Lead panel).
export function FloorBanners({
  floor,
  spotlighted,
  heldSpotlightNames,
  encounter,
  steersStory,
  onRelease,
}: {
  // Kept for callers; the fight's banner that used them is gone.
  campaignId: string;
  floor: Floor;
  spotlighted: CharacterSheet[];
  heldSpotlightNames: string[];
  encounter?: PublicEncounter | null;
  steersStory: boolean;
  meUserId?: string;
  onRelease: () => void;
}) {
  return (
    <>
      {floor.mode === "spotlight" ? (
        <SessionBanner
          glyph="sense-truesight"
          title={floor.respondedUserIds.length ? "Spotlight, waiting on" : "Spotlight"}
          lead={
            spotlighted.some((sheet) => sheet.portrait) ? (
              <span className="flex shrink-0 -space-x-2">
                {spotlighted
                  .filter((sheet) => sheet.portrait)
                  .slice(0, 4)
                  .map((sheet) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={sheet.id}
                      src={sheet.portrait!.url}
                      alt=""
                      className="size-8 rounded-full border border-amber-500/60 object-cover shadow-glow-gold"
                    />
                  ))}
              </span>
            ) : undefined
          }
          actions={
            steersStory ? (
              <button type="button" onClick={onRelease} className={bannerButtonClass(true)}>
                Release
              </button>
            ) : null
          }
        >
            <span>
              {spotlighted.length
                ? spotlighted.map((sheet, index) => {
                    const responded = floor.respondedUserIds.includes(sheet.userId);
                    return (
                      <span
                        key={sheet.id}
                        className={responded ? "opacity-50" : undefined}
                      >
                        {index > 0 ? ", " : ""}
                        {sheet.name}
                        {responded ? <Check className="inline size-3 align-baseline" /> : null}
                      </span>
                    );
                  })
                : "someone"}
              {floor.prompt ? (
                <span className="opacity-80"> · {floor.prompt}</span>
              ) : null}
            </span>
        </SessionBanner>
      ) : null}
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
