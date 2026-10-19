import { isErrorResponse, requireStoryAuthority } from "@/lib/campaign-api";
import { saveCompanionToLibrary } from "@/lib/db/characters";
import { getSheetById } from "@/lib/db/sheets";
import { publishPersisted } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Save to library" on a companion's card: whoever runs the story saves the
// ally the DM plays to their own library, level, gear and spells, so the
// next campaign brings them in as they are now. Works on a finished
// campaign too, which is where the button matters most: its companions
// were never written home before companions kept their library link.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ campaignId: string; characterId: string }> },
) {
  const { campaignId, characterId } = await params;
  const context = await requireStoryAuthority(campaignId);
  if (isErrorResponse(context)) {
    return context;
  }
  const sheet = getSheetById(characterId);
  if (!sheet || sheet.campaignId !== campaignId || !sheet.isCompanion) {
    return Response.json({ error: "That companion is not in this campaign." }, { status: 404 });
  }
  const saved = saveCompanionToLibrary(sheet.id, context.user.id);
  if ("error" in saved) {
    return Response.json({ error: saved.error }, { status: 400 });
  }
  // The card learns its link, so the next press says "Saved" to the same row.
  const linked = getSheetById(sheet.id);
  if (linked) {
    publishPersisted(campaignId, "sheet_updated", { sheet: linked });
  }
  return Response.json({
    character: { id: saved.character.id, name: saved.character.name, level: saved.character.level },
    created: saved.created,
    keptLevel: saved.keptLevel,
  });
}
