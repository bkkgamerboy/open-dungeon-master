// Build 38.
//
// 1. An enemy asleep when the party attacks it starts the fight surprised.
//    Ssethra lay coiled asleep in her shrine (the pack's notes say she
//    sleeps by day); Isabel opened with Fireball and the fight began with
//    no surprise at all.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { call } from "./lib/enforce-campaign.mjs";

const { test, finish } = suite("test-build38");

const world = await openWorld({
  gameSettings: { dmMode: "ai", companions: "full", maxCompanions: 4, multiCharacter: "on", maxCharactersPerPlayer: 4 },
  campaign: { startingLevel: 9 },
});
const { sleepersAmong } = await import("../src/lib/dm/encounter-open.ts");
const { dispatchAdjudication } = await import("../src/lib/dm/invoke-dispatch.ts");
const { createDmTurn } = await import("../src/lib/db/dm-turns.ts");
const { listSheets } = await import("../src/lib/db/sheets.ts");
const { insertEncounterTemplate } = await import("../src/lib/db/encounter-templates.ts");
const { dice, clearDice } = await import("./lib/enforce-world.mjs");

world.addHero({ class: "cleric", level: 9, name: "Isabel", ac: 18, maxHp: 70 });
const swift = world.addHero({ class: "rogue", level: 9, name: "Swift", ac: 16, maxHp: 60 });
world.addHero({ class: "fighter", level: 9, name: "Bruce", ac: 20, maxHp: 103 });
world.addHero({ class: "warlock", level: 9, name: "Kramer", ac: 14, maxHp: 66 });

const endFight = () => world.invoke("end_encounter", { outcome: "truce" });

await test("A sleeping enemy named in asleep starts surprised; the guards awake beside it do not", async () => {
  const encounter = await world.beginFight(
    [{ monster: "spirit-naga" }, { monster: "lizardfolk", count: 2 }],
    { asleep: ["spirit naga"] },
  );
  try {
    const naga = world.enemies().find((enemy) => enemy.slug === "spirit-naga");
    assert.deepEqual(encounter.surprisedIds, [naga.id]);
  } finally {
    await endFight();
  }
});

// The AI's own path, as the storyteller calls it.
const asAi = (name, args) => {
  const sheets = listSheets(world.campaignId);
  return dispatchAdjudication(name, JSON.stringify(args), {
    campaign: world.campaign(),
    turn: createDmTurn(world.campaignId, [], "ai"),
    sheets,
    sheetsById: new Map(sheets.map((sheet) => [sheet.id, sheet])),
    realDiceUserIds: new Set(),
  });
};

insertEncounterTemplate({
  campaignId: world.campaignId,
  name: "The Shrine of the Coiled One",
  enemies: [{ monster: "spirit-naga", count: 1 }, { monster: "lizardfolk", count: 2 }],
  battlefield: "A domed hall with a sunken pit.",
  map: { mapId: null, scene: null, seed: null, theme: null, ambient: null, width: null, height: null },
  notes: "Ssethra sleeps coiled in the pit by day.",
  extras: { placements: [], entry: null, hidden: [], overrides: [{ slot: 0, name: "Ssethra the Time-Coiled" }] },
  createdByUserId: world.owner.id,
});

await test("A prepared fight's sleeper is found by the name the fight gives her, and loses her first turn even going first", async () => {
  clearDice();
  // The naga rolls a 20 for initiative and the lizardfolk 1s; every hero 10.
  dice(20, 1, 1, 10, 10, 10, 10);
  const opened = await asAi("run_prepared_encounter", { name: "The Shrine of the Coiled One", asleep: ["Ssethra"] });
  clearDice();
  try {
    assert.equal(opened.error, undefined, JSON.stringify(opened));
    const naga = world.enemies().find((enemy) => /Ssethra/.test(enemy.displayName));
    assert.ok(naga, world.enemies().map((enemy) => enemy.displayName).join(", "));
    assert.deepEqual(world.encounter().surprisedIds, [naga.id]);
    assert.match(String(opened.asleep), /Ssethra the Time-Coiled is asleep and surprised/);
    // Her first turn is not hers to take.
    const [hero] = listSheets(world.campaignId);
    clearDice();
    dice(20, 6, 6, 6);
    const bite = await asAi("enemy_attack", { enemyId: naga.id, targetCharacterId: hero.id });
    clearDice();
    assert.match(JSON.stringify(bite), /surprised/);
    assert.equal(world.sheet(hero.id).currentHp, world.sheet(hero.id).maxHp, "the sleeper struck in round 1");
  } finally {
    await endFight();
  }
});

await test("Asleep by monster, as one name, works too", async () => {
  const encounter = await world.beginFight([{ monster: "lizardfolk", count: 2 }], { asleep: "lizardfolk" });
  assert.equal(encounter.surprisedIds.length, 2);
  await endFight();
});

await test("Asleep adds to an ambush and never takes a surprised hero off the list", async () => {
  // Everyone surprised would pass round 1 at once: Swift has Alert.
  world.patch(swift.id, { feats: ["Alert"] });
  const encounter = await world.beginFight([{ monster: "lizardfolk" }, { monster: "spirit-naga" }], {
    surprised: "party",
    asleep: ["lizardfolk"],
  });
  try {
    const lizard = world.enemies().find((enemy) => enemy.slug === "lizardfolk");
    assert.ok(encounter.surprisedIds.includes(lizard.id));
    assert.equal(encounter.surprisedIds.length, 4, "three heroes and the sleeper");
    assert.ok(!encounter.surprisedIds.includes(swift.id));
  } finally {
    await endFight();
  }
});

await test("A name that matches nobody is reported, not guessed", () => {
  const out = sleepersAmong(["the dragon"], [{ id: "a", displayName: "Lizardfolk", slug: "lizardfolk" }]);
  assert.deepEqual(out.ids, []);
  assert.match(out.lines.join(" "), /No enemy .* "the dragon"/);
  const naga = sleepersAmong(["the naga"], [
    { id: "n", displayName: "Ssethra the Time-Coiled", slug: "spirit-naga" },
    { id: "l", displayName: "Lizardfolk", slug: "lizardfolk" },
  ]);
  assert.deepEqual(naga.ids, ["n"]);
  assert.match(naga.lines[0], /Ssethra the Time-Coiled is asleep and surprised/);
});

await test("The DM is told that a sleeper is surprised and how to say so", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/lib/dm/prompt-rules.ts", import.meta.url), "utf8");
  assert.match(source, /asleep when the party attacks it/);
});

// 4. Flanking is on for a new campaign unless its maker switches it off.
// draft.ts pulls in a component for one constant (see test-world-portals),
// so its default is read from the source.
await test("A new campaign's draft has flanking on", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/app/create-campaign/draft.ts", import.meta.url), "utf8");
  const rules = source.slice(source.indexOf("variantRules: {"), source.indexOf("restVariant"));
  assert.match(rules, /flanking: true/);
});

// 3. Every party sets out with a mule.
await test("A campaign made through the app starts with a mule in the party, made once", async () => {
  const { getParty } = await import("../src/lib/db/party.ts");
  const { giveStartingMule } = await import("../src/lib/dm/party-pack.ts");
  const campaignsRoute = await world.route("campaigns");
  world.signIn(world.owner);
  const created = await call(campaignsRoute, "POST", { title: "Next Chapter" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const party = getParty(created.json.campaign.id);
  assert.equal(party.packAnimals.length, 1);
  assert.equal(party.packAnimals[0].kind, "mule");
  assert.equal(party.packAnimals[0].carry, 420);
  // Given once: a party that already leads one gets no second.
  giveStartingMule(created.json.campaign.id);
  assert.equal(getParty(created.json.campaign.id).packAnimals.length, 1);
});

// 7. A hero enters a new campaign rested.
await test("A library hero who ended the last story spent enters the next one rested", async () => {
  const { createSheetSchema } = await import("../src/lib/schemas/sheet.ts");
  const characters = await import("../src/lib/db/characters.ts");
  const player = world.addUser("isabel");
  const spent = createSheetSchema.parse({
    name: "Isabel",
    race: "human",
    class: "cleric",
    subclass: "",
    background: "acolyte",
    alignment: "neutral good",
    abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 18, cha: 12 },
    maxHp: 30,
    ac: 16,
    hitDice: { die: "d8", total: 3, spent: 3 },
    proficiencies: { saves: ["wis", "cha"], skills: [], expertise: [], languages: ["Common"], tools: [], armor: ["light", "medium", "shields"], weapons: ["simple"] },
    equipment: [
      { name: "Staff of Healing", qty: 1, attuned: true, charges: 2 },
      { name: "Mace", qty: 1 },
    ],
    spellcasting: { ability: "wis", slots: { 1: { max: 4, used: 4 }, 2: { max: 2, used: 2 } }, known: [], prepared: [] },
  });
  const row = characters.createCharacter(player.id, 3, spent, "pc");
  const sheet = characters.instantiateIntoCampaign(row.id, world.campaignId, player.id, 3);
  assert.equal(sheet.error, undefined, JSON.stringify(sheet));
  assert.equal(sheet.hitDice.spent, 0, "hit dice");
  assert.deepEqual(Object.values(sheet.spellcasting.slots).map((slot) => slot.used), [0, 0], "spell slots");
  const staff = sheet.equipment.find((item) => item.name === "Staff of Healing");
  assert.equal(staff.charges, undefined, "the staff is full (a row with no count is)");
  assert.equal(sheet.currentHp, sheet.maxHp);
  assert.deepEqual(sheet.conditions, []);
  assert.equal(sheet.exhaustion ?? 0, 0);
});

// 2. The hand goes away while the enemies take their turns.
await test("The hand puts itself away for the enemies' turns and comes back on the player's turn", async () => {
  const { handAwayStep } = await import("../src/lib/battlemap/hand-table.ts");
  let memory = { turnKey: "", enemyTurns: false, reopenOwed: false };
  let collapsed = false;
  let auto = false;
  const step = (now) => {
    const out = handAwayStep(memory, { ...now, collapsed, autoCollapsed: auto });
    memory = out.memory;
    if (out.putAway) [collapsed, auto] = [true, true];
    if (out.bringBack) [collapsed, auto] = [false, false];
    return out;
  };
  step({ turnKey: "1:swift", enemyTurns: false, myTurn: true });
  assert.equal(collapsed, false, "Swift's turn: the hand is out");
  // Swift ends; the pointer moves on to Bruce, held while the enemies act.
  step({ turnKey: "1:bruce", enemyTurns: true, myTurn: false });
  assert.equal(collapsed, true, "the enemies' turns put it away");
  // The floor comes back a beat after the enemies finish.
  step({ turnKey: "1:bruce", enemyTurns: false, myTurn: false });
  assert.equal(collapsed, true, "not yet: the turn is not the player's on this screen yet");
  step({ turnKey: "1:bruce", enemyTurns: false, myTurn: true });
  assert.equal(collapsed, false, "Bruce's turn: the hand is back");
  // A card played puts it away (build 24); the same turn does not bring it back.
  [collapsed, auto] = [true, true];
  step({ turnKey: "1:bruce", enemyTurns: false, myTurn: false });
  step({ turnKey: "1:bruce", enemyTurns: false, myTurn: true });
  assert.equal(collapsed, true, "the DM's reply to the card can be read");
  // A hand its player put away stays away through everything.
  [collapsed, auto] = [true, false];
  step({ turnKey: "2:swift", enemyTurns: true, myTurn: false });
  step({ turnKey: "2:swift", enemyTurns: false, myTurn: true });
  assert.equal(collapsed, true);
});

// 5. A table of one has no voice call and no X-card.
await test("A one-person table shows no voice-call button and no X-card", async () => {
  const { readFileSync } = await import("node:fs");
  const view = readFileSync(new URL("../src/app/campaigns/[campaignId]/SessionView.tsx", import.meta.url), "utf8");
  assert.match(view, /const soloTable = state\.members\.length <= 1;/);
  assert.match(view, /voice=\{soloTable \? undefined : voice\}/);
  assert.match(view, /xCard && !soloTable \? raiseXCard : undefined/);
  const header = readFileSync(new URL("../src/app/campaigns/[campaignId]/SessionHeader.tsx", import.meta.url), "utf8");
  assert.match(header, /\{voice \? <VoiceDock \{\.\.\.voice\} \/> : null\}/);
});

// 6. A new place's name goes up full screen.
await test("Arriving somewhere new puts its name up once; a return does not, and the DM's own card for it is not shown twice", async () => {
  const { subscribe } = await import("../src/lib/events.ts");
  const { handleLocationCall } = await import("../src/lib/dm/turn.ts");
  const { handleShowTitle } = await import("../src/lib/dm/world-tools.ts");
  const cards = [];
  const stop = subscribe(world.campaignId, (chunk) => {
    if (/^event: title_card$/m.test(chunk)) {
      cards.push(JSON.parse(/^data: (.+)$/m.exec(chunk)[1]).title);
    }
  });
  try {
    const move = (name) => handleLocationCall(world.campaign(), "move_party", JSON.stringify({ name }), false);
    move("The Hall of Feathers");
    move("The Shrine of the Coiled One");
    assert.deepEqual(cards, ["The Hall of Feathers", "The Shrine of the Coiled One"]);
    // The DM calls show_title for the same arrival: one card, not two.
    handleShowTitle(world.campaign(), JSON.stringify({ title: "The Shrine of the Coiled One" }));
    assert.equal(cards.length, 2);
    // Back to a room already seen: no card.
    move("The Hall of Feathers");
    assert.equal(cards.length, 2);
  } finally {
    stop();
  }
  // The card is drawn full screen even when the phone asks for less motion.
  const { readFileSync } = await import("node:fs");
  const card = readFileSync(new URL("../src/components/SceneTitle.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(card, /if \(reduced\) \{\s*return/);
});

finish();
