import { z } from "zod";
import { isErrorResponse, requireMember } from "@/lib/campaign-api";
import { allocateSeq, getFloor, setMemberActiveCharacter } from "@/lib/db/campaigns";
import { activePublicEncounter } from "@/lib/db/encounter-view";
import { getActiveEncounter, saveEncounter } from "@/lib/db/encounters";
import { setInitiativeFloor } from "@/lib/dm/encounter-tools";
import { insertCampaignMessage } from "@/lib/db/messages";
import { adoptSheetAsCompanion, getSheetById, getSheetForUser, listSheetsForUser } from "@/lib/db/sheets";
import { createCompanionUser } from "@/lib/db/users";
import { lastingCompanionProblem } from "@/lib/dm/companion-tools";
import { requestDmTurn } from "@/lib/dm/loop";
import { publishEphemeral, publishPersisted, publishWithSeq } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ sheetId: z.string().trim().min(1) });

// "Hand back to the DM" (the Party panel): one of a player's own characters,
// most often an ally they took over, travels on as an ally the DM plays.
// Only its owner can hand it over, never another player's character, and
// only while they keep another character of their own to play. The sheet
// keeps its id and everything play wrote on it, so a fight keeps its
// initiative slot and its token; the table's companion setting and cap hold
// as for any lasting companion.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const context = await requireMember(campaignId);
  if (isErrorResponse(context)) {
    return context;
  }
  const campaign = context.campaign;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "Say which character." }, { status: 400 });
  }
  const sheet = getSheetById(parsed.data.sheetId);
  if (!sheet || sheet.campaignId !== campaignId) {
    return Response.json({ error: "That character is not at this table." }, { status: 404 });
  }
  if (sheet.isCompanion) {
    return Response.json({ error: `${sheet.name} is already an ally the DM plays.` }, { status: 409 });
  }
  if (sheet.userId !== context.user.id) {
    return Response.json({ error: `${sheet.name} is another player's character.` }, { status: 403 });
  }
  const others = listSheetsForUser(campaignId, context.user.id).filter(
    (entry) => !entry.isCompanion && entry.id !== sheet.id,
  );
  if (!others.length) {
    return Response.json(
      { error: `${sheet.name} is the only character you play here. Keep one to play before handing ${sheet.name} to the DM.` },
      { status: 409 },
    );
  }
  const blocked = lastingCompanionProblem(campaign);
  if (blocked) {
    return Response.json(
      {
        error: `${sheet.name} cannot be handed to the DM yet. ${blocked.reason} ${blocked.remedy}`,
        code: blocked.code,
        reason: blocked.reason,
        remedy: blocked.remedy,
      },
      { status: 409 },
    );
  }
  const wasRunning = getSheetForUser(campaignId, context.user.id)?.id === sheet.id;
  const bot = createCompanionUser(sheet.name);
  const handed = adoptSheetAsCompanion(sheet.id, bot.id, sheet.personality || sheet.backstory || "");
  if (!handed) {
    return Response.json({ error: "Could not hand the character to the DM." }, { status: 500 });
  }
  if (wasRunning) {
    setMemberActiveCharacter(campaignId, context.user.id, others[0].id);
    publishEphemeral(campaignId, "roster_updated", {
      userId: context.user.id,
      activeSheetId: others[0].id,
      at: Date.now(),
    });
  }
  const encounter = getActiveEncounter(campaignId);
  if (encounter) {
    let changed = false;
    for (const entry of encounter.order) {
      if (entry.kind === "pc" && entry.characterId === sheet.id && entry.userId !== bot.id) {
        entry.userId = bot.id;
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
  publishPersisted(campaignId, "sheet_updated", { sheet: handed });
  if (campaign.status === "active") {
    const seq = allocateSeq(campaignId);
    const message = insertCampaignMessage({
      campaignId,
      seq,
      authorType: "system",
      glyph: "system-party",
      content: `${context.user.username} hands ${sheet.name} back to the DM: from here they travel with the party as a companion, and the DM plays their turns.`,
    });
    publishWithSeq(campaignId, seq, "message_added", { message });
  }
  // Handed over on their own turn: the DM plays it now, not next round.
  const now = getActiveEncounter(campaignId);
  const up = now?.orderReady ? now.order[now.turnIndex] : undefined;
  if (up?.kind === "pc" && up.characterId === sheet.id) {
    requestDmTurn(campaignId);
  }
  return Response.json({ ok: true, sheet: handed });
}
