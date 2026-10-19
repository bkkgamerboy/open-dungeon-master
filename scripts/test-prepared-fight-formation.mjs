// A prepared fight opens with the party in its travel formation, two
// abreast and facing the enemy, on whatever ground the fight brings: its
// saved map (with or without an entry point) or the generator's map. Before,
// a saved map left everyone where the generated map had put them, nearest
// open tile, and an entry point piled the party round one tile in the order
// the characters were made, so whoever was made first stood at the door.

import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-prepared-fight-formation");
const { dispatchAdjudication } = await import("../src/lib/dm/invoke-dispatch.ts");
const { createDmTurn } = await import("../src/lib/db/dm-turns.ts");
const { listSheets } = await import("../src/lib/db/sheets.ts");
const { getBattleMapForEncounter, listTokens } = await import("../src/lib/db/battle-maps.ts");
const { insertEncounterTemplate } = await import("../src/lib/db/encounter-templates.ts");
const { createPreparedMap } = await import("../src/lib/db/prepared-maps.ts");
const { endEncounter } = await import("../src/lib/db/encounters.ts");
const { getParty, setParty } = await import("../src/lib/db/party.ts");
const { tileIndex, blocksMove } = await import("../src/lib/battlemap/types.ts");

const world = await openWorld({ gameSettings: { dmMode: "ai" } });
// Made in this order on purpose: the fighter last, so roster order would
// put the rogue at the door and the fighter at the back.
const rogue = world.addHero({ class: "rogue", level: 3, name: "Swift" });
const cleric = world.addHero({ class: "cleric", level: 3, name: "Isabel" });
const warlock = world.addHero({ class: "warlock", level: 3, name: "Kramer" });
const fighter = world.addHero({ class: "fighter", level: 3, name: "Bruce" });
const front = [fighter.id, rogue.id];
const rear = [cleric.id, warlock.id];

// A drawn hall, 26 by 14: a west entry corridor two wide, pillars, a low
// wall and a pool of water in the room, enemies set at the east end.
const W = 26;
const H = 14;
const rows = Array.from({ length: H }, (_, y) =>
  Array.from({ length: W }, (_, x) => {
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return "#";
    if (x <= 5 && (y < 6 || y > 7)) return "#";
    if ((x === 9 || x === 15) && (y === 3 || y === 10)) return "#";
    if (x === 12 && y >= 5 && y <= 8) return "|";
    if (x >= 17 && x <= 18 && y >= 2 && y <= 3) return "~";
    return ".";
  }).join(""),
);
const terrain = rows.join("");
const hall = createPreparedMap({
  campaignId: world.campaignId,
  name: "Goblin hall",
  width: W,
  height: H,
  terrain,
  ambient: "dim",
  theme: "interior",
});

const template = (name, extras, map = { mapId: hall.id }) =>
  insertEncounterTemplate({
    campaignId: world.campaignId,
    name,
    enemies: [
      { monster: "goblin", count: 2 },
      { monster: "hobgoblin", count: 2 },
    ],
    battlefield: "a hall",
    map: { mapId: null, scene: null, seed: null, theme: null, ambient: null, width: null, height: null, ...map },
    notes: name,
    extras: { placements: [], entry: null, hidden: [], overrides: [], ...extras },
    createdByUserId: world.owner.id,
  });

const run = (args) => {
  const sheets = listSheets(world.campaignId);
  return dispatchAdjudication("run_prepared_encounter", JSON.stringify(args), {
    campaign: world.campaign(),
    turn: createDmTurn(world.campaignId, [], "ai"),
    sheets,
    sheetsById: new Map(sheets.map((sheet) => [sheet.id, sheet])),
    realDiceUserIds: new Set(),
  });
};

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// What the board looks like, for a failure message.
function picture(map, tokens) {
  const mark = new Map(tokens.map((token) => [tileIndex(map.width, token.x, token.y), token.kind === "pc" ? token.name[0] : "e"]));
  return Array.from({ length: map.height }, (_, y) =>
    Array.from({ length: map.width }, (_, x) => mark.get(tileIndex(map.width, x, y)) ?? map.terrain[tileIndex(map.width, x, y)]).join(""),
  ).join("\n");
}

// The party's opening: a 2 by 2 block, front rank (fighter and rogue)
// nearer the enemy than the rear, nobody in an enemy's reach, everyone on
// open ground.
function checkOpening(label, expect = {}) {
  const map = getBattleMapForEncounter(world.encounter().id);
  const tokens = listTokens(map.id);
  const pcs = tokens.filter((token) => token.kind === "pc");
  const foes = tokens.filter((token) => token.kind === "enemy");
  const at = (id) => pcs.find((token) => token.refId === id);
  const board = `\n${label}\n${picture(map, tokens)}`;
  assert.equal(pcs.length, 4, board);
  for (const token of pcs) {
    assert.ok(!blocksMove(map.terrain[tileIndex(map.width, token.x, token.y)]), `${token.name} stands in a wall${board}`);
    assert.ok(foes.every((foe) => cheb(foe, token) > 1), `${token.name} opens in an enemy's reach${board}`);
  }
  const xs = pcs.map((token) => token.x);
  const ys = pcs.map((token) => token.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) <= 1 && Math.max(...ys) - Math.min(...ys) <= 1, `not a 2x2 block${board}`);
  const foeMiddle = {
    x: foes.reduce((sum, foe) => sum + foe.x, 0) / foes.length,
    y: foes.reduce((sum, foe) => sum + foe.y, 0) / foes.length,
  };
  const reachOf = (id) => Math.hypot(at(id).x - foeMiddle.x, at(id).y - foeMiddle.y);
  for (const f of front) {
    for (const r of rear) {
      assert.ok(reachOf(f) < reachOf(r), `${at(f).name} should stand in front of ${at(r).name}${board}`);
    }
  }
  if (expect.near) {
    assert.ok(cheb(at(fighter.id), expect.near) <= 3, `the fighter should open near ${JSON.stringify(expect.near)}${board}`);
  }
  if (expect.distance) {
    const nearest = Math.min(...pcs.flatMap((pc) => foes.map((foe) => cheb(pc, foe))));
    assert.ok(Math.abs(nearest - expect.distance) <= 1, `nearest enemy ${nearest} tiles, wanted ${expect.distance}${board}`);
  }
}

function next() {
  const active = world.encounter();
  if (active) endEncounter(active.id, "test");
}

setParty(world.campaignId, { ...getParty(world.campaignId), marchingOrder: [fighter.id, rogue.id, cleric.id, warlock.id] });

const placements = [
  { slot: 0, x: 21, y: 5 },
  { slot: 1, x: 21, y: 8 },
  { slot: 2, x: 22, y: 6 },
  { slot: 3, x: 22, y: 7 },
];

template("Hall, from the door", { placements, entry: { x: 4, y: 6 } });
template("Hall, no door", { placements });
template("Hall, all over the place", {});
template("Hall, at the pillars", { placements, entry: { x: 15, y: 6 } });
template("Studio ground", { entry: { x: 3, y: 7 } }, { mapId: null, seed: 4242, theme: "interior" });

await test("a saved map with an entry point: the formation at the door, fighter and rogue in front", async () => {
  const result = await run({ name: "Hall, from the door" });
  assert.equal(result.error, undefined, JSON.stringify(result));
  checkOpening("door", { near: { x: 4, y: 6 } });
  next();
});

await test("a saved map with no entry point: the party in its ranks, facing the enemy", async () => {
  const result = await run({ name: "Hall, no door" });
  assert.equal(result.error, undefined, JSON.stringify(result));
  checkOpening("no door");
  next();
});

await test("a saved map with no entry point and no placements still opens in formation", async () => {
  const result = await run({ name: "Hall, all over the place" });
  assert.equal(result.error, undefined, JSON.stringify(result));
  checkOpening("no plan");
  next();
});

await test("an entry point close to the enemy: the block stands whole, out of reach", async () => {
  const result = await run({ name: "Hall, at the pillars" });
  assert.equal(result.error, undefined, JSON.stringify(result));
  checkOpening("pillars", { near: { x: 15, y: 6 } });
  next();
});

await test("the distance the story asks for is kept on a saved map with no entry point", async () => {
  const result = await run({ name: "Hall, no door", distanceFeet: 30 });
  assert.equal(result.error, undefined, JSON.stringify(result));
  checkOpening("30 ft", { distance: 6 });
  next();
});

await test("a prepared fight on generated ground with an entry point opens in formation too", async () => {
  const result = await run({ name: "Studio ground" });
  assert.equal(result.error, undefined, JSON.stringify(result));
  checkOpening("studio");
  next();
});

await test("only the fighter placed in the formation: he still takes the front", async () => {
  setParty(world.campaignId, { ...getParty(world.campaignId), marchingOrder: [fighter.id] });
  const result = await run({ name: "Hall, from the door" });
  assert.equal(result.error, undefined, JSON.stringify(result));
  const map = getBattleMapForEncounter(world.encounter().id);
  const tokens = listTokens(map.id);
  const foes = tokens.filter((token) => token.kind === "enemy");
  const pcs = tokens.filter((token) => token.kind === "pc");
  const gap = (token) => Math.min(...foes.map((foe) => Math.hypot(foe.x - token.x, foe.y - token.y)));
  const bruce = pcs.find((token) => token.refId === fighter.id);
  assert.ok(pcs.every((token) => gap(bruce) <= gap(token)), `\n${picture(map, tokens)}`);
  next();
});

finish();
