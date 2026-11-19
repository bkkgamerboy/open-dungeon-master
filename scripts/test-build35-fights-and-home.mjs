// Build 35: what a night at the Drowned Ford showed, held here.
//
// A crocodile's bite grabs and holds ("grappled (escape DC 12). Until this
// grapple ends, the target is restrained"). When the crocodile died, the
// grapple ended but the restraint stayed, so the hero stood restrained by
// nothing. Now the restraint that came with a grapple ends with it when the
// holder falls; a restraint laid without a grapple (a net) stays. Who holds
// a hero is on the record Ask reads and in GAME STATE, and a turn the server
// plays for a skipped enemy says what its bite laid.
//
// XP: a fight is worth what the party beat, enemy by enemy, however it
// ended, and the party lead's End encounter at a table the AI runs pays it
// (it used to abort with none). The party does not walk on from an open
// fight unless the same reply closes it.
//
// The campaign's end: a hero its player seated and then handed to the DM was
// skipped without a word, every campaign, and came to the next table with the
// kit it was made with. It now goes home to its own row, and the end says who
// went home and who did not.
import assert from "node:assert/strict";
import { openWorld, dice, clearDice } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-build35-fights-and-home");

const world = await openWorld({
  gameSettings: { dmMode: "ai", companions: "full", maxCompanions: 4, multiCharacter: "on", maxCharactersPerPlayer: 4 },
  campaign: { startingLevel: 9 },
});
const { createDmTurn } = await import("../src/lib/db/dm-turns.ts");
const { applyEnemyDamage, fightXp } = await import("../src/lib/dm/enemy-damage.ts");
const { getBattleMapForEncounter, listTokens, placeToken } = await import("../src/lib/db/battle-maps.ts");
const { patchSheet, linkSheetToLibrary } = await import("../src/lib/db/sheets.ts");
const { listRecentMessages } = await import("../src/lib/db/messages.ts");
const { describeHeld } = await import("../src/lib/dm/ask.ts");
const { openFightRefusal } = await import("../src/lib/dm/turn.ts");
const { upsertCurrentLocation } = await import("../src/lib/db/locations.ts");
const characters = await import("../src/lib/db/characters.ts");
const { createSheetSchema } = await import("../src/lib/schemas/sheet.ts");

const bruce = world.addHero({ class: "fighter", level: 9, name: "Bruce", ac: 20, maxHp: 103, abilities: { str: 20 } });
world.addHero({ class: "rogue", level: 9, name: "Swift", ac: 16, maxHp: 60 });

const ctx = () => {
  const sheets = world.sheets();
  return [sheets, new Map(sheets.map((sheet) => [sheet.id, sheet]))];
};
const turn = () => createDmTurn(world.campaignId, [], "ai");
const kill = (enemy) => {
  const [sheets, byId] = ctx();
  return applyEnemyDamage(world.campaign(), turn(), world.encounter(), enemy, 1000, sheets, byId);
};
const beside = (enemyId, characterId) => {
  const map = getBattleMapForEncounter(world.encounter().id);
  const tokens = listTokens(map.id);
  const pc = tokens.find((token) => token.refId === characterId);
  const foe = tokens.find((token) => token.refId === enemyId);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const x = pc.x + dx;
    const y = pc.y + dy;
    if (map.terrain[y * map.width + x] === "." && !tokens.some((token) => token.x === x && token.y === y)) {
      placeToken(foe.id, x, y);
      return;
    }
  }
  throw new Error("no free tile");
};
const bite = async (enemy, target) => {
  beside(enemy.id, target.id);
  clearDice();
  dice(19, 2);
  const result = await world.invoke("enemy_attack", { enemyId: enemy.id, targetCharacterId: target.id });
  clearDice();
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.result;
};

await test("a crocodile's bite grabs and holds; its death frees the hero of both, not just the grapple", async () => {
  await world.beginFight([{ monster: "giant-crocodile", count: 1 }, { monster: "crocodile", count: 1 }]);
  const enemies = world.enemies();
  const small = enemies.find((enemy) => enemy.displayName === "Crocodile");
  const giant = enemies.find((enemy) => /giant/i.test(enemy.displayName));
  const result = await bite(small, bruce);
  assert.deepEqual(result.swings[0].riderCondition, ["grappled", "restrained"]);
  assert.deepEqual([...world.sheet(bruce.id).conditions].sort(), ["grappled", "restrained"]);

  // Who holds him is on the record Ask reads.
  const holders = new Map(world.enemies().map((enemy) => [enemy.id, enemy.displayName]));
  assert.deepEqual(describeHeld(world.sheet(bruce.id), holders), [
    "grappled (by Crocodile; escape DC 12 with Athletics or Acrobatics, as an action)",
    "restrained (by Crocodile, until its grapple ends)",
  ]);

  // The other crocodile dying lets go of nothing.
  kill(giant);
  assert.deepEqual([...world.sheet(bruce.id).conditions].sort(), ["grappled", "restrained"]);

  // The one holding him dying lets go of both.
  const freed = kill(world.enemies().find((enemy) => enemy.id === small.id));
  assert.match(String(freed.released), /Bruce \(grappled, restrained\)/);
  assert.deepEqual(world.sheet(bruce.id).conditions, []);
});

await test("a restraint laid with no grapple (a net) outlives the creature that laid it", async () => {
  await world.beginFight([{ monster: "crocodile", count: 1 }]);
  const croc = world.enemies()[0];
  patchSheet(bruce.id, { conditions: ["restrained"], conditionMeta: { restrained: { source: croc.id } } });
  kill(croc);
  assert.deepEqual(world.sheet(bruce.id).conditions, ["restrained"]);
  patchSheet(bruce.id, { conditions: [], conditionMeta: {} });
});

await test("a fight is worth what the party beat, enemy by enemy", () => {
  const dead = { status: "dead", xp: 1100, currentHp: 0, conditions: [] };
  const fled = { status: "fled", xp: 450, currentHp: 20, conditions: [] };
  const standing = { status: "alive", xp: 450, currentHp: 20, conditions: [] };
  // Old Scar killed, four clawfeathers run when she falls: 1100 + 4 x 225.
  assert.equal(fightXp([dead, fled, fled, fled, fled], "enemies_fled"), 2000);
  // Every enemy killed.
  assert.equal(fightXp([dead, { ...dead, xp: 450 }], "victory"), 1550);
  // The DM calls it a victory with one standing (it surrendered): full.
  assert.equal(fightXp([dead, standing], "victory"), 1550);
  // A truce with the rest: half for those.
  assert.equal(fightXp([dead, standing], "truce"), 1325);
  // The party ran after killing one: that one still counts, the rest nothing.
  assert.equal(fightXp([dead, standing, fled], "party_fled"), 1100);
  assert.equal(fightXp([dead, standing], "party_defeated"), 1100);
});

await test("the last enemies fleeing still pays full XP for the ones the party killed", async () => {
  await world.beginFight([{ monster: "crocodile", count: 3 }]);
  const [first, second, third] = world.enemies();
  const before = world.sheet(bruce.id).xp;
  kill(first);
  await world.invoke("enemy_flees", { enemyId: second.id });
  const ended = await world.invoke("enemy_flees", { enemyId: third.id });
  assert.equal(ended.ok, true, JSON.stringify(ended));
  assert.equal(world.encounter(), null, "the fight closed");
  // 100 for the killed one, 50 each for the two that fled, split two ways.
  assert.equal(world.sheet(bruce.id).xp - before, 100);
});

await test("the party lead's End encounter pays XP, and ?abort=1 is still there for a wedged fight", async () => {
  await world.beginFight([{ monster: "crocodile", count: 2 }]);
  const [first] = world.enemies();
  kill(first);
  const before = world.sheet(bruce.id).xp;
  const route = await world.route("campaigns/[campaignId]/encounter");
  world.signIn(world.owner);
  const response = await route.DELETE(new Request("http://test/", { method: "DELETE" }), {
    params: Promise.resolve({ campaignId: world.campaignId }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(world.encounter(), null);
  // 100 for the dead one, 50 for the one that slipped away, split two ways.
  assert.equal(world.sheet(bruce.id).xp - before, 75);

  await world.beginFight([{ monster: "crocodile", count: 1 }]);
  const xp = world.sheet(bruce.id).xp;
  const abort = await route.DELETE(new Request("http://test/?abort=1", { method: "DELETE" }), {
    params: Promise.resolve({ campaignId: world.campaignId }),
  });
  assert.equal(abort.status, 200);
  assert.equal(world.encounter(), null);
  assert.equal(world.sheet(bruce.id).xp, xp, "the abort pays nothing");
});

await test("the party does not walk on from an open fight", async () => {
  upsertCurrentLocation({ campaignId: world.campaignId, name: "The Drowned Ford" });
  assert.equal(openFightRefusal(world.campaignId, JSON.stringify({ name: "Ka'tuu Village" })), null, "no fight, no refusal");
  await world.beginFight([{ monster: "crocodile", count: 1 }]);
  const refusal = openFightRefusal(world.campaignId, JSON.stringify({ name: "Ka'tuu Village" }));
  assert.match(String(refusal), /A fight is still open here: 1 enemy is still in it \(Crocodile\)/);
  assert.match(String(refusal), /enemy_flees .* end_encounter/);
  assert.equal(openFightRefusal(world.campaignId, JSON.stringify({ name: "the drowned ford" })), null, "staying put is fine");
  kill(world.enemies()[0]);
  assert.equal(openFightRefusal(world.campaignId, JSON.stringify({ name: "Ka'tuu Village" })), null, "a closed fight lets them go");
});

function libraryInput(name, klass) {
  return createSheetSchema.parse({
    name,
    race: "human",
    class: klass,
    subclass: "",
    background: "acolyte",
    alignment: "neutral",
    abilities: { str: 10, dex: 8, con: 14, int: 10, wis: 12, cha: 16 },
    maxHp: 9,
    ac: 11,
    hitDice: { die: "d8", total: 1, spent: 0 },
    proficiencies: { saves: ["wis", "cha"], skills: [], expertise: [], languages: ["Common"], tools: [], armor: ["light"], weapons: ["simple"] },
    equipment: [{ name: "Light Crossbow", qty: 1 }, { name: "Vestments", qty: 1 }],
  });
}

await test("a hero handed to the DM goes home to its own row at the campaign's end, and the end says who went home", async () => {
  const lead = world.owner;
  // Kramer, filed as one of the lead's heroes, seated, then handed to the DM.
  const row = characters.createCharacter(lead.id, 1, libraryInput("Kramer", "warlock"), "pc");
  const kramer = world.addHero({ class: "warlock", level: 9, name: "Kramer", user: lead });
  linkSheetToLibrary(kramer.id, row.id);
  const route = await world.route("campaigns/[campaignId]/companions/hand-back");
  world.signIn(lead);
  const back = await route.POST(
    new Request("http://test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sheetId: kramer.id }) }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  const handed = await back.json();
  assert.equal(back.status, 200, JSON.stringify(handed));
  assert.equal(world.sheet(kramer.id).isCompanion, true);
  patchSheet(kramer.id, {
    equipment: [
      { name: "Rod of the Pact Keeper, +2", qty: 1, equipped: true, attuned: true },
      { name: "Amulet of Health", qty: 1, equipped: true, attuned: true },
    ],
    gold: 1200,
  });
  // A second hero whose library row is gone: named as not saved.
  const ghost = characters.createCharacter(lead.id, 1, libraryInput("Ghost", "warlock"), "pc");
  const lost = world.addHero({ class: "warlock", level: 9, name: "Ghost", user: lead });
  linkSheetToLibrary(lost.id, ghost.id);
  characters.deleteCharacter?.(lead.id, ghost.id);

  const ended = await (await world.route("campaigns/[campaignId]")).PATCH(
    new Request("http://test/", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "ended" }) }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  const body = await ended.json();
  assert.equal(ended.status, 200, JSON.stringify(body));
  const home = characters.getCharacter(row.id);
  assert.equal(home.level, 9);
  assert.ok(home.sheet.equipment.some((item) => item.name === "Rod of the Pact Keeper, +2"), JSON.stringify(home.sheet.equipment));
  assert.equal(home.sheet.gold, 1200);
  assert.equal(home.role, "pc", "it stays filed where it was");
  const kramerLine = body.home.find((entry) => entry.name === "Kramer");
  assert.deepEqual(kramerLine, { name: "Kramer", saved: true });
  const note = listRecentMessages(world.campaignId, 5).map((message) => message.content).find((content) => /Saved to the library/.test(content));
  assert.match(String(note), /Saved to the library .*Kramer/);
  if (characters.deleteCharacter) {
    assert.ok(body.home.some((entry) => entry.name === "Ghost" && !entry.saved), JSON.stringify(body.home));
    assert.match(String(note), /NOT saved: Ghost/);
  }
});

finish();
