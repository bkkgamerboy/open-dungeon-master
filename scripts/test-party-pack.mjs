// The shared pack's carrier, pack animals and town storage (build 15).
//
// Held here, through the Party tab's route and the DM's tools alike:
//
//   with no animal the party carries 50 lb of the shared pack by hand; a
//   mule bought in a town's market carries 420 lb and costs 8 gp from the
//   purse it is paid from; animals left at a place keep the pack with them
//   and out of reach elsewhere, for the DM's party_stash too; they are
//   fetched where they wait; a box is rented only where there is a market,
//   is used only while the party is there, and keeps a wand's charges and
//   content link; coin moves between box, purse and a character; an animal
//   struck to 0 dies and the load stays, over the limit, taking nothing
//   more; a long rest heals the animals; worn gear stays on; and only the
//   party lead makes the party's own decisions, while a player moves only
//   their own characters' things.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-party-pack");

const world = await openWorld({ gameSettings: { companions: "full" }, campaign: { startingLevel: 3 } });
const { upsertCurrentLocation } = await import("../src/lib/db/locations.ts");
const { insertShop } = await import("../src/lib/db/shops.ts");
const { getParty } = await import("../src/lib/db/party.ts");
const { HAND_CARRY_LB } = await import("../src/lib/dm/pack-logic.ts");

const town = upsertCurrentLocation({ campaignId: world.campaignId, name: "Lanternhill" });
insertShop(world.campaignId, { name: "Hollin's Outfitters", locationId: town.id, locationName: town.name, kind: "outfitter" });

const hero = world.addHero({
  name: "Rook",
  level: 3,
  equipment: [
    { name: "Rope, hempen (50 feet)", qty: 1 },
    { name: "Plate armor", qty: 1 },
    { name: "Chain shirt", qty: 1, equipped: true },
    { name: "Wand of Magic Missiles", qty: 1, slug: "wand-of-magic-missiles", charges: 4, weight: 1 },
  ],
});
world.patch(hero.id, { gold: 20 });

async function act(user, body) {
  const route = await world.route("campaigns/[campaignId]/party/pack");
  world.signIn(user);
  const response = await route.POST(
    new Request("http://test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  return { status: response.status, json: await response.json() };
}
const lead = world.owner;
const has = (name) => world.sheet(hero.id).equipment.find((item) => item.name === name)?.qty ?? 0;
const inPack = (name) => getParty(world.campaignId).inventory.find((item) => item.name === name)?.qty ?? 0;

await test("by hand the shared pack takes 50 lb and refuses plate armour", async () => {
  assert.equal(HAND_CARRY_LB, 50);
  const rope = await act(lead, { do: "stow", characterId: hero.id, name: "Rope, hempen (50 feet)" });
  assert.equal(rope.status, 200, rope.json.error);
  const plate = await act(lead, { do: "stow", characterId: hero.id, name: "Plate armor" });
  assert.equal(plate.status, 400);
  assert.match(plate.json.error, /pack animal/);
  assert.equal(has("Plate armor"), 1);
});

await test("worn gear stays on", async () => {
  const shirt = await act(lead, { do: "stow", characterId: hero.id, name: "Chain shirt" });
  assert.equal(shirt.status, 400);
  assert.match(shirt.json.error, /take it off/);
});

await test("a mule is bought in town from the purse that pays, and carries 420 lb", async () => {
  const broke = await act(lead, { do: "buy_animal", kind: "mule", name: "Bramble", payer: "purse" });
  assert.equal(broke.status, 400);
  const bought = await act(lead, { do: "buy_animal", kind: "mule", name: "Bramble", payer: hero.id });
  assert.equal(bought.status, 200, bought.json.error);
  assert.equal(world.sheet(hero.id).gold, 12, "8 gp paid");
  const [bramble] = getParty(world.campaignId).packAnimals;
  assert.equal(bramble.name, "Bramble");
  assert.equal(bramble.carry, 420);
  assert.equal(bramble.hp, 11);
  const plate = await act(lead, { do: "stow", characterId: hero.id, name: "Plate armor" });
  assert.equal(plate.status, 200, plate.json.error);
  assert.equal(inPack("Plate armor"), 1);
});

await test("only the party lead buys, and a player moves only their own things", async () => {
  const player = world.addUser("player");
  const theirs = world.addHero({ user: player, name: "Wren", level: 3, equipment: [{ name: "Torch", qty: 2 }] });
  const buy = await act(player, { do: "buy_animal", kind: "pony", name: "Pip", payer: theirs.id });
  assert.equal(buy.status, 403);
  const notMine = await act(player, { do: "take", characterId: hero.id, name: "Plate armor" });
  assert.equal(notMine.status, 403);
  const mine = await act(player, { do: "stow", characterId: theirs.id, name: "Torch", qty: 2 });
  assert.equal(mine.status, 200, mine.json.error);
});

await test("animals left at a place keep the pack there, for the DM too", async () => {
  const left = await act(lead, { do: "leave_animals" });
  assert.equal(left.status, 200, left.json.error);
  upsertCurrentLocation({ campaignId: world.campaignId, name: "The Undercroft" });
  const take = await act(lead, { do: "take", characterId: hero.id, name: "Plate armor" });
  assert.equal(take.status, 400);
  assert.match(take.json.error, /Bramble at Lanternhill/);
  const dm = await world.invoke("party_stash", { do: "take", characterId: hero.id, name: "Plate armor" });
  assert.equal(dm.ok, false);
  assert.match(dm.error, /Bramble/);
  const fetch = await act(lead, { do: "bring_animals" });
  assert.equal(fetch.status, 400, "fetched where they wait");
  upsertCurrentLocation({ campaignId: world.campaignId, name: "Lanternhill" });
  const back = await act(lead, { do: "bring_animals" });
  assert.equal(back.status, 200, back.json.error);
  assert.equal(getParty(world.campaignId).animalsLeftAt, null);
});

await test("a box is rented where there is a market and used only there", async () => {
  upsertCurrentLocation({ campaignId: world.campaignId, name: "The Undercroft" });
  const nowhere = await act(lead, { do: "rent_box" });
  assert.equal(nowhere.status, 400);
  upsertCurrentLocation({ campaignId: world.campaignId, name: "Lanternhill" });
  const rented = await act(lead, { do: "rent_box" });
  assert.equal(rented.status, 200, rented.json.error);
  const fromPack = await act(lead, { do: "box_put", from: "pack", name: "Plate armor" });
  assert.equal(fromPack.status, 200, fromPack.json.error);
  assert.equal(inPack("Plate armor"), 0);
  const wand = await act(lead, { do: "box_put", from: hero.id, name: "Wand of Magic Missiles" });
  assert.equal(wand.status, 200, wand.json.error);
  const box = getParty(world.campaignId).storage[0];
  assert.equal(box.place.name, "Lanternhill");
  assert.deepEqual(box.inventory.map((item) => item.name).sort(), ["Plate armor", "Wand of Magic Missiles"]);
  upsertCurrentLocation({ campaignId: world.campaignId, name: "The Undercroft" });
  const away = await act(lead, { do: "box_take", to: hero.id, name: "Wand of Magic Missiles" });
  assert.equal(away.status, 400);
  assert.match(away.json.error, /Lanternhill/);
  upsertCurrentLocation({ campaignId: world.campaignId, name: "Lanternhill" });
  const out = await act(lead, { do: "box_take", to: hero.id, name: "Wand of Magic Missiles" });
  assert.equal(out.status, 200, out.json.error);
  const row = world.sheet(hero.id).equipment.find((item) => item.name === "Wand of Magic Missiles");
  assert.equal(row.charges, 4, "the same wand comes out");
  assert.equal(row.slug, "wand-of-magic-missiles");
});

await test("coin moves between the box, a character and the purse", async () => {
  const deposit = await act(lead, { do: "box_coins", direction: "deposit", with: hero.id, copper: 500 });
  assert.equal(deposit.status, 200, deposit.json.error);
  assert.equal(world.sheet(hero.id).gold, 7);
  const toPurse = await act(lead, { do: "box_coins", direction: "withdraw", with: "purse", copper: 300 });
  assert.equal(toPurse.status, 200, toPurse.json.error);
  const party = getParty(world.campaignId);
  assert.equal(party.copper, 300);
  assert.equal(party.storage[0].copper, 200);
  const tooMuch = await act(lead, { do: "box_coins", direction: "withdraw", with: "purse", copper: 999 });
  assert.equal(tooMuch.status, 400);
});

await test("an animal struck to 0 dies, the load stays and the pack takes nothing more", async () => {
  // Load the mule past what hands can carry.
  const plate = await act(lead, { do: "box_take", to: "pack", name: "Plate armor" });
  assert.equal(plate.status, 200, plate.json.error);
  const hurt = await world.invoke("pack_animal", { do: "hurt", amount: 4, reason: "a wolf's bite" });
  assert.equal(hurt.ok, true, hurt.error);
  assert.equal(getParty(world.campaignId).packAnimals[0].hp, 7);
  const killed = await world.invoke("pack_animal", { do: "hurt", amount: 9, reason: "wolves" });
  assert.equal(killed.ok, true, killed.error);
  const party = getParty(world.campaignId);
  assert.equal(party.packAnimals.length, 0);
  assert.equal(inPack("Plate armor"), 1, "the load stays");
  assert.match(killed.result.note, /nothing more goes in/);
  world.patch(hero.id, { equipment: [...world.sheet(hero.id).equipment, { name: "Torch", qty: 1 }] });
  const more = await act(lead, { do: "stow", characterId: hero.id, name: "Torch" });
  assert.equal(more.status, 400);
  const lighter = await act(lead, { do: "take", characterId: hero.id, name: "Plate armor" });
  assert.equal(lighter.status, 200, lighter.json.error);
});

await test("a long rest heals the animals", async () => {
  const gained = await world.invoke("pack_animal", { do: "gain", kind: "draft horse", name: "Old Tom", reason: "a farmer's thanks" });
  assert.equal(gained.ok, true, gained.error);
  await world.invoke("pack_animal", { do: "hurt", amount: 5 });
  assert.equal(getParty(world.campaignId).packAnimals[0].hp, 14);
  const rest = await world.invoke("take_rest", { kind: "long", reason: "night at the inn" });
  assert.equal(rest.ok, true, JSON.stringify(rest).slice(0, 300));
  assert.equal(getParty(world.campaignId).packAnimals[0].hp, 19);
});

await test("the DM is told about the animals and the boxes", async () => {
  const { describeParty } = await import("../src/lib/dm/party-logic.ts");
  const text = describeParty(getParty(world.campaignId), (copper) => `${copper / 100} gp`, (id) => id);
  assert.match(text, /Pack animals: Old Tom \(draft horse, 19\/19 HP/);
  assert.match(text, /Storage boxes: Lanternhill \(2 gp\)/);
  assert.match(text, /Shared pack \(.* of 540 lb, carried by Old Tom\)/);
});

finish();
