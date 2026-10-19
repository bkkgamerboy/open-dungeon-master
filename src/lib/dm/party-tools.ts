import type { SystemGlyph } from "@/lib/system-glyphs";
import { z } from "zod";
import { allocateSeq, type Campaign } from "@/lib/db/campaigns";
import { getParty, updateParty } from "@/lib/db/party";
import { insertCampaignMessage } from "@/lib/db/messages";
import { getSheetById, patchSheet } from "@/lib/db/sheets";
import { publishPersisted, publishWithSeq } from "@/lib/events";
import { splitBankedXp } from "@/lib/dm/party-logic";
import {
  boxCoins,
  bringAnimals,
  gainAnimal,
  giveUpStorage,
  healAnimal,
  hurtAnimal,
  leaveAnimals,
  loseAnimal,
  renameAnimal,
  rentStorage,
  retrieveItem,
  stowFromSheet,
  storeItem,
  takeToSheet,
  type PackResult,
} from "@/lib/dm/party-pack";
import { addCopper, formatCopper, parseCoins, purseCopper } from "@/lib/srd/currency";
import type { CharacterSheet } from "@/lib/schemas/sheet";

// Moving things between a character and the party.
//
// Every transfer here is two writes that must agree: coin leaving a purse has
// to arrive in the common one, and an item stowed has to leave the hands that
// stowed it. Doing that in one place is the point of the party record; before
// it, "put the rope in the party's kit" meant picking a character to blame.

export const PARTY_TOOL_NAMES = ["party_stash", "pack_animal", "party_storage"] as const;

const stashSchema = z.object({
  do: z.enum(["stow", "take", "deposit", "withdraw"]),
  characterId: z.string().optional(),
  name: z.string().max(80).optional(),
  qty: z.coerce.number().int().min(1).max(999).optional(),
  coins: z.string().max(60).optional(),
  amount: z.coerce.number().int().min(0).max(1000000).optional(),
  reason: z.string().max(200).optional(),
});

type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export const partyTools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "party_stash",
      description:
        "Move an item or money between one character and the party's shared pack and common purse. The party's pack and purse are shared property: use them for the rope nobody wants to carry and the coin the party banked together, not for a character's own kit.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          do: {
            type: "string",
            enum: ["stow", "take", "deposit", "withdraw"],
            description: "stow/take an item (name, qty); deposit/withdraw money (coins, or amount in whole gold).",
          },
          characterId: { type: "string", description: "Whose hands it comes from or goes to: exact characterId from GAME STATE." },
          name: { type: "string", description: "Item name, for stow and take." },
          qty: { type: "integer", minimum: 1, maximum: 999 },
          coins: { type: "string", description: "Money in denominations ('3 gp 4 sp')." },
          amount: { type: "integer", minimum: 0, description: "Money in whole gold, if coins is not used." },
          reason: { type: "string", description: "Short in-fiction cause." },
        },
        required: ["do"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "party_storage",
      description:
        "The party's storage boxes, rented in towns (see 'Storage boxes' in the party block). A box is used only while the party stands in its town, and holds things safe until they return. rent: open a box where the party stands (a bank, a warehouse, a temple's strongroom). put/take: an item between the box here and a character (characterId) or the shared pack (characterId 'pack'). deposit/withdraw: money between the box here and a character, or the common purse ('purse'). give_up: close the empty box here. Players usually do this themselves from the Party tab; use it when the story does it for them.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          do: { type: "string", enum: ["rent", "put", "take", "deposit", "withdraw", "give_up"] },
          characterId: { type: "string", description: "Exact characterId from GAME STATE, 'pack' for the shared pack, or 'purse' for the common purse." },
          name: { type: "string", description: "Item name, for put and take." },
          qty: { type: "integer", minimum: 1, maximum: 999 },
          coins: { type: "string", description: "Money in denominations ('3 gp 4 sp')." },
          amount: { type: "integer", minimum: 0, description: "Money in whole gold, if coins is not used." },
          reason: { type: "string", description: "Short in-fiction cause." },
        },
        required: ["do"],
      },
    },
  },
];

// The pack animal is offered in a fight too: a wolf pack goes for the mule
// as readily as for the wizard.
export const packAnimalTools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "pack_animal",
      description:
        "The party's pack animals, which carry the shared pack (see 'Pack animals' in the party block). gain: one joins in the story (a gift, a stray, a bandit's mule); kind is mule, pony, draft horse or camel. hurt: an enemy or hazard strikes it (amount = damage; at 0 it dies, and the load stays with the party). heal: tending it (amount, or all). lose: it dies, is stolen or bolts; cargo 'lost' if the shared pack went with it, otherwise 'kept'. leave: the party goes on without it, where a beast cannot follow (a dungeon, a cave, a tower stair, a ship's hold); the shared pack stays with it, so tell the players to take what they need first. bring: it is with the party again. rename: a new name. The party buys and sells animals themselves in a town's market from the Party tab.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          do: { type: "string", enum: ["gain", "hurt", "heal", "lose", "leave", "bring", "rename"] },
          animal: { type: "string", description: "Which one: its id or name, for hurt, heal, lose and rename." },
          kind: { type: "string", description: "For gain: mule, pony, draft horse or camel." },
          name: { type: "string", description: "For gain and rename: what the party calls it." },
          amount: { type: "integer", minimum: 1, maximum: 200, description: "Damage for hurt, hit points for heal." },
          cargo: { type: "string", enum: ["kept", "lost"], description: "For lose: whether the shared pack went with it." },
          reason: { type: "string", description: "Short in-fiction cause." },
        },
        required: ["do"],
      },
    },
  },
];

function tableNote(campaign: Campaign, content: string, glyph: SystemGlyph) {
  const seq = allocateSeq(campaign.id);
  const message = insertCampaignMessage({
    campaignId: campaign.id,
    seq,
    authorType: "system",
    glyph,
    content,
  });
  publishWithSeq(campaign.id, seq, "message_added", { message });
}

function publishParty(campaignId: string, party: ReturnType<typeof getParty>) {
  publishPersisted(campaignId, "party_updated", { party });
}

function resolve(
  id: string | undefined,
  sheets: CharacterSheet[],
  sheetsById: Map<string, CharacterSheet>,
): CharacterSheet | null {
  if (!id) {
    return null;
  }
  const direct = sheetsById.get(id);
  if (direct) {
    return direct;
  }
  const named = sheets.find((sheet) => sheet.name.toLowerCase() === id.toLowerCase());
  return named ?? null;
}

export function handlePartyStash(
  campaign: Campaign,
  rawArguments: string,
  sheets: CharacterSheet[],
  sheetsById: Map<string, CharacterSheet>,
): Record<string, unknown> {
  let args: z.infer<typeof stashSchema>;
  try {
    args = stashSchema.parse(JSON.parse(rawArguments || "{}"));
  } catch {
    return { error: "Invalid arguments: party_stash needs a `do` of stow, take, deposit or withdraw." };
  }

  const sheet = resolve(args.characterId, sheets, sheetsById);
  if (!sheet) {
    return { error: "party_stash needs a characterId: someone has to be handing it over or taking it." };
  }
  // Re-read: the sheet handed in may be a snapshot from the start of the turn.
  const fresh = getSheetById(sheet.id) ?? sheet;

  if (args.do === "stow" || args.do === "take") {
    const name = (args.name ?? "").trim();
    if (!name) {
      return { error: "Name the item." };
    }
    const qty = args.qty ?? 1;
    // Through the same door the Party panel uses (src/lib/dm/party-pack.ts),
    // so the pack's carrier and limit hold for the DM too: a pack left with
    // the mule at the dungeon's mouth is not in reach from the crypt.
    if (args.do === "stow") {
      const stowed = stowFromSheet(campaign, fresh.id, name, qty);
      if ("error" in stowed) {
        return stowed;
      }
      return { ok: true, stowed: name, note: stowed.message };
    }
    const took = takeToSheet(campaign, fresh.id, name, qty);
    if ("error" in took) {
      return took;
    }
    return { ok: true, took: name, note: took.message };
  }

  // Money. Coins win over the whole-gold amount when both are sent, for the
  // same reason they do in modify_gold: the more specific one was meant.
  const parsed = args.coins ? parseCoins(args.coins) : null;
  const copper = parsed ?? (args.amount ?? 0) * 100;
  if (copper <= 0) {
    return { error: "Say how much: coins like '3 gp 4 sp', or an amount in gold." };
  }

  if (args.do === "deposit") {
    const change = addCopper({ gold: fresh.gold, copper: fresh.copper }, -copper);
    if (change.short > 0) {
      return {
        error: `${fresh.name} only has ${formatCopper(purseCopper({ gold: fresh.gold, copper: fresh.copper }))}.`,
      };
    }
    patchSheet(fresh.id, { gold: change.purse.gold, copper: change.purse.copper });
    const party = updateParty(campaign.id, (current) => ({
      ...current,
      copper: current.copper + copper,
    }));
    publishParty(campaign.id, party);
    tableNote(campaign, `${fresh.name} puts ${formatCopper(copper)} in the common purse.`, "cue-coin");
    return { ok: true, deposited: formatCopper(copper), purse: formatCopper(party.copper) };
  }

  const party = getParty(campaign.id);
  if (party.copper < copper) {
    return { error: `The common purse holds ${formatCopper(party.copper)}.` };
  }
  const change = addCopper({ gold: fresh.gold, copper: fresh.copper }, copper);
  patchSheet(fresh.id, { gold: change.purse.gold, copper: change.purse.copper });
  const next = updateParty(campaign.id, (current) => ({
    ...current,
    copper: Math.max(0, current.copper - copper),
  }));
  publishParty(campaign.id, next);
  tableNote(campaign, `${fresh.name} takes ${formatCopper(copper)} from the common purse.`, "cue-coin");
  return { ok: true, withdrew: formatCopper(copper), purse: formatCopper(next.copper) };
}

// Handing out what the party banked. Not an adjudication: the DM decides when
// a session's experience is divided, and the AI has award_xp for everything
// it should be doing on its own.
export function payOutBankedXp(
  campaign: Campaign,
  characterIds: string[],
): { each: number; paid: string[] } | { error: string } {
  const party = getParty(campaign.id);
  if (party.bankedXp <= 0) {
    return { error: "There is no banked experience to hand out." };
  }
  const targets = characterIds.map((id) => getSheetById(id)).filter((sheet): sheet is CharacterSheet => Boolean(sheet));
  if (!targets.length) {
    return { error: "Nobody to hand it to." };
  }
  const split = splitBankedXp(party.bankedXp, targets.length);
  targets.forEach((sheet, index) => {
    patchSheet(sheet.id, { xp: sheet.xp + split.each[index] });
  });
  const next = updateParty(campaign.id, (current) => ({ ...current, bankedXp: 0 }));
  publishParty(campaign.id, next);
  tableNote(
    campaign,
    `The party divides ${split.spent} experience between ${targets.map((sheet) => sheet.name).join(", ")}.`,
    "cue-bell",
  );
  return { each: split.each[0], paid: targets.map((sheet) => sheet.name) };
}

function toolAnswer(result: PackResult): Record<string, unknown> {
  return "error" in result ? { error: result.error } : { ok: true, note: result.message };
}

const animalSchema = z.object({
  do: z.enum(["gain", "hurt", "heal", "lose", "leave", "bring", "rename"]),
  animal: z.string().max(80).optional(),
  kind: z.string().max(40).optional(),
  name: z.string().max(60).optional(),
  amount: z.coerce.number().int().min(1).max(200).optional(),
  cargo: z.enum(["kept", "lost"]).optional(),
  reason: z.string().max(200).optional(),
});

export function handlePackAnimal(campaign: Campaign, rawArguments: string): Record<string, unknown> {
  let args: z.infer<typeof animalSchema>;
  try {
    args = animalSchema.parse(JSON.parse(rawArguments || "{}"));
  } catch {
    return { error: "Invalid arguments: pack_animal needs a `do` of gain, hurt, heal, lose, leave, bring or rename." };
  }
  // With one animal, "the mule" needs no name.
  const party = getParty(campaign.id);
  const which = args.animal?.trim() || (party.packAnimals.length === 1 ? party.packAnimals[0].id : "");
  const needsWhich = args.do === "hurt" || args.do === "heal" || args.do === "lose" || args.do === "rename";
  if (needsWhich && !which) {
    return { error: `Say which animal: ${party.packAnimals.map((animal) => animal.name).join(", ") || "the party has none"}.` };
  }
  switch (args.do) {
    case "gain":
      return toolAnswer(gainAnimal(campaign, { kind: args.kind ?? "mule", name: args.name ?? "", reason: args.reason }));
    case "hurt":
      return toolAnswer(hurtAnimal(campaign, which, args.amount ?? 1, args.reason ?? ""));
    case "heal":
      return toolAnswer(healAnimal(campaign, which, args.amount));
    case "lose":
      return toolAnswer(loseAnimal(campaign, which, { cargo: args.cargo ?? "kept", reason: args.reason }));
    case "leave":
      return toolAnswer(leaveAnimals(campaign, args.reason ?? ""));
    case "bring":
      return toolAnswer(bringAnimals(campaign, { anywhere: true, reason: args.reason }));
    case "rename":
      return args.name ? toolAnswer(renameAnimal(campaign, which, args.name)) : { error: "Give the new name." };
  }
}

const storageSchema = z.object({
  do: z.enum(["rent", "put", "take", "deposit", "withdraw", "give_up"]),
  characterId: z.string().max(80).optional(),
  name: z.string().max(80).optional(),
  qty: z.coerce.number().int().min(1).max(999).optional(),
  coins: z.string().max(60).optional(),
  amount: z.coerce.number().int().min(0).max(1000000).optional(),
  reason: z.string().max(200).optional(),
});

export function handlePartyStorage(
  campaign: Campaign,
  rawArguments: string,
  sheets: CharacterSheet[],
  sheetsById: Map<string, CharacterSheet>,
): Record<string, unknown> {
  let args: z.infer<typeof storageSchema>;
  try {
    args = storageSchema.parse(JSON.parse(rawArguments || "{}"));
  } catch {
    return { error: "Invalid arguments: party_storage needs a `do` of rent, put, take, deposit, withdraw or give_up." };
  }
  if (args.do === "rent") {
    return toolAnswer(rentStorage(campaign, { anywhere: true }));
  }
  if (args.do === "give_up") {
    return toolAnswer(giveUpStorage(campaign));
  }
  const ref = (args.characterId ?? "").trim();
  const special = ref.toLowerCase();
  if (args.do === "put" || args.do === "take") {
    const name = (args.name ?? "").trim();
    if (!name) {
      return { error: "Name the item." };
    }
    let end: { kind: "pack" } | { kind: "sheet"; sheetId: string };
    if (special === "pack") {
      end = { kind: "pack" };
    } else {
      const sheet = resolve(ref, sheets, sheetsById);
      if (!sheet) {
        return { error: "Say whose hands it comes from or goes to: a characterId, or 'pack' for the shared pack." };
      }
      end = { kind: "sheet", sheetId: sheet.id };
    }
    return toolAnswer(
      args.do === "put" ? storeItem(campaign, end, name, args.qty ?? 1) : retrieveItem(campaign, end, name, args.qty ?? 1),
    );
  }
  const parsed = args.coins ? parseCoins(args.coins) : null;
  const copper = parsed ?? (args.amount ?? 0) * 100;
  if (copper <= 0) {
    return { error: "Say how much: coins like '3 gp 4 sp', or an amount in gold." };
  }
  if (special === "purse") {
    return toolAnswer(boxCoins(campaign, args.do, { kind: "purse" }, copper));
  }
  const sheet = resolve(ref, sheets, sheetsById);
  if (!sheet) {
    return { error: "Say whose money: a characterId, or 'purse' for the common purse." };
  }
  return toolAnswer(boxCoins(campaign, args.do, { kind: "sheet", sheetId: sheet.id }, copper));
}
