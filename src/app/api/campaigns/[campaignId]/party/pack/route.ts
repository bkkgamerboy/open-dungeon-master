import { z } from "zod";
import { isErrorResponse, isLead, requireMember, steersStory, type MemberContext } from "@/lib/campaign-api";
import { getSheetById } from "@/lib/db/sheets";
import {
  boxCoins,
  bringAnimals,
  buyAnimal,
  giveUpStorage,
  leaveAnimals,
  purseMove,
  renameAnimal,
  rentStorage,
  retrieveItem,
  sellAnimal,
  stowFromSheet,
  storeItem,
  takeToSheet,
  type PackResult,
} from "@/lib/dm/party-pack";
import type { CharacterSheet } from "@/lib/schemas/sheet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Party tab's Pack section: the shared pack and purse, the pack animals
// that carry it, and the storage boxes rented in towns. The rules live in
// src/lib/dm/party-pack.ts, which the DM's tools use too.
//
// Who may do what: a player moves things in and out of their own
// characters' hands; whoever runs the story does it for the companions as
// well; and the party's own decisions (buying or selling an animal, leaving
// it somewhere, renting a box, moving the pack's load into a box) are the
// party lead's, or the story's at a table a person runs.

const name = z.string().trim().min(1).max(80);
const qty = z.coerce.number().int().min(1).max(999).optional();
const id = z.string().trim().min(1).max(80);

const bodySchema = z.discriminatedUnion("do", [
  z.object({ do: z.enum(["stow", "take"]), characterId: id, name, qty }),
  z.object({ do: z.enum(["deposit", "withdraw"]), characterId: id, copper: z.coerce.number().int().min(1).max(100_000_000) }),
  z.object({ do: z.literal("buy_animal"), kind: z.string().trim().min(1).max(40), name: z.string().max(60).default(""), payer: id }),
  z.object({ do: z.literal("sell_animal"), animalId: id }),
  z.object({ do: z.literal("rename_animal"), animalId: id, name: z.string().trim().min(1).max(60) }),
  z.object({ do: z.enum(["leave_animals", "bring_animals", "rent_box", "give_up_box"]) }),
  z.object({ do: z.literal("box_put"), from: id, name, qty }),
  z.object({ do: z.literal("box_take"), to: id, name, qty }),
  z.object({
    do: z.literal("box_coins"),
    direction: z.enum(["deposit", "withdraw"]),
    with: id,
    copper: z.coerce.number().int().min(1).max(100_000_000),
  }),
]);

function decidesForParty(context: MemberContext): boolean {
  return isLead(context) || steersStory(context);
}

// A character the caller may move things for, or the refusal.
function handsOf(context: MemberContext, characterId: string): CharacterSheet | Response {
  const sheet = getSheetById(characterId);
  if (!sheet || sheet.campaignId !== context.campaign.id) {
    return Response.json({ error: "That character is not at this table." }, { status: 404 });
  }
  if (sheet.isCompanion ? !steersStory(context) : sheet.userId !== context.user.id) {
    return Response.json(
      { error: sheet.isCompanion ? "Only whoever runs the story moves a companion's things." : "That is not one of your characters." },
      { status: 403 },
    );
  }
  return sheet;
}

function partyOnly(context: MemberContext): Response | null {
  return decidesForParty(context)
    ? null
    : Response.json({ error: "That is the party lead's call." }, { status: 403 });
}

function answer(result: PackResult): Response {
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, message: result.message, party: result.party });
}

export async function POST(request: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const context = await requireMember(campaignId);
  if (isErrorResponse(context)) {
    return context;
  }
  if (context.campaign.status === "ended") {
    return Response.json({ error: "The campaign has ended." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message || "Say what to do." }, { status: 400 });
  }
  const body = parsed.data;
  const campaign = context.campaign;

  switch (body.do) {
    case "stow":
    case "take": {
      const sheet = handsOf(context, body.characterId);
      if (sheet instanceof Response) return sheet;
      return answer(
        body.do === "stow"
          ? stowFromSheet(campaign, sheet.id, body.name, body.qty ?? 1)
          : takeToSheet(campaign, sheet.id, body.name, body.qty ?? 1),
      );
    }
    case "deposit":
    case "withdraw": {
      const sheet = handsOf(context, body.characterId);
      if (sheet instanceof Response) return sheet;
      return answer(purseMove(campaign, sheet.id, body.do, body.copper));
    }
    case "buy_animal": {
      const refused = partyOnly(context);
      if (refused) return refused;
      if (body.payer !== "purse") {
        const sheet = handsOf(context, body.payer);
        if (sheet instanceof Response) return sheet;
      }
      return answer(buyAnimal(campaign, { kind: body.kind, name: body.name, payer: body.payer }));
    }
    case "sell_animal": {
      const refused = partyOnly(context);
      if (refused) return refused;
      return answer(sellAnimal(campaign, body.animalId));
    }
    case "rename_animal": {
      const refused = partyOnly(context);
      if (refused) return refused;
      return answer(renameAnimal(campaign, body.animalId, body.name));
    }
    case "leave_animals":
    case "bring_animals":
    case "rent_box":
    case "give_up_box": {
      const refused = partyOnly(context);
      if (refused) return refused;
      return answer(
        body.do === "leave_animals"
          ? leaveAnimals(campaign)
          : body.do === "bring_animals"
            ? bringAnimals(campaign)
            : body.do === "rent_box"
              ? rentStorage(campaign)
              : giveUpStorage(campaign),
      );
    }
    case "box_put": {
      if (body.from === "pack") {
        const refused = partyOnly(context);
        if (refused) return refused;
        return answer(storeItem(campaign, { kind: "pack" }, body.name, body.qty ?? 1));
      }
      const sheet = handsOf(context, body.from);
      if (sheet instanceof Response) return sheet;
      return answer(storeItem(campaign, { kind: "sheet", sheetId: sheet.id }, body.name, body.qty ?? 1));
    }
    case "box_take": {
      if (body.to === "pack") {
        const refused = partyOnly(context);
        if (refused) return refused;
        return answer(retrieveItem(campaign, { kind: "pack" }, body.name, body.qty ?? 1));
      }
      const sheet = handsOf(context, body.to);
      if (sheet instanceof Response) return sheet;
      return answer(retrieveItem(campaign, { kind: "sheet", sheetId: sheet.id }, body.name, body.qty ?? 1));
    }
    case "box_coins": {
      if (body.with === "purse") {
        const refused = partyOnly(context);
        if (refused) return refused;
        return answer(boxCoins(campaign, body.direction, { kind: "purse" }, body.copper));
      }
      const sheet = handsOf(context, body.with);
      if (sheet instanceof Response) return sheet;
      return answer(boxCoins(campaign, body.direction, { kind: "sheet", sheetId: sheet.id }, body.copper));
    }
  }
}
