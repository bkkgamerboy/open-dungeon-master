import { isErrorResponse, requireMember } from "@/lib/campaign-api";
import {
  getCharacterForUser,
  isUnsavedTakenOverAlly,
  keepsLibraryLevel,
  saveCompanionToLibrary,
  syncProgressToLibrary,
} from "@/lib/db/characters";
import { getSheetById } from "@/lib/db/sheets";
import { publishPersisted } from "@/lib/events";
import { ownSheetFor } from "@/lib/character-seat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Save progress to library": copy durable progression from the campaign
// sheet back to the linked library character on demand. `keptLevel` is the
// library level a lower table left alone (issue #36), or null when the whole
// sheet went back; the panel's button tells the player which happened.
// `characterId` names which of the player's own characters to save (the card
// whose button was pressed); unnamed, the selected one.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const context = await requireMember(campaignId);
  if (isErrorResponse(context)) {
    return context;
  }
  const raw: unknown = await request.json().catch(() => ({}));
  const named =
    raw && typeof raw === "object" && typeof (raw as { characterId?: unknown }).characterId === "string"
      ? (raw as { characterId: string }).characterId.slice(0, 80)
      : undefined;
  const sheet = ownSheetFor(campaignId, context.user.id, named);
  if (!sheet) {
    return Response.json(
      { error: named ? "That is not one of your characters." : "You have no character in this campaign." },
      { status: 404 },
    );
  }
  if (!sheet.libraryCharacterId) {
    // An ally the player took over ("Play this ally yourself") may never have
    // been saved: it is linked to the same-named companion in their library,
    // or becomes a new one, as a companion's own card does.
    if (isUnsavedTakenOverAlly(sheet)) {
      const saved = saveCompanionToLibrary(sheet.id, context.user.id);
      if ("error" in saved) {
        return Response.json({ error: saved.error }, { status: 400 });
      }
      // The card learns its link, so the next press writes to the same row.
      const linked = getSheetById(sheet.id);
      if (linked) {
        publishPersisted(campaignId, "sheet_updated", { sheet: linked });
      }
      return Response.json({ character: saved.character, keptLevel: saved.keptLevel, created: saved.created });
    }
    return Response.json(
      { error: "This character is not linked to your library." },
      { status: 400 },
    );
  }
  const before = getCharacterForUser(context.user.id, sheet.libraryCharacterId);
  const character = syncProgressToLibrary(sheet.id);
  if (!character) {
    return Response.json({ error: "Could not sync to your library." }, { status: 500 });
  }
  const keptLevel =
    before && keepsLibraryLevel(sheet.level, before.level) ? before.level : null;
  return Response.json({ character, keptLevel });
}
