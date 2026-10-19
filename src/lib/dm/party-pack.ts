import type { SystemGlyph } from "@/lib/system-glyphs";
import { allocateSeq, type Campaign } from "@/lib/db/campaigns";
import { getActiveEncounter } from "@/lib/db/encounters";
import { getCurrentLocation } from "@/lib/db/locations";
import { insertCampaignMessage } from "@/lib/db/messages";
import { getParty, updateParty } from "@/lib/db/party";
import { getSheetById, patchSheet } from "@/lib/db/sheets";
import { listShopsAt } from "@/lib/db/shops";
import { publishPersisted, publishWithSeq } from "@/lib/events";
import { removeItemMath } from "@/lib/dm/mutation-math";
import {
  boxAt,
  joinNames,
  MAX_PACK_ANIMALS,
  PACK_ANIMAL_NAME_MAX,
  packAnimalKind,
  packReach,
  packRoomProblem,
  packWeightLb,
  rentBox,
  replaceBox,
  type PackAnimal,
  type PackReach,
  type PlaceRef,
  type StorageBox,
} from "@/lib/dm/pack-logic";
import { addPartyItem, removePartyItem, type PartyItem, type PartyState } from "@/lib/dm/party-logic";
import type { CharacterSheet, EquipmentItem } from "@/lib/schemas/sheet";
import { addCopper, formatCopper, purseCopper } from "@/lib/srd/currency";
import { loadLine } from "@/lib/srd/encumbrance";

// Moving the party's shared things around: the pack and who carries it, the
// pack animals, and the storage boxes rented in towns (src/lib/dm/
// pack-logic.ts has the rules; this is where they meet the database).
//
// Every move is two writes that must agree, as in party-tools.ts, and every
// move a person makes leaves a table note, so the DM reads "Rook put the
// plate armour in the Lanternhill box" in the log rather than finding it
// gone. The panel's routes and the DM's tools both come through here, so a
// mule left at the dungeon's mouth holds the pack for the AI too.

export type PackOk = { ok: true; message: string; party: PartyState };
export type PackResult = PackOk | { error: string };

// Who is acting, for the note: a person by their character, or the DM.
export type PackActor = { label: string };

export function herePlace(campaignId: string): PlaceRef | null {
  const location = getCurrentLocation(campaignId);
  return location ? { id: location.id, name: location.name } : null;
}

// A town, for buying and renting, is a place with a market: the same test
// the Market tab makes before it shows a shop.
export function marketAt(campaignId: string, place: PlaceRef | null): boolean {
  return place ? listShopsAt(campaignId, place.id, place.name).length > 0 : false;
}

export function reachNow(campaignId: string, party: PartyState = getParty(campaignId)): PackReach {
  return packReach(party.packAnimals, party.animalsLeftAt, herePlace(campaignId)?.id ?? null);
}

function midFight(campaignId: string): string | null {
  return getActiveEncounter(campaignId) ? "Not in the middle of a fight; settle that first." : null;
}

function note(campaign: Campaign, content: string, glyph: SystemGlyph = "cue-bell") {
  const seq = allocateSeq(campaign.id);
  const message = insertCampaignMessage({ campaignId: campaign.id, seq, authorType: "system", glyph, content });
  publishWithSeq(campaign.id, seq, "message_added", { message });
}

function publishParty(campaignId: string, party: PartyState) {
  publishPersisted(campaignId, "party_updated", { party });
}

function publishSheet(campaignId: string, sheetId: string) {
  const sheet = getSheetById(sheetId);
  if (sheet) {
    publishPersisted(campaignId, "sheet_updated", { sheet });
  }
}

function qtyText(name: string, qty: number): string {
  return `${name}${qty > 1 ? ` x${qty}` : ""}`;
}

// Pounds per unit, from the row's own number or the SRD tables the
// encumbrance engine weighs with; undefined when nothing knows.
export function unitWeight(item: { name: string; weight?: number }): number | undefined {
  const each = loadLine({ name: item.name, qty: 1, weight: item.weight }).eachLb;
  return typeof each === "number" && each > 0 ? each : undefined;
}

// A pack or box written before weights were kept gets them on its next
// write, so the limit is measured on what it holds.
export function withWeights(inventory: PartyItem[]): PartyItem[] {
  return inventory.map((item) => {
    if (item.weight !== undefined) {
      return item;
    }
    const weight = unitWeight(item);
    return weight === undefined ? item : { ...item, weight };
  });
}

// What leaves a sheet for the pack or a box: the row's identity rides
// along, its being worn or attuned does not.
function itemFromRow(row: EquipmentItem, qty: number): PartyItem {
  return {
    name: row.name,
    qty,
    ...(unitWeight(row) !== undefined ? { weight: unitWeight(row) } : {}),
    ...(row.identified === false ? { identified: false } : {}),
    ...(row.slug ? { slug: row.slug } : {}),
    ...(typeof row.charges === "number" ? { charges: row.charges } : {}),
  };
}

// And back onto a sheet, merging with a twin row the way a grant does.
function grantRow(equipment: EquipmentItem[], item: PartyItem, qty: number): EquipmentItem[] {
  const known = item.identified !== false;
  const index = equipment.findIndex(
    (row) =>
      row.name.toLowerCase() === item.name.toLowerCase() &&
      (row.identified !== false) === known &&
      (row.slug ?? "") === (item.slug ?? "") &&
      row.charges === item.charges,
  );
  if (index >= 0) {
    const next = [...equipment];
    next[index] = { ...next[index], qty: Math.min(999, next[index].qty + qty) };
    return next;
  }
  return [
    ...equipment,
    {
      name: item.name,
      qty,
      ...(known ? {} : { identified: false }),
      ...(item.slug ? { slug: item.slug } : {}),
      ...(typeof item.charges === "number" ? { charges: item.charges } : {}),
      ...(item.weight !== undefined ? { weight: item.weight } : {}),
    },
  ];
}

function rowNamed(sheet: CharacterSheet, name: string): EquipmentItem | null {
  return sheet.equipment.find((row) => row.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

function packUnreachable(reach: PackReach): string | null {
  if (reach.reachable) {
    return null;
  }
  return `The shared pack is with ${reach.carriedBy} at ${reach.awayAt?.name ?? "the place the party left them"}. Go back for ${reach.carriedBy.includes(" and ") ? "them" : "it"}, or bring the animals along first.`;
}

// ---- the shared pack ----

export function stowFromSheet(campaign: Campaign, sheetId: string, name: string, qty = 1): PackResult {
  const fight = midFight(campaign.id);
  if (fight) return { error: fight };
  const sheet = getSheetById(sheetId);
  if (!sheet || sheet.campaignId !== campaign.id) return { error: "That character is not at this table." };
  const row = rowNamed(sheet, name);
  if (!row) return { error: `${sheet.name} is not carrying "${name}".` };
  if (row.equipped || row.attuned) {
    return { error: `${sheet.name} has ${row.name} ${row.attuned ? "attuned" : "on"}; take it off first.` };
  }
  const party = getParty(campaign.id);
  const reach = reachNow(campaign.id, party);
  const away = packUnreachable(reach);
  if (away) return { error: away };
  const amount = Math.min(row.qty, Math.max(1, Math.floor(qty)));
  const moving = itemFromRow(row, amount);
  const inventory = withWeights(party.inventory);
  const room = packRoomProblem(inventory, (moving.weight ?? 0) * amount, reach);
  if (room) return { error: room };
  const added = addPartyItem(inventory, moving);
  if ("error" in added) return added;
  const taken = removeItemMath(sheet.equipment, row.name, amount);
  if (!taken) return { error: `${sheet.name} is not carrying "${name}".` };
  patchSheet(sheet.id, { equipment: taken.equipment });
  const next = updateParty(campaign.id, (current) => ({ ...current, inventory: added.inventory }));
  publishParty(campaign.id, next);
  publishSheet(campaign.id, sheet.id);
  const message = `${sheet.name} puts ${qtyText(row.name, taken.removed)} in the party's pack.`;
  note(campaign, message);
  return { ok: true, message, party: next };
}

export function takeToSheet(campaign: Campaign, sheetId: string, name: string, qty = 1): PackResult {
  const fight = midFight(campaign.id);
  if (fight) return { error: fight };
  const sheet = getSheetById(sheetId);
  if (!sheet || sheet.campaignId !== campaign.id) return { error: "That character is not at this table." };
  const party = getParty(campaign.id);
  const away = packUnreachable(reachNow(campaign.id, party));
  if (away) return { error: away };
  const taken = removePartyItem(party.inventory, name, qty);
  if ("error" in taken) return taken;
  patchSheet(sheet.id, { equipment: grantRow(sheet.equipment, taken.item, taken.removed) });
  const next = updateParty(campaign.id, (current) => ({ ...current, inventory: withWeights(taken.inventory) }));
  publishParty(campaign.id, next);
  publishSheet(campaign.id, sheet.id);
  const message = `${sheet.name} takes ${qtyText(taken.item.name, taken.removed)} from the party's pack.`;
  note(campaign, message);
  return { ok: true, message, party: next };
}

// The common purse is in someone's belt, not on the mule: always in reach.
export function purseMove(
  campaign: Campaign,
  sheetId: string,
  direction: "deposit" | "withdraw",
  copper: number,
): PackResult {
  const sheet = getSheetById(sheetId);
  if (!sheet || sheet.campaignId !== campaign.id) return { error: "That character is not at this table." };
  const amount = Math.max(0, Math.round(copper));
  if (amount <= 0) return { error: "Say how much." };
  const party = getParty(campaign.id);
  if (direction === "deposit") {
    const change = addCopper({ gold: sheet.gold, copper: sheet.copper }, -amount);
    if (change.short > 0) {
      return { error: `${sheet.name} only has ${formatCopper(purseCopper({ gold: sheet.gold, copper: sheet.copper }))}.` };
    }
    patchSheet(sheet.id, { gold: change.purse.gold, copper: change.purse.copper });
    const next = updateParty(campaign.id, (current) => ({ ...current, copper: current.copper + amount }));
    publishParty(campaign.id, next);
    publishSheet(campaign.id, sheet.id);
    const message = `${sheet.name} puts ${formatCopper(amount)} in the common purse.`;
    note(campaign, message, "cue-coin");
    return { ok: true, message, party: next };
  }
  if (party.copper < amount) return { error: `The common purse holds ${formatCopper(party.copper)}.` };
  const change = addCopper({ gold: sheet.gold, copper: sheet.copper }, amount);
  patchSheet(sheet.id, { gold: change.purse.gold, copper: change.purse.copper });
  const next = updateParty(campaign.id, (current) => ({ ...current, copper: Math.max(0, current.copper - amount) }));
  publishParty(campaign.id, next);
  publishSheet(campaign.id, sheet.id);
  const message = `${sheet.name} takes ${formatCopper(amount)} from the common purse.`;
  note(campaign, message, "cue-coin");
  return { ok: true, message, party: next };
}

// ---- pack animals ----

function findAnimal(party: PartyState, ref: string): PackAnimal | null {
  const needle = ref.trim().toLowerCase();
  return (
    party.packAnimals.find((animal) => animal.id === ref) ??
    party.packAnimals.find((animal) => animal.name.toLowerCase() === needle) ??
    null
  );
}

function cleanName(name: string, fallback: string): string {
  const cleaned = name.replace(/\s+/g, " ").trim().slice(0, PACK_ANIMAL_NAME_MAX);
  return cleaned || fallback;
}

function newAnimal(kindRef: string, name: string): PackAnimal | { error: string } {
  const kind = packAnimalKind(kindRef);
  if (!kind) {
    return { error: `"${kindRef}" is not a pack animal the game knows: a mule, a pony, a draft horse or a camel.` };
  }
  return {
    id: crypto.randomUUID(),
    name: cleanName(name, kind.name),
    kind: kind.slug,
    carry: kind.carry,
    hp: kind.hp,
    maxHp: kind.hp,
    ac: kind.ac,
    speed: kind.speed,
  };
}

function joinsProblem(party: PartyState): string | null {
  if (party.packAnimals.length >= MAX_PACK_ANIMALS) {
    return `The party already leads ${MAX_PACK_ANIMALS} animals; that is a string, not a party.`;
  }
  if (party.animalsLeftAt) {
    return `${joinNames(party.packAnimals.map((animal) => animal.name))} wait at ${party.animalsLeftAt.name}; fetch them before adding another.`;
  }
  return null;
}

// Bought in a town's market, paid from the common purse or one character's
// own purse.
export function buyAnimal(
  campaign: Campaign,
  input: { kind: string; name: string; payer: "purse" | string },
): PackResult {
  const fight = midFight(campaign.id);
  if (fight) return { error: fight };
  const here = herePlace(campaign.id);
  if (!marketAt(campaign.id, here)) {
    return { error: "Animals are bought in a town with a market; there is none here." };
  }
  const party = getParty(campaign.id);
  const blocked = joinsProblem(party);
  if (blocked) return { error: blocked };
  const animal = newAnimal(input.kind, input.name);
  if ("error" in animal) return animal;
  const price = packAnimalKind(animal.kind)?.priceCp ?? 0;
  let paidBy = "the common purse";
  if (input.payer === "purse") {
    if (party.copper < price) {
      return { error: `A ${animal.kind.replace("-", " ")} costs ${formatCopper(price)}; the common purse holds ${formatCopper(party.copper)}.` };
    }
  } else {
    const sheet = getSheetById(input.payer);
    if (!sheet || sheet.campaignId !== campaign.id) return { error: "Who is paying?" };
    const change = addCopper({ gold: sheet.gold, copper: sheet.copper }, -price);
    if (change.short > 0) {
      return { error: `A ${animal.kind.replace("-", " ")} costs ${formatCopper(price)}; ${sheet.name} has ${formatCopper(purseCopper({ gold: sheet.gold, copper: sheet.copper }))}.` };
    }
    patchSheet(sheet.id, { gold: change.purse.gold, copper: change.purse.copper });
    publishSheet(campaign.id, sheet.id);
    paidBy = sheet.name;
  }
  const next = updateParty(campaign.id, (current) => ({
    ...current,
    copper: input.payer === "purse" ? Math.max(0, current.copper - price) : current.copper,
    packAnimals: [...current.packAnimals, animal],
    inventory: withWeights(current.inventory),
  }));
  publishParty(campaign.id, next);
  const kindName = packAnimalKind(animal.kind)?.name.toLowerCase() ?? animal.kind;
  const message = `The party buys ${animal.name}, a ${kindName}, for ${formatCopper(price)} (paid by ${paidBy}). ${animal.name} carries up to ${animal.carry} lb of the shared pack.`;
  note(campaign, message, "cue-coin");
  return { ok: true, message, party: next };
}

// One the story gives them (a farmer's thanks, a bandit's abandoned mule).
export function gainAnimal(campaign: Campaign, input: { kind: string; name: string; reason?: string }): PackResult {
  const party = getParty(campaign.id);
  const blocked = joinsProblem(party);
  if (blocked) return { error: blocked };
  const animal = newAnimal(input.kind, input.name);
  if ("error" in animal) return animal;
  const next = updateParty(campaign.id, (current) => ({ ...current, packAnimals: [...current.packAnimals, animal] }));
  publishParty(campaign.id, next);
  const kindName = packAnimalKind(animal.kind)?.name.toLowerCase() ?? animal.kind;
  const message = `${animal.name}, a ${kindName}, joins the party${input.reason ? ` (${input.reason})` : ""}. It carries up to ${animal.carry} lb of the shared pack.`;
  note(campaign, message);
  return { ok: true, message, party: next };
}

export function leaveAnimals(campaign: Campaign, reason = ""): PackResult {
  const party = getParty(campaign.id);
  if (!party.packAnimals.length) return { error: "The party has no pack animals." };
  if (party.animalsLeftAt) return { error: `They already wait at ${party.animalsLeftAt.name}.` };
  const here = herePlace(campaign.id);
  if (!here) return { error: "Nowhere is recorded as where the party stands, so there is nowhere to leave them." };
  const next = updateParty(campaign.id, (current) => ({ ...current, animalsLeftAt: here }));
  publishParty(campaign.id, next);
  const names = joinNames(party.packAnimals.map((animal) => animal.name));
  const message = `The party leaves ${names} at ${here.name}, and the shared pack with ${party.packAnimals.length > 1 ? "them" : "it"}${reason ? ` (${reason})` : ""}.`;
  note(campaign, message);
  return { ok: true, message, party: next };
}

// A person fetches them where they wait; the DM may bring them anywhere
// (a stablehand leads the mule up the road).
export function bringAnimals(campaign: Campaign, options: { anywhere?: boolean; reason?: string } = {}): PackResult {
  const party = getParty(campaign.id);
  if (!party.packAnimals.length) return { error: "The party has no pack animals." };
  if (!party.animalsLeftAt) return { error: "They are already with the party." };
  const here = herePlace(campaign.id);
  if (!options.anywhere && here?.id !== party.animalsLeftAt.id) {
    return { error: `${joinNames(party.packAnimals.map((animal) => animal.name))} wait at ${party.animalsLeftAt.name}; the party has to go back there for them.` };
  }
  const left = party.animalsLeftAt;
  const next = updateParty(campaign.id, (current) => ({ ...current, animalsLeftAt: null }));
  publishParty(campaign.id, next);
  const message = `${joinNames(party.packAnimals.map((animal) => animal.name))} ${party.packAnimals.length > 1 ? "are" : "is"} back with the party${here && here.id !== left.id ? ` at ${here.name}` : ""}${options.reason ? ` (${options.reason})` : ""}.`;
  note(campaign, message);
  return { ok: true, message, party: next };
}

export function renameAnimal(campaign: Campaign, ref: string, name: string): PackResult {
  const party = getParty(campaign.id);
  const animal = findAnimal(party, ref);
  if (!animal) return { error: "No such animal." };
  const named = cleanName(name, animal.name);
  const next = updateParty(campaign.id, (current) => ({
    ...current,
    packAnimals: current.packAnimals.map((entry) => (entry.id === animal.id ? { ...entry, name: named } : entry)),
  }));
  publishParty(campaign.id, next);
  return { ok: true, message: `${animal.name} is now ${named}.`, party: next };
}

// What the rest carry, and whether the pack still fits, once one is gone.
function withoutAnimal(party: PartyState, id: string): { animals: PackAnimal[]; reach: PackReach } {
  const animals = party.packAnimals.filter((entry) => entry.id !== id);
  return { animals, reach: packReach(animals, animals.length ? party.animalsLeftAt : null, null) };
}

export function sellAnimal(campaign: Campaign, ref: string): PackResult {
  const fight = midFight(campaign.id);
  if (fight) return { error: fight };
  const party = getParty(campaign.id);
  const animal = findAnimal(party, ref);
  if (!animal) return { error: "No such animal." };
  if (party.animalsLeftAt) return { error: `${animal.name} waits at ${party.animalsLeftAt.name}; it has to be here to sell.` };
  if (!marketAt(campaign.id, herePlace(campaign.id))) return { error: "Animals are sold in a town with a market; there is none here." };
  const { animals, reach } = withoutAnimal(party, animal.id);
  const load = packWeightLb(withWeights(party.inventory));
  if (load > reach.capacityLb) {
    return { error: `The shared pack weighs ${load} lb and ${reach.carriedBy} can carry ${reach.capacityLb} lb without ${animal.name}. Unload some of it first.` };
  }
  const price = Math.floor((packAnimalKind(animal.kind)?.priceCp ?? 0) / 2);
  const next = updateParty(campaign.id, (current) => ({ ...current, packAnimals: animals, copper: current.copper + price, animalsLeftAt: animals.length ? current.animalsLeftAt : null }));
  publishParty(campaign.id, next);
  const message = `The party sells ${animal.name} for ${formatCopper(price)}, into the common purse.`;
  note(campaign, message, "cue-coin");
  return { ok: true, message, party: next };
}

export function hurtAnimal(campaign: Campaign, ref: string, amount: number, reason = ""): PackResult {
  const party = getParty(campaign.id);
  const animal = findAnimal(party, ref);
  if (!animal) return { error: "No such animal." };
  const damage = Math.max(1, Math.round(amount));
  const hp = Math.max(0, animal.hp - damage);
  if (hp > 0) {
    const next = updateParty(campaign.id, (current) => ({
      ...current,
      packAnimals: current.packAnimals.map((entry) => (entry.id === animal.id ? { ...entry, hp } : entry)),
    }));
    publishParty(campaign.id, next);
    const message = `${animal.name} takes ${damage} damage${reason ? ` (${reason})` : ""}: ${hp}/${animal.maxHp} HP.`;
    note(campaign, message);
    return { ok: true, message, party: next };
  }
  return loseAnimal(campaign, animal.id, { cargo: "kept", reason: reason || `struck down, ${damage} damage`, died: true });
}

export function healAnimal(campaign: Campaign, ref: string, amount?: number): PackResult {
  const party = getParty(campaign.id);
  const animal = findAnimal(party, ref);
  if (!animal) return { error: "No such animal." };
  const hp = amount === undefined ? animal.maxHp : Math.min(animal.maxHp, animal.hp + Math.max(1, Math.round(amount)));
  const next = updateParty(campaign.id, (current) => ({
    ...current,
    packAnimals: current.packAnimals.map((entry) => (entry.id === animal.id ? { ...entry, hp } : entry)),
  }));
  publishParty(campaign.id, next);
  return { ok: true, message: `${animal.name} is at ${hp}/${animal.maxHp} HP.`, party: next };
}

// Gone: dead, stolen, bolted. The load stays with the party ("kept": they
// pulled it off the body, or it was dropped where it fell) unless the DM
// says it went with the animal ("lost"). A pack over the new limit keeps
// what it holds and takes nothing more until it is lighter.
export function loseAnimal(
  campaign: Campaign,
  ref: string,
  options: { cargo?: "kept" | "lost"; reason?: string; died?: boolean } = {},
): PackResult {
  const party = getParty(campaign.id);
  const animal = findAnimal(party, ref);
  if (!animal) return { error: "No such animal." };
  const { animals, reach } = withoutAnimal(party, animal.id);
  const lostLoad = options.cargo === "lost";
  const next = updateParty(campaign.id, (current) => ({
    ...current,
    packAnimals: animals,
    animalsLeftAt: animals.length ? current.animalsLeftAt : null,
    inventory: lostLoad ? [] : current.inventory,
  }));
  publishParty(campaign.id, next);
  const load = packWeightLb(withWeights(next.inventory));
  const over = !lostLoad && load > reach.capacityLb;
  const message = `${animal.name} ${options.died ? "is dead" : "is gone"}${options.reason ? ` (${options.reason})` : ""}.${
    lostLoad ? " The shared pack went with it." : ""
  }${over ? ` The shared pack weighs ${load} lb and ${reach.carriedBy} can carry ${reach.capacityLb} lb: nothing more goes in until it is lighter.` : ""}`;
  note(campaign, message);
  return { ok: true, message, party: next };
}

// A long rest is a night's grazing and rest for the animals too.
export function restAnimals(campaignId: string): void {
  const party = getParty(campaignId);
  if (!party.packAnimals.some((animal) => animal.hp < animal.maxHp)) {
    return;
  }
  const next = updateParty(campaignId, (current) => ({
    ...current,
    packAnimals: current.packAnimals.map((animal) => ({ ...animal, hp: animal.maxHp })),
  }));
  publishParty(campaignId, next);
}

// ---- storage ----

function boxHere(campaignId: string, party: PartyState): { box: StorageBox; here: PlaceRef } | { error: string } {
  const here = herePlace(campaignId);
  if (!here) return { error: "Nowhere is recorded as where the party stands." };
  const box = boxAt(party.storage, here.id);
  if (!box) {
    const elsewhere = party.storage.map((entry) => entry.place.name);
    return {
      error: elsewhere.length
        ? `The party keeps no box in ${here.name}; theirs ${elsewhere.length > 1 ? "are" : "is"} in ${joinNames(elsewhere)}.`
        : `The party keeps no box in ${here.name}. Rent one first.`,
    };
  }
  return { box, here };
}

// "anywhere" is the DM's: a bank vault in a city with no shop on record.
export function rentStorage(campaign: Campaign, options: { anywhere?: boolean } = {}): PackResult {
  const here = herePlace(campaign.id);
  if (!here) return { error: "Nowhere is recorded as where the party stands." };
  if (!options.anywhere && !marketAt(campaign.id, here)) {
    return { error: "Storage is rented in a town with a market; there is none here." };
  }
  const party = getParty(campaign.id);
  const rented = rentBox(party.storage, here);
  if ("error" in rented) return rented;
  const next = updateParty(campaign.id, (current) => ({ ...current, storage: rented.storage }));
  publishParty(campaign.id, next);
  const message = `The party rents a storage box in ${here.name}. What goes in stays there, safe, until they come back for it.`;
  note(campaign, message);
  return { ok: true, message, party: next };
}

export function giveUpStorage(campaign: Campaign): PackResult {
  const party = getParty(campaign.id);
  const found = boxHere(campaign.id, party);
  if ("error" in found) return found;
  if (found.box.inventory.length || found.box.copper > 0) {
    return { error: `Empty the ${found.here.name} box first.` };
  }
  const next = updateParty(campaign.id, (current) => ({
    ...current,
    storage: current.storage.filter((box) => box.place.id !== found.here.id),
  }));
  publishParty(campaign.id, next);
  const message = `The party gives up its storage box in ${found.here.name}.`;
  note(campaign, message);
  return { ok: true, message, party: next };
}

// Into the box: from the shared pack, or from a character's own gear.
export function storeItem(
  campaign: Campaign,
  from: { kind: "pack" } | { kind: "sheet"; sheetId: string },
  name: string,
  qty = 1,
): PackResult {
  const fight = midFight(campaign.id);
  if (fight) return { error: fight };
  const party = getParty(campaign.id);
  const found = boxHere(campaign.id, party);
  if ("error" in found) return found;
  let moving: PartyItem;
  let afterPack = party.inventory;
  let sheetPatch: { id: string; equipment: EquipmentItem[]; name: string } | null = null;
  if (from.kind === "pack") {
    const away = packUnreachable(reachNow(campaign.id, party));
    if (away) return { error: away };
    const taken = removePartyItem(party.inventory, name, qty);
    if ("error" in taken) return taken;
    moving = { ...taken.item, qty: taken.removed };
    afterPack = taken.inventory;
  } else {
    const sheet = getSheetById(from.sheetId);
    if (!sheet || sheet.campaignId !== campaign.id) return { error: "That character is not at this table." };
    const row = rowNamed(sheet, name);
    if (!row) return { error: `${sheet.name} is not carrying "${name}".` };
    if (row.equipped || row.attuned) {
      return { error: `${sheet.name} has ${row.name} ${row.attuned ? "attuned" : "on"}; take it off first.` };
    }
    const amount = Math.min(row.qty, Math.max(1, Math.floor(qty)));
    const taken = removeItemMath(sheet.equipment, row.name, amount);
    if (!taken) return { error: `${sheet.name} is not carrying "${name}".` };
    moving = itemFromRow(row, taken.removed);
    sheetPatch = { id: sheet.id, equipment: taken.equipment, name: sheet.name };
  }
  const added = addPartyItem(found.box.inventory, moving, "box");
  if ("error" in added) return added;
  if (sheetPatch) {
    patchSheet(sheetPatch.id, { equipment: sheetPatch.equipment });
    publishSheet(campaign.id, sheetPatch.id);
  }
  const box = { ...found.box, inventory: added.inventory };
  const next = updateParty(campaign.id, (current) => ({ ...current, inventory: afterPack, storage: replaceBox(current.storage, box) }));
  publishParty(campaign.id, next);
  const who = sheetPatch ? sheetPatch.name : "The party";
  const message = `${who} puts ${qtyText(moving.name, moving.qty)} in the ${found.here.name} storage box${from.kind === "pack" ? " from the shared pack" : ""}.`;
  note(campaign, message);
  return { ok: true, message, party: next };
}

// Out of the box: into the shared pack, or onto a character.
export function retrieveItem(
  campaign: Campaign,
  to: { kind: "pack" } | { kind: "sheet"; sheetId: string },
  name: string,
  qty = 1,
): PackResult {
  const fight = midFight(campaign.id);
  if (fight) return { error: fight };
  const party = getParty(campaign.id);
  const found = boxHere(campaign.id, party);
  if ("error" in found) return found;
  const taken = removePartyItem(found.box.inventory, name, qty, "box");
  if ("error" in taken) return taken;
  const moving: PartyItem = { ...taken.item, qty: taken.removed };
  let pack = party.inventory;
  let who = "The party";
  if (to.kind === "pack") {
    const reach = reachNow(campaign.id, party);
    const away = packUnreachable(reach);
    if (away) return { error: away };
    const inventory = withWeights(party.inventory);
    const weight = moving.weight ?? unitWeight(moving) ?? 0;
    const room = packRoomProblem(inventory, weight * moving.qty, reach);
    if (room) return { error: room };
    const added = addPartyItem(inventory, { ...moving, ...(weight ? { weight } : {}) });
    if ("error" in added) return added;
    pack = added.inventory;
  } else {
    const sheet = getSheetById(to.sheetId);
    if (!sheet || sheet.campaignId !== campaign.id) return { error: "That character is not at this table." };
    patchSheet(sheet.id, { equipment: grantRow(sheet.equipment, moving, moving.qty) });
    publishSheet(campaign.id, sheet.id);
    who = sheet.name;
  }
  const box = { ...found.box, inventory: taken.inventory };
  const next = updateParty(campaign.id, (current) => ({ ...current, inventory: pack, storage: replaceBox(current.storage, box) }));
  publishParty(campaign.id, next);
  const message = `${who} takes ${qtyText(moving.name, moving.qty)} out of the ${found.here.name} storage box${to.kind === "pack" ? " into the shared pack" : ""}.`;
  note(campaign, message);
  return { ok: true, message, party: next };
}

// Coin in or out of the box, against the common purse or a character's.
export function boxCoins(
  campaign: Campaign,
  direction: "deposit" | "withdraw",
  source: { kind: "purse" } | { kind: "sheet"; sheetId: string },
  copper: number,
): PackResult {
  const fight = midFight(campaign.id);
  if (fight) return { error: fight };
  const amount = Math.max(0, Math.round(copper));
  if (amount <= 0) return { error: "Say how much." };
  const party = getParty(campaign.id);
  const found = boxHere(campaign.id, party);
  if ("error" in found) return found;
  let purse = party.copper;
  let who = "the common purse";
  if (direction === "withdraw" && found.box.copper < amount) {
    return { error: `The ${found.here.name} box holds ${formatCopper(found.box.copper)}.` };
  }
  if (source.kind === "purse") {
    if (direction === "deposit" && party.copper < amount) {
      return { error: `The common purse holds ${formatCopper(party.copper)}.` };
    }
    purse = direction === "deposit" ? party.copper - amount : party.copper + amount;
  } else {
    const sheet = getSheetById(source.sheetId);
    if (!sheet || sheet.campaignId !== campaign.id) return { error: "That character is not at this table." };
    const change = addCopper({ gold: sheet.gold, copper: sheet.copper }, direction === "deposit" ? -amount : amount);
    if (direction === "deposit" && change.short > 0) {
      return { error: `${sheet.name} only has ${formatCopper(purseCopper({ gold: sheet.gold, copper: sheet.copper }))}.` };
    }
    patchSheet(sheet.id, { gold: change.purse.gold, copper: change.purse.copper });
    publishSheet(campaign.id, sheet.id);
    who = sheet.name;
  }
  const box = { ...found.box, copper: direction === "deposit" ? found.box.copper + amount : found.box.copper - amount };
  const next = updateParty(campaign.id, (current) => ({ ...current, copper: purse, storage: replaceBox(current.storage, box) }));
  publishParty(campaign.id, next);
  const message =
    direction === "deposit"
      ? `${formatCopper(amount)} goes from ${who} into the ${found.here.name} storage box.`
      : `${formatCopper(amount)} comes out of the ${found.here.name} storage box to ${who}.`;
  note(campaign, message, "cue-coin");
  return { ok: true, message, party: next };
}
