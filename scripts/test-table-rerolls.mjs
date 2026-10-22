// Rolled ability scores at a table: the table's own reroll rule, and the
// six a character is admitted with. The server throws and keeps a player's
// 4d6 six (issue #128) under the admin's rule; a table may now set its own
// rule for the characters made at it (gameSettings.abilityRerollBelow), from
// "the first roll stands" to "reroll freely", and the six rolled there are
// that table's, so a table that rerolls freely cannot hand its six to a
// stricter table's builder or to the library's. A table that sets no rule
// follows the server's, pool and all: it hands back the player's library
// six, so opening another table is not a fresh throw.
//
// Also the door no test walked: /api/characters/rolls was never called, and
// the pool's spend at admission (admit.ts usedPool) was only seen in parts.
// Here a sheet that needs rolled scores is refused without the six on record
// where it is made, admitted with them, and spends them.
import assert from "node:assert/strict";
import { suite } from "./lib/enforce-harness.mjs";
import { LEGAL_FIGHTER, PORTRAIT, openCreation } from "./lib/enforce-creation.mjs";

const { test, finish } = suite("test-table-rerolls");
const rerolls = await import("../src/lib/srd/ability-rerolls.ts");

// Twenty-four forced faces each: six 4d6 throws, the lowest set aside.
const HIGH = [6, 6, 6, 1, 6, 6, 5, 1, 6, 5, 5, 1, 5, 5, 5, 1, 5, 5, 4, 1, 5, 4, 4, 1]; // 18 17 16 15 14 13 = 93
const LOW = [4, 3, 3, 1, 3, 3, 3, 1, 3, 3, 3, 1, 3, 3, 2, 1, 3, 3, 2, 1, 3, 2, 2, 1]; // 10 9 9 8 8 7 = 51

// A human fighter on the high six, +1 to each for being human: no point buy
// or standard array reaches these, so only the rolled six admit them.
const ROLLED_FIGHTER = {
  ...LEGAL_FIGHTER,
  abilities: { str: 19, dex: 18, con: 17, int: 16, wis: 15, cha: 14 },
  maxHp: 13,
};
// The same fighter on the low six: a 7 before the human's +1 is below what
// point buy allows, so only the rolled six admit it.
const WEAK_FIGHTER = {
  ...LEGAL_FIGHTER,
  abilities: { str: 11, dex: 10, con: 10, int: 9, wis: 9, cha: 8 },
  maxHp: 10,
  portrait: PORTRAIT,
};

await test("The words and the number agree: the first roll stands at 0, reroll freely at 108, a low roll in between; a table with no rule follows the server.", () => {
  assert.equal(rerolls.rerollChoiceOf(0), "keep");
  assert.equal(rerolls.rerollChoiceOf(70), "low");
  assert.equal(rerolls.rerollChoiceOf(108), "free");
  assert.equal(rerolls.rerollBelowFor("keep", 70), 0);
  assert.equal(rerolls.rerollBelowFor("free", 70), 108);
  assert.equal(rerolls.rerollBelowFor("low", 85), 85, "a threshold already chosen is kept");
  assert.equal(rerolls.rerollBelowFor("low", 108), 70, "switching back from free lands on the default");
  assert.equal(rerolls.tableRerollBelow(null, 70), 70);
  assert.equal(rerolls.tableRerollBelow(108, 70), 108);
  assert.equal(rerolls.tableRerollBelow(0, 70), 0);
});

await test("The builder words the rule from its choice and names whose rule it is: this table's at a table, this server's in the library; a table that follows the server says which rule that is.", () => {
  const keep = rerolls.rerollWords(0, true);
  assert.equal(keep.closed, "This table allows no second throw. These six are yours.");
  assert.equal(keep.closedTitle, "This table allows no second throw");
  assert.match(keep.rule, /this table allows no second throw/);
  assert.equal(rerolls.rerollWords(0, false).closedTitle, "This server allows no second throw");

  const free = rerolls.rerollWords(108, true);
  assert.equal(free.open, "This table lets you throw all six again as often as you like.");
  assert.equal(free.openTitle, "This table lets you throw again as often as you like");
  assert.match(free.rule, /as often as you like/);
  for (const text of [free.rule, free.open, free.openTitle]) {
    assert.doesNotMatch(text, /108/, "a free rule was put to the player as a number");
  }

  const low = rerolls.rerollWords(70, true);
  assert.equal(low.open, "Under 70: you may throw all six again.");
  assert.match(low.rule, /at this table you may throw again only if they add up to less than 70/);
  assert.equal(rerolls.rerollWords(70, false).rule, "The six are yours to keep: you may throw again only if they add up to less than 70.");

  assert.equal(rerolls.describeTableReroll(null, 0), "The server's rule (the first roll stands)");
  assert.equal(rerolls.describeTableReroll(null, null), "The server's reroll rule");
  assert.equal(rerolls.describeTableReroll(108, 0), "Reroll as often as you like");
});

const table = await openCreation();
const { world, campaignId, player, call, atTable, clearSeat, sheetRoute } = table;
const rollsRoute = await world.route("characters/rolls");
const settingsRoute = await world.route("campaigns/[campaignId]/settings");
const campaignsRoute = await world.route("campaigns");
const { saveGlobalConfig } = await import("../src/lib/db/app-settings.ts");

async function roll(user, faces, at) {
  world.signIn(user);
  world.dice(...faces);
  const out = await call(rollsRoute, "POST", { kind: "abilities", ...(at ? { campaignId: at } : {}) });
  world.clearDice();
  return out;
}
async function openPool(user, at) {
  world.signIn(user);
  const response = await rollsRoute.GET(new Request(`http://test/${at ? `?campaignId=${at}` : ""}`));
  return response.json();
}
async function setRule(value) {
  world.signIn(world.owner);
  return call(settingsRoute, "PATCH", { abilityRerollBelow: value }, { campaignId });
}
const totals = (out) => out.json.abilities?.totals;

await test("The lead sets the table's rule: a number from 0 to 108, or none to follow the server; anything else is refused.", async () => {
  assert.equal((await setRule(108)).status, 200);
  assert.equal(world.campaign().gameSettings.abilityRerollBelow, 108);
  assert.equal((await setRule(200)).status, 400);
  assert.equal((await setRule(null)).status, 200);
  assert.equal(world.campaign().gameSettings.abilityRerollBelow, null);
});

await test("A table that rerolls freely throws a fresh six even for a strong roll, while the library keeps its strong roll under the server's 70.", async () => {
  // A server whose admin chose "reroll a low roll" at 70 (the default is
  // free from build 26).
  saveGlobalConfig({ abilityRerollBelow: 70 });
  assert.equal((await setRule(108)).status, 200);
  const first = await roll(player, HIGH, campaignId);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual(totals(first), [18, 17, 16, 15, 14, 13]);
  assert.equal(first.json.abilities.rerollBelow, 108);
  const again = await roll(player, LOW, campaignId);
  assert.equal(again.json.abilities.kept, false, "a free table kept a strong six");
  assert.deepEqual(totals(again), [10, 9, 9, 8, 8, 7]);

  const library = await roll(player, HIGH);
  assert.equal(library.json.abilities.rerollBelow, 70, "the library left the server's rule");
  const libraryAgain = await roll(player, LOW);
  assert.equal(libraryAgain.json.abilities.kept, true, "the library rethrew a strong six");
  assert.deepEqual(totals(libraryAgain), [18, 17, 16, 15, 14, 13]);
  assert.deepEqual((await openPool(player, campaignId)).abilities?.totals, [10, 9, 9, 8, 8, 7], "the library's six reached the table");
});

await test("A table where the first roll stands hands back a weak six rather than throw again.", async () => {
  assert.equal((await setRule(0)).status, 200);
  const kept = await roll(player, HIGH, campaignId);
  assert.equal(kept.json.abilities.kept, true);
  assert.equal(kept.json.abilities.canReroll, false);
  assert.deepEqual(totals(kept), [10, 9, 9, 8, 8, 7], "the first roll did not stand");
});

await test("Scores that need rolled dice are admitted at a table only with that table's six: the library's strong six do not count there, the table's do, and they are spent.", async () => {
  assert.equal((await setRule(108)).status, 200);
  // The library holds the strong six; the table holds the weak ones.
  clearSeat(player);
  const refused = await atTable(ROLLED_FIGHTER);
  assert.equal(refused.status, 400, "the library's six admitted a character at the table");
  assert.equal(refused.sheet, null);

  await roll(player, HIGH, campaignId);
  const admitted = await atTable(ROLLED_FIGHTER);
  assert.equal(admitted.status, 201, admitted.error ?? "");
  assert.equal(admitted.sheet.abilities.str, 19);
  assert.equal((await openPool(player, campaignId)).abilities, null, "the table's six were not spent");
  assert.deepEqual((await openPool(player)).abilities?.totals, [18, 17, 16, 15, 14, 13], "the library's six were spent by a table's character");

  // The same scores again, with the six spent: refused.
  const twice = await atTable(ROLLED_FIGHTER);
  assert.equal(twice.status, 400, "spent dice admitted a second character");
});

await test("A table the player does not belong to has no dice for them.", async () => {
  const stranger = world.addUser("stranger");
  world.signIn(stranger);
  const out = await call(rollsRoute, "POST", { kind: "abilities", campaignId });
  assert.equal(out.status, 404);
  const response = await rollsRoute.GET(new Request(`http://test/?campaignId=${campaignId}`));
  assert.equal(response.status, 404);
});

await test("A table that follows the server's rule is not a fresh throw: where the first roll stands, the player's library six come back at every new table, and a character made at one spends them.", async () => {
  saveGlobalConfig({ abilityRerollBelow: 0 });
  const fisher = world.addUser("fisher");
  const library = await roll(fisher, LOW);
  assert.equal(library.json.abilities.kept, false);
  assert.deepEqual(totals(library), [10, 9, 9, 8, 8, 7]);

  // Three tables of the player's own, each left to follow the server.
  const tables = [];
  for (const title of ["First cast", "Second cast", "Third cast"]) {
    world.signIn(fisher);
    const made = await call(campaignsRoute, "POST", {
      title,
      description: "",
      theme: "high-fantasy",
      maxPlayers: 4,
      startingLevel: 1,
      difficulty: "normal",
    });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(made.json.campaign.gameSettings.abilityRerollBelow, null);
    tables.push(made.json.campaign.id);
  }
  for (const at of tables) {
    const open = await openPool(fisher, at);
    assert.deepEqual(open.abilities?.totals, [10, 9, 9, 8, 8, 7], "the builder at a new table did not see the kept six");
    assert.equal(open.rerollBelow, 0);
    const again = await roll(fisher, HIGH, at);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.abilities.kept, true, "a new table threw a fresh six where the first roll stands");
    assert.deepEqual(totals(again), [10, 9, 9, 8, 8, 7]);
  }

  // Following the server hands back the library's six, but still only to
  // someone who sits at the table.
  const outsider = world.addUser("outsider");
  world.signIn(outsider);
  const outsiderRoll = await call(rollsRoute, "POST", { kind: "abilities", campaignId: tables[0] });
  assert.equal(outsiderRoll.status, 404, "a table that follows the server rolled for someone not at it");
  const outsiderOpen = await rollsRoute.GET(new Request(`http://test/?campaignId=${tables[0]}`));
  assert.equal(outsiderOpen.status, 404, "a table that follows the server answered someone not at it");

  // The six were thrown in the library (as an app built before tables had
  // rules still throws them) and the character is made at a table.
  world.signIn(fisher);
  const made = await call(sheetRoute, "POST", WEAK_FIGHTER, { campaignId: tables[0] });
  assert.equal(made.status, 201, made.json.error ?? "");
  assert.equal((await openPool(fisher)).abilities, null, "the library's six outlived the character made with them");
  assert.equal((await openPool(fisher, tables[1])).abilities, null, "another table still holds the spent six");
  saveGlobalConfig({ abilityRerollBelow: 70 });
});

world.close();
finish();
