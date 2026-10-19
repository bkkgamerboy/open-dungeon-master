// A companion's level-up, built by whoever runs the story (build 15).
//
// Companions used to level the moment their experience crossed a threshold,
// with the engine's picks and never a subclass. Held here:
//
//   at a table whose companion level-ups are the lead's (the default), an
//   award that earns a party companion a level announces it and leaves the
//   level for the lead; the lead takes it through the same level-up a player
//   sends (PATCH /sheet naming companionId), subclass included; nobody else
//   may; a guest still levels on its own; and a table set to automatic
//   levels its companions as before.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-companion-level-choice");

const world = await openWorld({ gameSettings: { companions: "full", maxCompanions: 3 }, campaign: { startingLevel: 3 } });
const { createSheetSchema } = await import("../src/lib/schemas/sheet.ts");
const { finalizeNewCompanion } = await import("../src/lib/dm/companion-tools.ts");
const campaigns = await import("../src/lib/db/campaigns.ts");

function draft(name, klass = "fighter") {
  return createSheetSchema.parse({
    name,
    race: "human",
    class: klass,
    subclass: "",
    background: "soldier",
    alignment: "neutral",
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
    maxHp: 28,
    ac: 16,
    hitDice: { die: "d10", total: 3, spent: 0 },
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

async function levelUp(user, body) {
  const route = await world.route("campaigns/[campaignId]/sheet");
  world.signIn(user);
  const response = await route.PATCH(
    new Request("http://test/", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  return { status: response.status, json: await response.json() };
}

world.addHero({ name: "Lead Hero", level: 3 });
const { sheet: mira } = finalizeNewCompanion(world.campaign(), 3, draft("Mira"), "party", "");
const { sheet: guard } = finalizeNewCompanion(world.campaign(), 3, draft("Guard"), "guest", "");

await test("the default table leaves a party companion's level for the lead", async () => {
  assert.equal(world.campaign().gameSettings.companionLevelUps, "lead");
  const result = await world.invoke("award_xp", { characterIds: [mira.id, guard.id], amount: 2700, reason: "the crypt" });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(world.sheet(mira.id).level, 3, "Mira waits");
  assert.equal(world.sheet(mira.id).xp >= 2700, true);
  assert.equal(world.sheet(guard.id).level, 4, "a guest levels on its own");
});

await test("nobody but whoever runs the story builds it", async () => {
  const player = world.addUser("player");
  world.addHero({ user: player, name: "Player Hero", level: 3 });
  const { status } = await levelUp(player, { companionId: mira.id, level: 4, levelUpClass: "fighter" });
  assert.equal(status, 403);
  assert.equal(world.sheet(mira.id).level, 3);
});

await test("the lead takes the level with their own choices, subclass included", async () => {
  const { status, json } = await levelUp(world.owner, {
    companionId: mira.id,
    level: 4,
    levelUpClass: "fighter",
    subclass: "Champion",
    asiChoices: [{ mode: "plus2", ability: "str" }],
  });
  assert.equal(status, 200, json.error);
  const after = world.sheet(mira.id);
  assert.equal(after.level, 4);
  assert.equal(after.subclass, "Champion");
  assert.equal(after.abilities.str, 18);
  assert.ok(after.maxHp > 28, `hit points grew (${after.maxHp})`);
  assert.equal(after.isCompanion, true, "still the DM's to play");
});

await test("only a level-up passes this door for a companion", async () => {
  const { status } = await levelUp(world.owner, { companionId: mira.id, notes: "rewritten" });
  assert.equal(status, 403);
});

await test("a table set to automatic levels its companions as before", async () => {
  const current = world.campaign().gameSettings;
  campaigns.updateGameSettings(world.campaignId, { ...current, companionLevelUps: "auto" });
  assert.equal(world.campaign().gameSettings.companionLevelUps, "auto");
  const { sheet: tam } = finalizeNewCompanion(world.campaign(), 3, draft("Tam"), "party", "");
  await world.invoke("award_xp", { characterIds: [tam.id], amount: 2700, reason: "the crypt" });
  assert.equal(world.sheet(tam.id).level, 4);
  const refused = await levelUp(world.owner, { companionId: tam.id, level: 5, levelUpClass: "fighter" });
  assert.equal(refused.status, 403);
});

finish();
