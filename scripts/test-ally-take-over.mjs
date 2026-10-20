// "Play this ally yourself" and its way back, through the real routes.
//
// The lead takes over an ally the DM played (POST /companions/[id]/take):
// the sheet keeps its id and progress, becomes the lead's own player
// character, the table switches to fielding every character at once, and
// mid-fight its initiative slot answers to the lead, so its next turn is
// theirs. A plain player cannot take one, nor can anyone take a scene's
// guest. Handing it back (POST /companions/hand-back) is its owner's alone,
// only while they keep another character, and the slot answers to the DM's
// bot again.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-ally-take-over");

const world = await openWorld({ gameSettings: { dmMode: "ai", companions: "full", maxCompanions: 3, multiCharacter: "off" } });
const sheetsDb = await import("../src/lib/db/sheets.ts");
const { isCompanionUserId } = await import("../src/lib/db/users.ts");
const { getCampaignById } = await import("../src/lib/db/campaigns.ts");
const { getActiveEncounter } = await import("../src/lib/db/encounters.ts");
const { createCompanionUser } = await import("../src/lib/db/users.ts");

async function call(name, method, user, body, params = {}) {
  const route = await world.route(name);
  world.signIn(user);
  const response = await route[method](
    new Request("http://test/", {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ campaignId: world.campaignId, ...params }) },
  );
  return { status: response.status, json: await response.json() };
}

const TAKE = "campaigns/[campaignId]/companions/[characterId]/take";
const BACK = "campaigns/[campaignId]/companions/hand-back";

// The lead's own rogue, a plain player's hero, and two allies the DM plays:
// a lasting one and a guest.
const lead = world.addHero({ class: "rogue", name: "Swift" });
const player = world.addUser("player");
world.addHero({ user: player, class: "wizard", name: "Other" });
function ally(name, klass, kind) {
  const bot = createCompanionUser(name);
  const hero = world.addHero({ user: bot, class: klass, name });
  return sheetsDb.markSheetAsCompanion(hero.id, kind, `${name} speaks little and fights hard.`);
}
const bruce = ally("Bruce", "fighter", "party");
const guest = ally("Watchman", "fighter", "guest");

await test("a plain player cannot take over an ally", async () => {
  const { status } = await call(TAKE, "POST", player, undefined, { characterId: bruce.id });
  assert.equal(status, 403);
  assert.equal(world.sheet(bruce.id).isCompanion, true);
});

await test("a guest of one scene stays the DM's", async () => {
  const { status, json } = await call(TAKE, "POST", world.owner, undefined, { characterId: guest.id });
  assert.equal(status, 409);
  assert.match(json.error, /guest/);
});

await test("mid-fight, the lead takes over an ally: same sheet, theirs, its turn theirs, every character fielded", async () => {
  await world.beginFight([{ monster: "goblin", count: 2 }]);
  const hpBefore = world.sheet(bruce.id).currentHp;
  const { status, json } = await call(TAKE, "POST", world.owner, undefined, { characterId: bruce.id });
  assert.equal(status, 200, json.error);
  const sheet = world.sheet(bruce.id);
  assert.equal(sheet.id, bruce.id);
  assert.equal(sheet.userId, world.owner.id);
  assert.equal(sheet.isCompanion, false);
  assert.equal(sheet.companionKind, null);
  assert.equal(sheet.currentHp, hpBefore);
  assert.equal(getCampaignById(world.campaignId).gameSettings.multiCharacter, "all_active");
  const slot = getActiveEncounter(world.campaignId).order.find((entry) => entry.kind === "pc" && entry.characterId === bruce.id);
  assert.ok(slot, "the ally keeps its place in the fight");
  assert.equal(slot.userId, world.owner.id);
  const own = sheetsDb.listSheetsForUser(world.campaignId, world.owner.id).map((entry) => entry.id).sort();
  assert.deepEqual(own, [lead.id, bruce.id].sort());
});

await test("a character that is not an ally cannot be taken", async () => {
  const { status } = await call(TAKE, "POST", world.owner, undefined, { characterId: bruce.id });
  assert.equal(status, 409);
});

await test("only its owner hands a character back to the DM", async () => {
  const { status } = await call(BACK, "POST", player, { sheetId: bruce.id });
  assert.equal(status, 403);
  assert.equal(world.sheet(bruce.id).userId, world.owner.id);
});

await test("handing back keeps the sheet and its place in the fight, and the DM plays it again", async () => {
  const { status, json } = await call(BACK, "POST", world.owner, { sheetId: bruce.id });
  assert.equal(status, 200, json.error);
  const sheet = world.sheet(bruce.id);
  assert.equal(sheet.isCompanion, true);
  assert.equal(sheet.companionKind, "party");
  assert.ok(isCompanionUserId(sheet.userId), `owner ${sheet.userId}`);
  assert.match(sheet.personality, /speaks little/);
  const slot = getActiveEncounter(world.campaignId).order.find((entry) => entry.kind === "pc" && entry.characterId === bruce.id);
  assert.equal(slot.userId, sheet.userId);
});

await test("a player's only character cannot be handed to the DM", async () => {
  const { status, json } = await call(BACK, "POST", world.owner, { sheetId: lead.id });
  assert.equal(status, 409);
  assert.match(json.error, /only character/);
  assert.equal(world.sheet(lead.id).isCompanion, false);
});

finish();
