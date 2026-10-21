// An ally the lead took over can be saved to the library (build 23).
//
// "Play this ally yourself" makes an ally the DM played one of the lead's own
// characters: theirs, and no longer marked a companion. The companion card's
// Save to library was for companions only and a player's own was for sheets
// with a library row, so an ally taken over before it was ever saved had no
// way home, and the campaign's end skipped it too. Held here, through the
// real routes:
//
//   the take-over gives an ally built by hand with a blank brief a brief of
//   its own, since the brief is what marks a taken-over ally; the own card's
//   save (POST /sheet/sync) links an unsaved taken-over ally to the
//   same-named companion already in its player's library, or files a new
//   library companion, and writes to that row from then on; a linked one
//   saves as before; nobody else can save it; a player's own hero with no
//   row and no brief is not filed as a companion; handing it back after
//   saving keeps the row, so its companion card saves onto it; and the
//   campaign's end carries an unsaved taken-over ally home to its player's
//   library, the dead and a briefless hero staying behind.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-taken-over-ally-save");

const world = await openWorld({
  gameSettings: { dmMode: "ai", companions: "full", maxCompanions: 4, multiCharacter: "off" },
  campaign: { startingLevel: 3 },
});
const characters = await import("../src/lib/db/characters.ts");
const sheetsDb = await import("../src/lib/db/sheets.ts");
const { createSheetSchema } = await import("../src/lib/schemas/sheet.ts");
const { finalizeNewCompanion } = await import("../src/lib/dm/companion-tools.ts");

function libraryInput(name, klass = "fighter") {
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

const TAKE = "campaigns/[campaignId]/companions/[characterId]/take";
const BACK = "campaigns/[campaignId]/companions/hand-back";
const SYNC = "campaigns/[campaignId]/sheet/sync";
const COMPANION_SAVE = "campaigns/[campaignId]/companions/[characterId]/library";
const CREATE = "campaigns/[campaignId]/companions/create";

const lead = world.owner;
world.addHero({ class: "rogue", name: "Swift", level: 3 });

// An ally built by hand: its brief is its backstory, here blank.
async function takenOver(name, klass) {
  const { sheet } = finalizeNewCompanion(world.campaign(), 3, libraryInput(name, klass), "party", "");
  assert.equal(sheet.libraryCharacterId, null);
  const { status, json } = await call(TAKE, "POST", lead, { characterId: sheet.id });
  assert.equal(status, 200, json.error);
  const own = world.sheet(sheet.id);
  assert.equal(own.isCompanion, false);
  assert.equal(own.userId, lead.id);
  return own;
}

await test("an unsaved taken-over ally built with a blank brief files a new library companion", async () => {
  const bruce = await takenOver("Bruce", "fighter");
  assert.equal(bruce.personality, sheetsDb.TAKEN_OVER_BRIEF, "the take-over gave the blank brief one of its own");
  world.patch(bruce.id, { xp: 2700, level: 4, gold: 41, equipment: [{ name: "Longsword +1", qty: 1 }] });
  const { status, json } = await call(SYNC, "POST", lead, {}, { characterId: bruce.id });
  assert.equal(status, 200, json.error);
  assert.equal(json.created, true);
  const row = characters.getCharacter(json.character.id);
  assert.equal(row.role, "companion", "still filed as an ally the DM plays");
  assert.equal(row.userId, lead.id);
  assert.equal(row.level, 4);
  assert.equal(row.sheet.gold, 41);
  assert.ok(row.sheet.equipment.some((item) => item.name === "Longsword +1"));
  assert.equal(world.sheet(bruce.id).libraryCharacterId, row.id, "linked from now on");
});

await test("a second save writes onto the same row", async () => {
  const bruce = world.sheets().find((entry) => entry.name === "Bruce");
  world.patch(bruce.id, { gold: 90 });
  const before = characters.listCharactersForUser(lead.id, "companion").length;
  const { status, json } = await call(SYNC, "POST", lead, {}, { characterId: bruce.id });
  assert.equal(status, 200, json.error);
  assert.equal(json.character.id, bruce.libraryCharacterId);
  assert.equal(characters.getCharacter(bruce.libraryCharacterId).sheet.gold, 90);
  assert.equal(characters.listCharactersForUser(lead.id, "companion").length, before, "no twin");
});

await test("an unsaved taken-over ally is linked to the same-named companion already in the library", async () => {
  const shelf = characters.createCharacter(lead.id, 1, libraryInput("Kramer", "warlock"), "companion");
  const kramer = await takenOver("Kramer", "warlock");
  const { status, json } = await call(SYNC, "POST", lead, {}, { characterId: kramer.id });
  assert.equal(status, 200, json.error);
  assert.equal(json.created, false);
  assert.equal(json.character.id, shelf.id, "the row it came from, not a twin");
  assert.equal(characters.getCharacter(shelf.id).level, 3, "the level it plays at goes home");
  assert.equal(world.sheet(kramer.id).libraryCharacterId, shelf.id);
});

await test("a taken-over ally brought in from the library saves through the ordinary sync", async () => {
  const shelf = characters.createCharacter(lead.id, 1, libraryInput("Isabel", "cleric"), "companion");
  const created = await call(CREATE, "POST", lead, {}, { libraryCharacterId: shelf.id });
  assert.equal(created.status, 201, created.json.error);
  const taken = await call(TAKE, "POST", lead, { characterId: created.json.sheet.id });
  assert.equal(taken.status, 200, taken.json.error);
  world.patch(created.json.sheet.id, { level: 4, xp: 2700 });
  const { status, json } = await call(SYNC, "POST", lead, {}, { characterId: created.json.sheet.id });
  assert.equal(status, 200, json.error);
  assert.equal(json.character.id, shelf.id);
  assert.equal(characters.getCharacter(shelf.id).level, 4);
});

await test("nobody else can save the lead's taken-over ally", async () => {
  const player = world.addUser("player");
  world.addHero({ user: player, class: "wizard", name: "Other", level: 3 });
  const kramer = world.sheets().find((entry) => entry.name === "Kramer");
  const { status } = await call(SYNC, "POST", player, {}, { characterId: kramer.id });
  assert.equal(status, 404);
  assert.equal(characters.saveCompanionToLibrary(kramer.id, player.id).error, "That is not a companion.");
});

// A sheet from before every hero was filed in the library: the lead's own,
// with no row and no brief.
const legacy = world.addHero({ user: lead, class: "wizard", name: "Old Hand", level: 3 });

await test("a player's own hero with no row and no brief is not filed as a companion", async () => {
  assert.equal(world.sheet(legacy.id).libraryCharacterId, null);
  const { status, json } = await call(SYNC, "POST", lead, {}, { characterId: legacy.id });
  assert.equal(status, 400);
  assert.match(json.error, /not linked/);
  assert.ok(!characters.listCharactersForUser(lead.id).some((entry) => entry.name === "Old Hand"));
});

await test("handed back after saving, the ally's companion card saves onto the same row", async () => {
  const bruce = world.sheets().find((entry) => entry.name === "Bruce");
  const back = await call(BACK, "POST", lead, {}, { sheetId: bruce.id });
  assert.equal(back.status, 200, back.json.error);
  assert.equal(world.sheet(bruce.id).isCompanion, true);
  assert.equal(world.sheet(bruce.id).libraryCharacterId, bruce.libraryCharacterId, "the link stays");
  const { status, json } = await call(COMPANION_SAVE, "POST", lead, { characterId: bruce.id });
  assert.equal(status, 200, json.error);
  assert.equal(json.created, false);
  assert.equal(json.character.id, bruce.libraryCharacterId);
});

await test("the campaign's end carries an unsaved taken-over ally home and leaves the dead", async () => {
  const mira = await takenOver("Mira", "fighter");
  const bram = await takenOver("Old Bram", "fighter");
  world.patch(bram.id, { currentHp: 0, deathSaves: { successes: 0, failures: 3, stable: false, dead: true } });
  world.patch(mira.id, { gold: 12 });
  const { status, json } = await call("campaigns/[campaignId]", "PATCH", lead, {}, { status: "ended" });
  assert.equal(status, 200, json.error);
  const shelf = characters.listCharactersForUser(lead.id, "companion");
  const names = shelf.map((entry) => entry.name);
  assert.ok(names.includes("Mira"), `saved: ${names.join(", ")}`);
  assert.ok(!names.includes("Old Bram"), "the dead stay behind");
  assert.ok(!characters.listCharactersForUser(lead.id).some((entry) => entry.name === "Old Hand"), "a briefless hero stays as it was");
  assert.equal(world.sheet(mira.id).libraryCharacterId, shelf.find((entry) => entry.name === "Mira").id);
  assert.equal(shelf.find((entry) => entry.name === "Mira").sheet.gold, 12);
});

finish();
