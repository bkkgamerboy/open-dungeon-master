// Build 37: what a sheet wears, read one way everywhere.
//
// A sheet that has never said what it wears counts everything it carries.
// Kramer's did: leather, a cloak, a rod. Tapping "wear" on one item made the
// sheet say what it wears, and every row nobody had marked came off with it,
// the leather included. His AC dropped, and in the next fight the leather
// could not go back on (donning takes a minute). The first switch now keeps
// on what was counting: the suit and shield the AC engine picks, and each
// magic item that works while worn.
//
// The sheet's worn marker read "worn" its own way (any row marked true), so a
// sheet with rows marked off and none on showed armour as worn that the AC
// did not count. The marker, the don/doff timer, the gear-change check and
// the heavy-armour readers now all ask the AC engine.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-build37-wear");

const world = await openWorld({ campaign: { startingLevel: 9 } });
const { patchSheet } = await import("../src/lib/db/sheets.ts");
const { isWorn } = await import("../src/lib/srd/armor.ts");
const { settleWear } = await import("../src/lib/srd/wear.ts");
const { armorChangeMinutes } = await import("../src/lib/dm/don-doff.ts");
const { gearChanges } = await import("../src/lib/dm/usage-rules.ts");
const { wearsHeavyArmor } = await import("../src/lib/dm/damage-logic.ts");

const player = world.addUser("kramer");
const kramer = world.addHero({
  user: player,
  class: "warlock",
  level: 9,
  name: "Kramer",
  acOverride: false,
  abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 10, cha: 18 },
});

const usage = await world.route("campaigns/[campaignId]/sheet/usage");
async function adjust(body) {
  world.signIn(player);
  const response = await usage.POST(
    new Request("http://test/", { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  return { status: response.status, body: await response.json() };
}

// The pack as it stood: nothing ever marked.
const pack = () => [
  { name: "Leather", qty: 1 },
  { name: "Cloak of Protection", qty: 1, attuned: true },
  { name: "Rod of the Pact Keeper, +2", qty: 1, attuned: true },
  { name: "Dagger", qty: 2 },
  { name: "Rope, hempen (50 feet)", qty: 1 },
];
const reset = () => world.patch(kramer.id, { equipment: pack(), acOverride: false });
const row = (name) => world.sheet(kramer.id).equipment.find((item) => item.name === name);

await test("A sheet that never said what it wears counts the leather and the cloak", () => {
  reset();
  assert.equal(world.sheet(kramer.id).ac, 11 + 2 + 1);
});

await test("Taking the cloak off as the first switch leaves the leather on", async () => {
  reset();
  const reply = await adjust({ gear: { "Cloak of Protection": { equipped: false } } });
  assert.equal(reply.status, 200, reply.body.error);
  assert.equal(row("Leather").equipped, true, "the leather came off with the cloak");
  assert.equal(row("Cloak of Protection").equipped, false);
  assert.equal(world.sheet(kramer.id).ac, 11 + 2);
});

await test("Putting on a new amulet as the first switch keeps the leather and the cloak on", async () => {
  world.patch(kramer.id, { equipment: [...pack(), { name: "Amulet of Health", qty: 1 }] });
  const before = world.sheet(kramer.id).ac;
  const reply = await adjust({ gear: { "Amulet of Health": { equipped: true } } });
  assert.equal(reply.status, 200, reply.body.error);
  assert.equal(row("Leather").equipped, true);
  assert.equal(row("Cloak of Protection").equipped, true);
  assert.equal(row("Amulet of Health").equipped, true);
  assert.equal(world.sheet(kramer.id).ac, before, "the AC moved when an amulet went on");
  // Plain gear stops counting as worn, as it always did.
  assert.equal(row("Dagger").equipped, false);
  // The rod works from the hand or the pack, worn or not.
  assert.equal(row("Rod of the Pact Keeper, +2").attuned, true);
});

await test("Attuning alone does not set wear on a sheet that never said", async () => {
  world.patch(kramer.id, {
    equipment: pack().map((item) => (item.name === "Cloak of Protection" ? { ...item, attuned: false } : item)),
  });
  const reply = await adjust({ gear: { "Cloak of Protection": { attuned: true } } });
  assert.equal(reply.status, 200, reply.body.error);
  assert.ok(world.sheet(kramer.id).equipment.every((item) => item.equipped === undefined));
});

await test("A DM or an edit that rewrites the pack with one row marked keeps the armour that was counting", () => {
  reset();
  const updated = patchSheet(kramer.id, {
    equipment: [...pack(), { name: "Ring of Protection", qty: 1, equipped: true, attuned: true }],
  });
  const leather = updated.equipment.find((item) => item.name === "Leather");
  assert.equal(leather.equipped, true, "the leather came off when a ring was added");
  assert.equal(updated.ac, 11 + 2 + 1 + 1);
});

await test("An edit that marks the armour itself is taken as it says", () => {
  reset();
  const updated = patchSheet(kramer.id, {
    equipment: pack().map((item) => (item.name === "Leather" ? { ...item, equipped: false } : item)),
  });
  assert.equal(updated.equipment.find((item) => item.name === "Leather").equipped, false);
  assert.equal(updated.ac, 10 + 2 + 1);
});

await test("Of two suits the first switch keeps the one the AC counted", () => {
  const equipment = [{ name: "Leather" }, { name: "Breastplate" }, { name: "Shield" }, { name: "Shield" }];
  const settled = settleWear(equipment, 2);
  assert.deepEqual(settled.map((item) => item.equipped), [undefined, true, true, undefined]);
});

// A sheet with a row marked off and none marked on: the AC engine reads
// every unmarked row as off. Everything else now reads it the same way.
const offOnly = [{ name: "Plate", qty: 1 }, { name: "Cloak", qty: 1, equipped: false }];

await test("The worn marker reads a sheet the way the AC does", () => {
  world.patch(kramer.id, { equipment: offOnly });
  const sheet = world.sheet(kramer.id);
  assert.equal(isWorn(sheet.equipment[0], sheet.equipment), false);
  assert.equal(sheet.ac, 10 + 2, "the AC engine counts the plate on this sheet");
});

await test("Putting on armour the AC is not counting is a change that takes time", () => {
  const plate = armorChangeMinutes(offOnly, { Plate: { equipped: true } });
  assert.equal(plate.minutes, 10, "putting on plate the AC was not counting was free");
  const changes = gearChanges({ equipment: offOnly }, { Plate: { equipped: true } });
  assert.deepEqual(changes.armor, ["Plate"]);
});

await test("Plate the AC is not counting is not heavy armour worn", () => {
  assert.equal(wearsHeavyArmor(offOnly), false);
  assert.equal(wearsHeavyArmor([{ name: "Plate" }]), true);
});

finish();
