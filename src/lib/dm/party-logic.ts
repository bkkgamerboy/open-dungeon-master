import { normalizeReputation } from "@/lib/dm/faction-logic";
import { describeFormation, normalizeFormationChange, type FormationChange } from "@/lib/dm/formation-logic";
import {
  describePackAnimal,
  normalizePackAnimals,
  normalizePlace,
  normalizeStorage,
  packReach,
  packWeightLb,
  type PackAnimal,
  type PlaceRef,
  type StorageBox,
} from "@/lib/dm/pack-logic";

// The party as a thing in its own right.
//
// Party gold, the shared pack, the party's XP and where the party IS were all
// smeared across N character sheets: "the party has 340 gold" meant adding up
// five purses, "the rope is in the party's kit" meant picking a character to
// hold it, and splitting a hoard meant N writes that could half-fail. This is
// the one record those facts live on instead.
//
// Modelled on dnd5e's data/actor/group.mjs: a party is a container with its
// own currency and inventory, not a sixth character. It has no hit points, no
// abilities and no sheet. Its pack animals do have hit points, and are the
// one thing on it a blow can land on (src/lib/dm/pack-logic.ts).
//
// Pure by design: no imports at all, so scripts/test-party.mjs can load it and
// the client can render the pack without a request.

export type PartyItem = {
  name: string;
  qty: number;
  // Pounds per unit, for the encumbrance rule. The shared pack still has to
  // be carried by someone, so its weight is reported rather than ignored.
  weight?: number;
  // False while nobody knows what it is, exactly as on a character sheet
  // (src/lib/dm/mutation-math.ts). Absent reads as true.
  identified?: boolean;
  // What makes a magic or homebrew item that item and not its name: the
  // content link (the sheet re-reads its mechanics from it) and the charges
  // left on a wand. Kept so a wand stored in a box comes out the same wand.
  slug?: string;
  charges?: number;
};

export type PartyState = {
  // Standing with each faction by id, minus five to five
  // (src/lib/dm/faction-logic.ts). Absent ids read as zero.
  reputation: Record<string, number>;
  // The common purse, in copper (src/lib/srd/currency.ts). Separate from
  // every character's own money: what the party banked together is not
  // anyone's to spend alone.
  copper: number;
  // The shared pack: rope, rations, the lantern nobody wants to carry.
  inventory: PartyItem[];
  // XP the party has earned as a group but not yet handed out. Awards still
  // land on sheets; this is the pool between "they earned it" and "everyone
  // takes their share", which is what makes a session's XP dividable.
  bankedXp: number;
  // Where the party is, as one fact rather than five. Free text, because a
  // location in ODM is a name and a description, not a coordinate.
  location: string;
  // The marching order, as character ids. Front of the list walks first,
  // which is what a trap, an ambush and a narrow corridor all want to know.
  // The travel formation in force (issue 230, formation-logic.ts).
  marchingOrder: string[];
  // The last change to it and the answers of the players it moved: a
  // proposal waiting on them, or a change already in force.
  formationChange: FormationChange | null;
  // What the party is doing between scenes: "resting", "on the road to
  // Dunmar", "searching the archive". One line, shown to the table.
  activity: string;
  // The beasts of burden that carry the shared pack (src/lib/dm/pack-logic.ts).
  packAnimals: PackAnimal[];
  // Where the animals wait when the party went on without them (a dungeon's
  // mouth, a stable), and the shared pack with them. Null: with the party.
  animalsLeftAt: PlaceRef | null;
  // Boxes rented in towns, one a place, used only while the party is there.
  storage: StorageBox[];
};

export const PARTY_ITEM_NAME_MAX = 80;
export const PARTY_ACTIVITY_MAX = 120;
export const PARTY_LOCATION_MAX = 120;
export const MAX_PARTY_ITEMS = 120;

export function emptyParty(): PartyState {
  return {
    reputation: {},
    copper: 0,
    inventory: [],
    bankedXp: 0,
    location: "",
    marchingOrder: [],
    formationChange: null,
    activity: "",
    packAnimals: [],
    animalsLeftAt: null,
    storage: [],
  };
}

// Anything unreadable reads as an empty party rather than throwing: a corrupt
// pack should cost the party its rope, not the session.
export function normalizeParty(raw: unknown): PartyState {
  if (!raw || typeof raw !== "object") {
    return emptyParty();
  }
  const record = raw as Record<string, unknown>;
  return {
    reputation: normalizeReputation(record.reputation),
    copper: Math.max(0, Math.round(Number(record.copper) || 0)),
    inventory: Array.isArray(record.inventory)
      ? (record.inventory as Array<Record<string, unknown>>)
          .map((item) => normalizeItem(item))
          .filter((item): item is PartyItem => item !== null)
          .slice(0, MAX_PARTY_ITEMS)
      : [],
    bankedXp: Math.max(0, Math.round(Number(record.bankedXp) || 0)),
    location: String(record.location ?? "").slice(0, PARTY_LOCATION_MAX),
    marchingOrder: Array.isArray(record.marchingOrder)
      ? (record.marchingOrder as unknown[]).slice(0, 12).map((id) => String(id))
      : [],
    formationChange: normalizeFormationChange(record.formationChange),
    activity: String(record.activity ?? "").slice(0, PARTY_ACTIVITY_MAX),
    packAnimals: normalizePackAnimals(record.packAnimals),
    // Animals left somewhere are only "left" while there are animals.
    animalsLeftAt: Array.isArray(record.packAnimals) && record.packAnimals.length ? normalizePlace(record.animalsLeftAt) : null,
    storage: normalizeStorage(record.storage, normalizeItem),
  };
}

function normalizeItem(raw: Record<string, unknown>): PartyItem | null {
  const name = String(raw?.name ?? "").trim().slice(0, PARTY_ITEM_NAME_MAX);
  if (!name) {
    return null;
  }
  const qty = Math.min(9999, Math.max(1, Math.round(Number(raw?.qty) || 1)));
  const weight = Number(raw?.weight);
  const slug = typeof raw?.slug === "string" ? raw.slug.trim().slice(0, 80) : "";
  const charges = Number(raw?.charges);
  return {
    name,
    qty,
    ...(Number.isFinite(weight) && weight > 0 ? { weight } : {}),
    ...(raw?.identified === false ? { identified: false } : {}),
    ...(slug ? { slug } : {}),
    ...(Number.isInteger(charges) && charges >= 0 ? { charges: Math.min(999, charges) } : {}),
  };
}

// ---- the shared pack ----

// Adding merges by name, the same rule a character sheet uses, and for the
// same reason: two rows of "rope (50 ft.)" is a bookkeeping bug, not two
// kinds of rope. An unidentified item never merges with a known one.
export function addPartyItem(
  inventory: PartyItem[],
  item: { name: string; qty?: number; weight?: number; identified?: boolean; slug?: string; charges?: number },
  // What holds it, for the refusals: the shared pack, or a storage box.
  holder: "pack" | "box" = "pack",
): { inventory: PartyItem[] } | { error: string } {
  const name = item.name.trim().slice(0, PARTY_ITEM_NAME_MAX);
  if (!name) {
    return { error: `Name what goes in the ${holder}.` };
  }
  const qty = Math.max(1, Math.round(item.qty ?? 1));
  const known = item.identified !== false;
  // A wand with three charges is not a wand with seven: rows with their own
  // content link or charges merge only with their exact twin.
  const index = inventory.findIndex(
    (row) =>
      row.name.toLowerCase() === name.toLowerCase() &&
      (row.identified !== false) === known &&
      (row.slug ?? "") === (item.slug ?? "") &&
      row.charges === item.charges,
  );
  if (index < 0) {
    if (inventory.length >= MAX_PARTY_ITEMS) {
      return { error: `The ${holder} holds ${MAX_PARTY_ITEMS} kinds of thing; take something out first.` };
    }
    return {
      inventory: [
        ...inventory,
        {
          name,
          qty,
          ...(item.weight && item.weight > 0 ? { weight: item.weight } : {}),
          ...(known ? {} : { identified: false as const }),
          ...(item.slug ? { slug: item.slug } : {}),
          ...(typeof item.charges === "number" ? { charges: item.charges } : {}),
        },
      ],
    };
  }
  const next = [...inventory];
  next[index] = { ...next[index], qty: next[index].qty + qty };
  return { inventory: next };
}

export function removePartyItem(
  inventory: PartyItem[],
  name: string,
  qty = 1,
  holder: "pack" | "box" = "pack",
): { inventory: PartyItem[]; removed: number; item: PartyItem } | { error: string } {
  const index = inventory.findIndex((row) => row.name.toLowerCase() === name.trim().toLowerCase());
  if (index < 0) {
    return { error: `The ${holder} does not hold "${name}".` };
  }
  const item = inventory[index];
  const removed = Math.min(item.qty, Math.max(1, Math.round(qty)));
  const next = [...inventory];
  if (item.qty - removed <= 0) {
    next.splice(index, 1);
  } else {
    next[index] = { ...item, qty: item.qty - removed };
  }
  return { inventory: next, removed, item };
}

// What the shared pack weighs. Reported rather than enforced: the encumbrance
// engine weighs what each character carries, and who is carrying the party's
// rope is a question only the table can answer.
export function partyWeight(inventory: PartyItem[]): number {
  return inventory.reduce((total, item) => total + (item.weight ?? 0) * item.qty, 0);
}

// ---- the marching order ----

// Rebuilt against the party that actually exists: characters who left are
// dropped and characters who joined are appended, so the order never names
// someone who is not here and never silently omits someone who is.
export function reconcileMarchingOrder(order: string[], characterIds: string[]): string[] {
  const present = new Set(characterIds);
  const kept = order.filter((id) => present.has(id));
  const seen = new Set(kept);
  return [...kept, ...characterIds.filter((id) => !seen.has(id))];
}

export function moveInMarchingOrder(
  order: string[],
  characterId: string,
  direction: "up" | "down",
): string[] {
  const index = order.indexOf(characterId);
  if (index < 0) {
    return order;
  }
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= order.length) {
    return order;
  }
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// ---- banked experience ----

// Handing out what the party banked. Splits evenly with the remainder going
// to the first share, matching how party_award already splits gold and how a
// table actually divides an odd number.
export function splitBankedXp(
  banked: number,
  shares: number,
): { each: number[]; spent: number } {
  const count = Math.max(1, Math.floor(shares));
  const pool = Math.max(0, Math.round(banked));
  const each = Math.floor(pool / count);
  const remainder = pool - each * count;
  return {
    each: Array.from({ length: count }, (_, index) => (index === 0 ? each + remainder : each)),
    spent: pool,
  };
}

// ---- the prompt line ----

// One block for the DM prompt and the party panel. Empty when the party has
// nothing to say about itself, so an untouched campaign's prompt does not
// carry a paragraph of zeroes.
export function describeParty(
  party: PartyState,
  formatMoney: (copper: number) => string,
  nameOf: (characterId: string) => string,
  // The characters in the party now. Given, the travel formation is read
  // against them (who is placed, who is not yet); absent, the stored order
  // is named as it stands.
  partyIds?: string[],
): string {
  const lines: string[] = [];
  if (party.location) {
    lines.push(`Where they are: ${party.location}`);
  }
  if (party.activity) {
    lines.push(`What they are doing: ${party.activity}`);
  }
  if (party.copper > 0) {
    lines.push(`Common purse: ${formatMoney(party.copper)}`);
  }
  if (party.bankedXp > 0) {
    lines.push(`Unspent party XP: ${party.bankedXp}`);
  }
  const reach = packReach(party.packAnimals, party.animalsLeftAt, null);
  if (party.inventory.length) {
    lines.push(
      `Shared pack (${packWeightLb(party.inventory)} of ${reach.capacityLb} lb, carried by ${reach.carriedBy}): ${party.inventory
        .map((item) => `${item.name}${item.qty > 1 ? ` x${item.qty}` : ""}`)
        .join(", ")}`,
    );
  }
  if (party.packAnimals.length) {
    lines.push(
      `Pack animals: ${party.packAnimals.map(describePackAnimal).join("; ")}. ${
        party.animalsLeftAt
          ? `${party.packAnimals.length > 1 ? "They wait" : "It waits"} at ${party.animalsLeftAt.name}, and the shared pack is with ${party.packAnimals.length > 1 ? "them" : "it"}.`
          : `With the party.`
      }`,
    );
  }
  if (party.storage.length) {
    lines.push(
      `Storage boxes: ${party.storage
        .map((box) => {
          const goods = box.inventory.map((item) => `${item.name}${item.qty > 1 ? ` x${item.qty}` : ""}`);
          const coin = box.copper > 0 ? formatMoney(box.copper) : "";
          const held = [...goods, ...(coin ? [coin] : [])];
          return `${box.place.name} (${held.length ? held.join(", ") : "empty"})`;
        })
        .join("; ")}`,
    );
  }
  if (partyIds) {
    const formation = describeFormation(party, partyIds, nameOf);
    if (formation) {
      lines.push(formation);
    }
  } else if (party.marchingOrder.length > 1) {
    lines.push(`Marching order (front first): ${party.marchingOrder.map(nameOf).join(", ")}`);
  }
  return lines.length ? `The party as a whole:\n${lines.join("\n")}` : "";
}
