import { isErrorResponse, requireStoryAuthority } from "@/lib/campaign-api";
import { allocateSeq, getFloor, updateGameSettings } from "@/lib/db/campaigns";
import { activePublicEncounter } from "@/lib/db/encounter-view";
import { getActiveEncounter, saveEncounter } from "@/lib/db/encounters";
import { setInitiativeFloor } from "@/lib/dm/encounter-tools";
import { insertCampaignMessage } from "@/lib/db/messages";
import { getSheetById, takeOverCompanionSheet } from "@/lib/db/sheets";
import { publishPersisted, publishWithSeq } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Play this ally yourself" (the Party panel): an ally the DM played becomes
// one of the lead's own characters, fully theirs in fights and in the story.
// The sheet keeps its id and everything play wrote on it, so a fight in
// progress keeps its initiative slot and its token and the ally's next turn
// is the player's. A table that fields one character each is switched to
// fielding them all, since a second character nobody can act as would stand
// idle. The DM seat at a table a person runs plays allies already, and a
// guest the story brought for one scene stays the DM's; neither is offered.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ campaignId: string; characterId: string }> },
) {
  const { campaignId, characterId } = await params;
  const context = await requireStoryAuthority(campaignId);
  if (isErrorResponse(context)) {
    return context;
  }
  const campaign = context.campaign;
  if (campaign.dmUserId && campaign.dmUserId === context.user.id) {
    return Response.json(
      { error: "The Dungeon Master already plays the allies; a player at the table can take one over." },
      { status: 409 },
    );
  }
  const sheet = getSheetById(characterId);
  if (!sheet || sheet.campaignId !== campaignId) {
    return Response.json({ error: "That character is not at this table." }, { status: 404 });
  }
  if (!sheet.isCompanion) {
    return Response.json({ error: `${sheet.name} is not an ally the DM plays.` }, { status: 409 });
  }
  if (sheet.summon) {
    return Response.json({ error: `${sheet.name} came from a spell; its caster commands it.` }, { status: 409 });
  }
  if (sheet.companionKind === "guest") {
    return Response.json(
      { error: `${sheet.name} is a guest of this scene. Only an ally who travels with the party can be taken over.` },
      { status: 409 },
    );
  }
  const taken = takeOverCompanionSheet(sheet.id, context.user.id);
  if (!taken || taken.isCompanion) {
    return Response.json({ error: `Could not take over ${sheet.name}.` }, { status: 500 });
  }

  // Every one of the player's characters in play at once, so this one has a
  // Hand of its own on its turn (src/lib/player-characters.ts).
  let gameSettings = campaign.gameSettings;
  if (campaign.gameSettings.multiCharacter !== "all_active") {
    gameSettings = updateGameSettings(campaignId, { multiCharacter: "all_active" }) ?? gameSettings;
    publishPersisted(campaignId, "campaign_updated", { gameSettings });
  }

  // Mid-fight the slot is the same slot; it answers to the player now, which
  // is what the turn backstop reads (src/lib/dm/encounter-tools.ts).
  const encounter = getActiveEncounter(campaignId);
  if (encounter) {
    let changed = false;
    for (const entry of encounter.order) {
      if (entry.kind === "pc" && entry.characterId === sheet.id && entry.userId !== context.user.id) {
        entry.userId = context.user.id;
        changed = true;
      }
    }
    if (changed) {
      saveEncounter(encounter);
      publishPersisted(campaignId, "encounter_updated", { encounter: activePublicEncounter(campaignId) });
      // On their own turn the floor names who may act: it follows the
      // character to its new owner, or the composer stays shut for them.
      const up = encounter.orderReady ? encounter.order[encounter.turnIndex] : undefined;
      const floor = getFloor(campaignId);
      const fighting = floor.mode === "initiative" || (floor.mode === "hold" && floor.next.mode === "initiative");
      if (fighting && up?.kind === "pc" && up.characterId === sheet.id) {
        setInitiativeFloor(campaign, encounter);
      }
    }
  }

  publishPersisted(campaignId, "sheet_updated", { sheet: taken });
  if (campaign.status === "active") {
    const seq = allocateSeq(campaignId);
    const message = insertCampaignMessage({
      campaignId,
      seq,
      authorType: "system",
      glyph: "system-party",
      content: `${context.user.username} takes over ${sheet.name}: from here ${sheet.name} is a player character, and the DM no longer plays their turns or speaks for them.`,
    });
    publishWithSeq(campaignId, seq, "message_added", { message });
  }
  return Response.json({ ok: true, sheet: taken, gameSettings });
}
