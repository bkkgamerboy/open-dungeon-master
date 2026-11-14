// An ambusher in a prepared fight (extras.hidden) opens off the party's map
// and their turn order. At an AI-run table nothing used to bring it back:
// the AI DM had no tool for it, the board's Reveal button is the human DM's,
// and an ambusher that attacked stayed hidden, so the party fought enemies
// they could not see for the whole fight. Now it shows itself when it
// attacks, casts or is struck (src/lib/dm/reveal.ts), the AI DM can reveal
// it (reveal_enemy), and GAME STATE marks it so the DM knows.
//
// Also here: a new campaign has no travel formation, and with none set the
// party used to open in the order the characters joined, so casters made
// first stood at the front. Now the heaviest armour opens at the front.

import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-ambush-reveal");
const { dispatchAdjudication } = await import("../src/lib/dm/invoke-dispatch.ts");
const { createDmTurn } = await import("../src/lib/db/dm-turns.ts");
const { listSheets } = await import("../src/lib/db/sheets.ts");
const { getBattleMapForEncounter, listTokens, placeToken } = await import("../src/lib/db/battle-maps.ts");
const { insertEncounterTemplate } = await import("../src/lib/db/encounter-templates.ts");
const { createPreparedMap } = await import("../src/lib/db/prepared-maps.ts");
const { endEncounter, listEnemies, saveEncounter } = await import("../src/lib/db/encounters.ts");
const { activePublicEncounter } = await import("../src/lib/db/encounter-view.ts");
const { buildPlayerMapView } = await import("../src/lib/battlemap/view.ts");
const { serializeMapForPrompt } = await import("../src/lib/battlemap/serialize.ts");
const { handleEnemyAttack } = await import("../src/lib/dm/enemy-attack.ts");
const { applyEnemyDamage } = await import("../src/lib/dm/enemy-damage.ts");
const { getParty, setParty } = await import("../src/lib/db/party.ts");
const logic = await import("../src/lib/dm/formation-logic.ts");

const world = await openWorld({ gameSettings: { dmMode: "ai" } });
// Made in this order on purpose, as the Pirate Queen table joined: the
// fighter last, so roster order would put the rogue and the cleric in front.
// Their armour as worn: plate and a shield, chain and a shield, studded
// leather, leather.
const rogue = world.addHero({ class: "rogue", level: 8, name: "Swift", ac: 15 });
world.addHero({ class: "cleric", level: 8, name: "Isabel", ac: 18 });
world.addHero({ class: "warlock", level: 8, name: "Kramer", ac: 13 });
const fighter = world.addHero({ class: "fighter", level: 8, name: "Bruce", ac: 20 });

// A narrow alley opening into a yard: the party comes in from the west,
// the ambushers wait in the yard to the east.
const W = 22;
const H = 12;
const rows = Array.from({ length: H }, (_, y) =>
  Array.from({ length: W }, (_, x) => {
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return "#";
    if (x <= 8 && (y < 4 || y > 7)) return "#";
    return ".";
  }).join(""),
);
const alley = createPreparedMap({
  campaignId: world.campaignId,
  name: "Shadowy alley",
  width: W,
  height: H,
  terrain: rows.join(""),
  // Lit, so what the party sees turns on hiding alone, not on darkvision.
  ambient: "bright",
  theme: "interior",
});

insertEncounterTemplate({
  campaignId: world.campaignId,
  name: "The Shadowy Alley",
  enemies: [{ monster: "ghast", count: 3 }, { monster: "ghoul", count: 1 }],
  battlefield: "a blind yard off the alley",
  map: { mapId: alley.id, scene: null, seed: null, theme: null, ambient: null, width: null, height: null },
  notes: "ambush",
  extras: {
    placements: [
      { slot: 0, x: 15, y: 4 },
      { slot: 1, x: 15, y: 7 },
      { slot: 2, x: 17, y: 5 },
      { slot: 3, x: 17, y: 6 },
    ],
    entry: { x: 3, y: 5 },
    hidden: [0, 1, 2, 3],
    overrides: [],
  },
  createdByUserId: world.owner.id,
});

const context = () => {
  const sheets = listSheets(world.campaignId);
  return {
    campaign: world.campaign(),
    turn: createDmTurn(world.campaignId, [], "ai"),
    sheets,
    sheetsById: new Map(sheets.map((sheet) => [sheet.id, sheet])),
    realDiceUserIds: new Set(),
  };
};
const invoke = (name, args) => dispatchAdjudication(name, JSON.stringify(args), context());

const board = () => {
  const map = getBattleMapForEncounter(world.encounter().id);
  return { map, tokens: listTokens(map.id) };
};
// What the party lead's phone shows: no DM seat at an AI-run table.
const partySees = () => {
  const view = buildPlayerMapView(world.campaignId, world.owner.id, { fullVision: false });
  return view.tokens.filter((token) => token.kind === "enemy").map((token) => token.refId);
};
const trackerShows = () =>
  (activePublicEncounter(world.campaignId)?.enemies ?? []).map((enemy) => enemy.id);
const enemies = () => listEnemies(world.encounter().id).filter((enemy) => enemy.status === "alive");
const tokenOf = (refId) => board().tokens.find((token) => token.refId === refId);
// Sets an enemy down beside a character: a free floor tile next to them.
const besides = (enemyId, characterId) => {
  const { map, tokens } = board();
  const pc = tokens.find((token) => token.refId === characterId);
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = pc.x + dx;
      const y = pc.y + dy;
      if ((dx || dy) && map.terrain[y * map.width + x] === "." && !tokens.some((t) => t.x === x && t.y === y)) {
        placeToken(tokenOf(enemyId).id, x, y);
        return;
      }
    }
  }
  throw new Error(`no free tile beside ${pc.name}`);
};
const attack = (enemyId, targetCharacterId) => {
  const sheets = listSheets(world.campaignId);
  return handleEnemyAttack(
    world.campaign(),
    createDmTurn(world.campaignId, [], "ai"),
    JSON.stringify({ enemyId, targetCharacterId }),
    sheets,
    new Map(sheets.map((sheet) => [sheet.id, sheet])),
  );
};

const clear = () => {
  const active = world.encounter();
  if (active) endEncounter(active.id, "test");
};

await test("the pure rule: the higher armour class first, then hit points, then the order they joined", () => {
  const sheets = [
    { id: "a", name: "A", ac: 13, maxHp: 40 },
    { id: "b", name: "B", ac: 18, maxHp: 60 },
    { id: "c", name: "C", ac: 13, maxHp: 50 },
    { id: "d", name: "D" },
    { id: "e", name: "E", ac: 13, maxHp: 50 },
  ];
  assert.deepEqual(logic.armorFirst(["a", "b", "c", "d", "e"], sheets), ["b", "c", "e", "a", "d"]);
  const none = logic.placeByFormation(sheets.slice(0, 3), [{ x: 3, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 }], [{ x: 9, y: 1 }], []);
  assert.deepEqual(none.spots.get("b"), { x: 3, y: 1 }, "the heaviest armour takes the tile nearest the enemy");
  assert.match(none.line, /No travel formation is set, so the party starts with the heaviest armour at the front: B, C, A\./);
  // A formation the party set still rules: armour only orders the rest.
  const set = logic.placeByFormation(sheets.slice(0, 3), [{ x: 3, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 }], [{ x: 9, y: 1 }], ["a"]);
  assert.deepEqual(set.spots.get("a"), { x: 3, y: 1 });
  assert.deepEqual(set.spots.get("b"), { x: 2, y: 1 });
});

await test("no travel formation: a prepared fight opens with the best armoured in the front rank, not whoever joined first", async () => {
  clear();
  setParty(world.campaignId, { ...getParty(world.campaignId), marchingOrder: [], formationChange: null });
  const result = await invoke("run_prepared_encounter", { name: "The Shadowy Alley" });
  assert.equal(result.error, undefined, JSON.stringify(result));
  const { tokens } = board();
  const foes = tokens.filter((token) => token.kind === "enemy");
  const pcs = tokens.filter((token) => token.kind === "pc");
  const gap = (token) => Math.min(...foes.map((foe) => Math.hypot(foe.x - token.x, foe.y - token.y)));
  const sheets = listSheets(world.campaignId);
  const byArmour = [...sheets].sort((a, b) => b.ac - a.ac || b.maxHp - a.maxHp);
  const frontIds = byArmour.slice(0, 2).map((sheet) => sheet.id);
  const rearIds = byArmour.slice(2).map((sheet) => sheet.id);
  const at = (id) => pcs.find((token) => token.refId === id);
  const acs = sheets.map((sheet) => `${sheet.name} AC ${sheet.ac}`).join(", ");
  for (const f of frontIds) {
    for (const r of rearIds) {
      assert.ok(gap(at(f)) < gap(at(r)), `${at(f).name} should stand in front of ${at(r).name} (${acs})`);
    }
  }
  assert.deepEqual(
    pcs.filter((token) => frontIds.includes(token.refId)).map((token) => token.name).sort(),
    ["Bruce", "Isabel"],
    `the fighter and the cleric take the front rank (${acs})`,
  );
});

await test("an ambush opens off the party's map and turn order, and GAME STATE tells the DM", () => {
  const ids = enemies().map((enemy) => enemy.id);
  assert.equal(ids.length, 4);
  assert.ok(board().tokens.filter((token) => token.kind === "enemy").every((token) => token.hidden), "every ambusher opens hidden");
  assert.deepEqual(partySees(), [], "the party's map shows none of them");
  assert.ok(ids.every((id) => !trackerShows().includes(id)), "nor does their turn order");
  const { map, tokens } = board();
  const text = serializeMapForPrompt(map, tokens);
  assert.equal((text.match(/\[hidden from the party\]/g) ?? []).length, 4, text);
});

await test("an ambusher that charges out gives itself away, even when it falls short", () => {
  const [ghast] = enemies();
  // From the back of the yard the rear rank is beyond one move: it walks
  // out and cannot strike, but everyone saw it come.
  const result = attack(ghast.id, rogue.id);
  assert.match(String(result.error), /cannot reach them this turn; it moved to/, JSON.stringify(result));
  assert.equal(tokenOf(ghast.id).hidden, false);
  assert.ok(partySees().includes(ghast.id), "the party sees it on the map");
  assert.ok(trackerShows().includes(ghast.id), "it joins their turn order");
  assert.match(String(result.revealed), /was hidden from the party and gives itself away by acting/);
});

await test("an ambusher that attacks from hiding is revealed as it strikes, and the rest stay hidden", () => {
  const [, ghast] = enemies();
  besides(ghast.id, fighter.id);
  assert.equal(tokenOf(ghast.id).hidden, true);
  const result = attack(ghast.id, fighter.id);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.ok(Array.isArray(result.swings) && result.swings.length > 0, JSON.stringify(result));
  assert.equal(tokenOf(ghast.id).hidden, false);
  assert.ok(partySees().includes(ghast.id));
  assert.match(String(result.revealed), /gives itself away by acting/);
  const others = enemies().filter((enemy) => tokenOf(enemy.id).hidden);
  assert.equal(others.length, 2, "the two that have not acted stay hidden");
  // Once seen, a second attack says nothing about it.
  assert.equal(attack(ghast.id, fighter.id).revealed, undefined);
});

await test("a hidden enemy struck is revealed; one that only shrugs off nothing stays hidden", () => {
  const hidden = enemies().filter((enemy) => tokenOf(enemy.id).hidden);
  const target = hidden[0];
  const sheets = listSheets(world.campaignId);
  const result = applyEnemyDamage(
    world.campaign(),
    createDmTurn(world.campaignId, [], "ai"),
    world.encounter(),
    target,
    3,
    sheets,
    new Map(sheets.map((sheet) => [sheet.id, sheet])),
    "radiant",
  );
  assert.equal(tokenOf(target.id).hidden, false);
  assert.match(String(result.revealed), /is struck and shows where it is/);
  const untouched = hidden[1];
  applyEnemyDamage(world.campaign(), createDmTurn(world.campaignId, [], "ai"), world.encounter(), untouched, 0, sheets, new Map(sheets.map((sheet) => [sheet.id, sheet])));
  assert.equal(tokenOf(untouched.id).hidden, true, "no damage, no reveal");
});

await test("a hidden enemy killed outright is revealed and its death plays in view", () => {
  const hidden = enemies().filter((enemy) => tokenOf(enemy.id).hidden);
  const target = hidden[0];
  const sheets = listSheets(world.campaignId);
  const result = applyEnemyDamage(
    world.campaign(),
    createDmTurn(world.campaignId, [], "ai"),
    world.encounter(),
    target,
    999,
    sheets,
    new Map(sheets.map((sheet) => [sheet.id, sheet])),
    "radiant",
    { magical: true },
  );
  assert.equal(result.dead, true, JSON.stringify(result));
  assert.equal(result.revealed, undefined, "a dead enemy is not announced as newly on the map");
});

await test("in a fresh ambush, reveal_enemy by name reveals that one alone", async () => {
  clear();
  const result = await invoke("run_prepared_encounter", { name: "The Shadowy Alley" });
  assert.equal(result.error, undefined, JSON.stringify(result));
  const [first] = enemies();
  const named = await invoke("reveal_enemy", { enemyId: tokenOf(first.id).name, reason: "Swift spots it" });
  assert.equal(named.error, undefined, JSON.stringify(named));
  assert.deepEqual(named.revealed, [tokenOf(first.id).name]);
  assert.equal(tokenOf(first.id).hidden, false);
  assert.ok(partySees().includes(first.id));
  assert.equal(enemies().filter((enemy) => tokenOf(enemy.id).hidden).length, 3, "only the one named is revealed");
  const again = await invoke("reveal_enemy", { enemyId: first.id });
  assert.match(again.note, /already in the party's view/);
});

await test("a character's swing at a hidden enemy shows where it is", async () => {
  const [target] = enemies().filter((enemy) => tokenOf(enemy.id).hidden);
  besides(target.id, fighter.id);
  // Bruce's turn: off it, a character attacks only with a reaction.
  const encounter = world.encounter();
  saveEncounter({ ...encounter, turnIndex: encounter.order.findIndex((entry) => entry.characterId === fighter.id) });
  // As the table invokes it (src/lib/dm/invoke.ts), the swing already declared.
  const swing = await world.invoke("pc_attack", { characterId: fighter.id, targetEnemyId: target.id });
  assert.equal(swing.error, undefined, JSON.stringify(swing));
  assert.equal(tokenOf(target.id).hidden, false, JSON.stringify(swing));
  assert.equal(swing.ok, true, JSON.stringify(swing));
  assert.match(String(swing.result.revealed), /is struck and shows where it is/);
  assert.equal(enemies().filter((enemy) => tokenOf(enemy.id).hidden).length, 2, "the other two are still hidden");
});

await test("reveal_enemy 'all' brings the rest into view, and says so when none is hidden", async () => {
  const hidden = enemies().filter((enemy) => tokenOf(enemy.id).hidden);
  const result = await invoke("reveal_enemy", { enemyId: "all", reason: "Isabel's light falls on them" });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual([...result.revealed].sort(), hidden.map((enemy) => tokenOf(enemy.id).name).sort());
  assert.ok(enemies().every((enemy) => partySees().includes(enemy.id)), "every enemy is on the party's map");
  assert.ok(enemies().every((enemy) => trackerShows().includes(enemy.id)), "and in their turn order");
  const { map, tokens } = board();
  assert.doesNotMatch(serializeMapForPrompt(map, tokens), /\[hidden from the party\]/);
  const none = await invoke("reveal_enemy", { enemyId: "all" });
  assert.equal(none.ok, true);
  assert.match(none.note, /No enemy in this fight is hidden/);
  const unknown = await invoke("reveal_enemy", { enemyId: "nobody" });
  assert.match(unknown.error, /Unknown enemyId/);
  clear();
});

await finish();
