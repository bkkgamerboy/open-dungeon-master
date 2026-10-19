// Companions go home to the library (build 15).
//
// A companion brought in from the library used to arrive as an unlinked,
// bot-owned copy, and the campaign's end wrote back only sheets whose owner
// matched their library row, so an ally who levelled with the party came
// back to the next campaign at the level they left the shelf. Held here:
//
//   the companion door keeps the library link; the campaign's end writes the
//   companion's level, experience and gear home like a player's; the card's
//   Save to library (POST /companions/[id]/library) is for whoever runs the
//   story, links an unlinked companion to the same-named one already in
//   their library rather than making a twin, and makes a new library
//   companion when there is none; and the campaign's end saves a lasting
//   companion with no row to the lead's library while leaving guests and the
//   dead behind. A player's own save still works as before.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-companion-library-save");

const settings = { companions: "full", maxCompanions: 3 };
const world = await openWorld({ gameSettings: settings, campaign: { startingLevel: 3 } });
const characters = await import("../src/lib/db/characters.ts");
const { createSheetSchema } = await import("../src/lib/schemas/sheet.ts");
const { finalizeNewCompanion } = await import("../src/lib/dm/companion-tools.ts");

function libraryInput(name, klass = "fighter", extra = {}) {
  return createSheetSchema.parse({
    name,
    race: "human",
    class: klass,
    subclass: "",
    background: "soldier",
    alignment: "neutral",
    abilities: { str: 15, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
    maxHp: 12,
    ac: 16,
    hitDice: { die: "d10", total: 1, spent: 0 },
    proficiencies: {
      saves: ["str", "con"],
      skills: ["athletics", "intimidation"],
      expertise: [],
      languages: ["Common"],
      tools: [],
      armor: ["light", "medium", "heavy", "shields"],
      weapons: ["simple", "martial"],
    },
    ...extra,
  });
}

async function call(name, method, user, params = {}, body) {
  const route = await world.route(name);
  world.signIn(user);
  const response = await route[method](
    new Request("http://test/", {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ campaignId: world.campaignId, ...params }) },
  );
  return { status: response.status, json: await response.json() };
}

const CREATE = "campaigns/[campaignId]/companions/create";
const SAVE = "campaigns/[campaignId]/companions/[characterId]/library";

const lead = world.owner;
world.addHero({ name: "Lead Hero", level: 3 });

await test("a companion brought in from the library keeps its library link", async () => {
  const wren = characters.createCharacter(lead.id, 1, libraryInput("Wren"), "companion");
  const { status, json } = await call(CREATE, "POST", lead, {}, { libraryCharacterId: wren.id });
  assert.equal(status, 201, json.error);
  const sheet = world.sheet(json.sheet.id);
  assert.equal(sheet.isCompanion, true);
  assert.equal(sheet.libraryCharacterId, wren.id);
  assert.equal(sheet.level, 3, "joins at the party's level");
});

await test("progress the companion made goes home through the ordinary sync", async () => {
  const sheet = world.sheets().find((entry) => entry.name === "Wren");
  world.patch(sheet.id, {
    level: 4,
    xp: 2700,
    equipment: [...sheet.equipment, { name: "Ring of Protection", qty: 1 }],
    gold: 120,
  });
  const saved = characters.syncProgressToLibrary(sheet.id);
  assert.ok(saved, "a companion's copy writes home");
  assert.equal(saved.level, 4);
  assert.equal(saved.xp, 2700);
  assert.equal(saved.sheet.gold, 120);
  assert.ok(saved.sheet.equipment.some((item) => item.name === "Ring of Protection"));
});

await test("only whoever runs the story may save a companion", async () => {
  const player = world.addUser("player");
  world.addHero({ user: player, name: "Player Hero", level: 3 });
  const sheet = world.sheets().find((entry) => entry.name === "Wren");
  const { status } = await call(SAVE, "POST", player, { characterId: sheet.id });
  assert.equal(status, 403);
});

await test("an unlinked companion is linked to the same-named one already in the library", async () => {
  // Brought in before companions kept their link: a copy with no row.
  const tam = characters.createCharacter(lead.id, 1, libraryInput("Tam", "rogue"), "companion");
  const { sheet } = finalizeNewCompanion(world.campaign(), 3, libraryInput("Tam", "rogue"), "party", "");
  assert.equal(sheet.libraryCharacterId, null);
  world.patch(sheet.id, { xp: 900, gold: 33 });
  const before = characters.listCharactersForUser(lead.id, "companion").length;
  const { status, json } = await call(SAVE, "POST", lead, { characterId: sheet.id });
  assert.equal(status, 200, json.error);
  assert.equal(json.created, false);
  assert.equal(json.character.id, tam.id, "the existing row, not a twin");
  assert.equal(json.character.level, 3);
  assert.equal(characters.listCharactersForUser(lead.id, "companion").length, before);
  assert.equal(world.sheet(sheet.id).libraryCharacterId, tam.id, "linked from now on");
  assert.equal(characters.getCharacter(tam.id).sheet.gold, 33);
});

await test("a companion with no row anywhere becomes a new library companion", async () => {
  const { sheet } = finalizeNewCompanion(world.campaign(), 3, libraryInput("Brother Aldo", "cleric"), "party", "");
  world.patch(sheet.id, { equipment: [{ name: "Mace", qty: 1 }, { name: "Healer's kit", qty: 1 }] });
  const { status, json } = await call(SAVE, "POST", lead, { characterId: sheet.id });
  assert.equal(status, 200, json.error);
  assert.equal(json.created, true);
  const row = characters.getCharacter(json.character.id);
  assert.equal(row.role, "companion");
  assert.equal(row.userId, lead.id);
  assert.equal(row.level, 3);
  assert.ok(row.sheet.equipment.some((item) => item.name === "Healer's kit"));
  // A second press saves onto the same row.
  const again = await call(SAVE, "POST", lead, { characterId: sheet.id });
  assert.equal(again.status, 200, again.json.error);
  assert.equal(again.json.created, false);
  assert.equal(again.json.character.id, json.character.id);
});

await test("the campaign's end saves lasting companions and leaves guests and the dead", async () => {
  const { sheet: unsaved } = finalizeNewCompanion(world.campaign(), 3, libraryInput("Mira", "fighter"), "party", "");
  const { sheet: guest } = finalizeNewCompanion(world.campaign(), 3, libraryInput("Town Guard"), "guest", "");
  const { sheet: fallen } = finalizeNewCompanion(world.campaign(), 3, libraryInput("Old Bram"), "party", "");
  world.patch(fallen.id, { currentHp: 0, deathSaves: { successes: 0, failures: 3, stable: false, dead: true } });
  const wren = world.sheets().find((entry) => entry.name === "Wren");
  world.patch(wren.id, { level: 5, xp: 6500 });

  const { status, json } = await call("campaigns/[campaignId]", "PATCH", lead, {}, { status: "ended" });
  assert.equal(status, 200, json.error);

  const shelf = characters.listCharactersForUser(lead.id, "companion");
  const names = shelf.map((entry) => entry.name);
  assert.ok(names.includes("Mira"), `saved: ${names.join(", ")}`);
  assert.ok(!names.includes("Town Guard"), "a guest stays behind");
  assert.ok(!names.includes("Old Bram"), "the dead stay behind");
  assert.equal(world.sheet(unsaved.id).libraryCharacterId, shelf.find((entry) => entry.name === "Mira").id);
  assert.equal(shelf.find((entry) => entry.name === "Wren").level, 5, "a linked companion writes home at the end");
  assert.equal(world.sheet(guest.id).libraryCharacterId, null);
});

await test("a player's own save to library is unchanged", async () => {
  const pc = characters.createCharacter(lead.id, 3, libraryInput("Lead Library Hero"), "pc");
  const sheet = (await import("../src/lib/db/sheets.ts")).createSheet(world.campaignId, lead.id, 3, libraryInput("Lead Library Hero"), pc.id);
  world.patch(sheet.id, { level: 4, xp: 2700 });
  const saved = characters.syncProgressToLibrary(sheet.id);
  assert.equal(saved.level, 4);
  // Somebody else's copy of it still does not write to the row.
  const other = world.addUser("other");
  const stranger = (await import("../src/lib/db/sheets.ts")).createSheet(world.campaignId, other.id, 3, libraryInput("Stranger"), pc.id);
  assert.equal(characters.syncProgressToLibrary(stranger.id), null);
});

finish();
