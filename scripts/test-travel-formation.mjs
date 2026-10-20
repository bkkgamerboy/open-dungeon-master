// Issue 230: the party's travel formation as campaign state. Driven through
// the real route and the real engine (enforce-world.mjs): the party lead of an
// AI-run table arranges it with no DM seat, a player cannot reorder anyone,
// the players a change moves agree or ask for a change (one answer for each of
// their characters), a proposal waits on them while the active order holds,
// every DM turn's game state carries the order in force and only that one,
// characters who join are shown as not placed, start_encounter stands the
// party by it, and a trap can be sprung on whoever walks first or last.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";

const world = await openWorld();
const { getParty, setParty } = await import("../src/lib/db/party.ts");
const { listMembers } = await import("../src/lib/db/campaigns.ts");
const { listAllMessages: listMessages } = await import("../src/lib/db/messages.ts");
const { getBattleMapForEncounter, listTokens } = await import("../src/lib/db/battle-maps.ts");
const { buildGameStateBlock, buildDmMessages } = await import("../src/lib/dm/prompt.ts");
const logic = await import("../src/lib/dm/formation-logic.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

const route = await world.route("campaigns/[campaignId]/party/formation");
async function call(user, body) {
  world.signIn(user);
  const response = await route.POST(
    new Request("http://test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ campaignId: world.campaignId }) },
  );
  return { status: response.status, json: await response.json() };
}
const userOf = (sheet) => listMembers(world.campaignId).find((member) => member.userId === sheet.userId);
const asUser = (sheet) => ({ id: sheet.userId, username: userOf(sheet)?.username ?? "" });
const lastLine = () => {
  const all = listMessages(world.campaignId);
  return all[all.length - 1]?.content ?? "";
};
const gameState = () =>
  buildGameStateBlock({ campaign: world.campaign(), members: listMembers(world.campaignId), sheets: world.sheets(), recentRolls: [], storySummary: "" });

// The lead plays Thorn; Mira and Pip are other players'.
const thorn = world.addHero({ name: "Thorn", class: "fighter", level: 3 });
const mira = world.addHero({ name: "Mira", class: "rogue", level: 3 });
const pip = world.addHero({ name: "Pip", class: "wizard", level: 3 });
const lead = world.owner;

await test("the pure rules: moved characters, unplaced ones, a sent order's problems", () => {
  assert.deepEqual(logic.movedCharacters(["a", "b", "c"], ["a", "c", "b"]), ["c", "b"]);
  assert.deepEqual(logic.movedCharacters([], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(logic.movedCharacters(["a", "b"], ["a"]), ["b"]);
  assert.deepEqual(logic.formationView(["c", "x", "a"], ["a", "b", "c"]), { placed: ["c", "a"], unplaced: ["b"] });
  assert.match(logic.formationProblem(["a", "a"], ["a"]), /twice/);
  assert.match(logic.formationProblem(["z"], ["a"]), /not in this party/);
  assert.equal(logic.formationProblem(["a"], ["a", "b"]), null);
  assert.equal(logic.describeFormation({ marchingOrder: ["a"], formationChange: null }, ["a"], (id) => id), "", "a party of one has no formation");
});

await test("the party lead of an AI-run table saves an order with no DM seat; a player cannot", async () => {
  assert.equal(world.campaign().dmUserId ?? null, null, "no human DM seat at this table");
  const refused = await call(asUser(mira), { do: "set", order: [mira.id, thorn.id, pip.id] });
  assert.equal(refused.status, 403);
  assert.deepEqual(getParty(world.campaignId).marchingOrder, []);

  const saved = await call(lead, { do: "set", order: [thorn.id, mira.id, pip.id] });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const party = getParty(world.campaignId);
  assert.deepEqual(party.marchingOrder, [thorn.id, mira.id, pip.id]);
  assert.equal(party.formationChange.status, "active");
  assert.deepEqual(party.formationChange.affected.sort(), [mira.id, pip.id].sort(), "the lead's own character is not asked");
  assert.match(lastLine(), /set a new travel formation/);
  assert.match(lastLine(), /Mira and Pip/);
  assert.doesNotMatch(lastLine(), /front|rear|1\./, "the table line names nobody's place");
});

await test("a moved player agrees or asks for a change, for their own character only", async () => {
  const notTheirs = await call(asUser(mira), { do: "answer", characterId: pip.id, answer: "agree" });
  assert.equal(notTheirs.status, 404);
  const asked = await call(asUser(mira), { do: "answer", characterId: mira.id, answer: "change", note: "I would rather scout ahead." });
  assert.equal(asked.status, 200);
  assert.equal(getParty(world.campaignId).formationChange.answers[mira.id].answer, "change");
  assert.match(lastLine(), /asks for a change.*Mira.*scout ahead/);
  const agreed = await call(asUser(pip), { do: "answer", characterId: pip.id, answer: "agree" });
  assert.equal(agreed.status, 200);
  assert.equal(getParty(world.campaignId).formationChange.answers[pip.id].answer, "agree");
});

await test("a proposal waits on the players it moves while the active order holds, then takes effect", async () => {
  const proposed = await call(lead, { do: "propose", order: [mira.id, thorn.id, pip.id] });
  assert.equal(proposed.status, 200);
  let party = getParty(world.campaignId);
  assert.equal(party.formationChange.status, "proposed");
  assert.deepEqual(party.marchingOrder, [thorn.id, mira.id, pip.id], "the active order holds until it is agreed");
  assert.match(gameState(), /proposed and not yet agreed/);
  assert.deepEqual(party.formationChange.affected, [mira.id]);
  await call(asUser(mira), { do: "answer", characterId: mira.id, answer: "agree" });
  party = getParty(world.campaignId);
  assert.equal(party.formationChange.status, "active");
  assert.deepEqual(party.marchingOrder, [mira.id, thorn.id, pip.id]);
  assert.match(lastLine(), /has agreed: it is the formation now/);
});

await test("the lead can make a proposal active before every answer, or withdraw it", async () => {
  await call(lead, { do: "propose", order: [pip.id, mira.id, thorn.id] });
  const withdrawn = await call(lead, { do: "withdraw" });
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(getParty(world.campaignId).marchingOrder, [mira.id, thorn.id, pip.id]);
  assert.equal(getParty(world.campaignId).formationChange, null);
  await call(lead, { do: "propose", order: [pip.id, mira.id, thorn.id] });
  assert.equal((await call(asUser(pip), { do: "activate" })).status, 403);
  assert.equal((await call(lead, { do: "activate" })).status, 200);
  assert.deepEqual(getParty(world.campaignId).marchingOrder, [pip.id, mira.id, thorn.id]);
});

await test("each DM turn reads the order in force from campaign state, never a stale one", async () => {
  const before = gameState();
  assert.match(before, /Travel formation, front to back.*1\. Pip, 2\. Mira, 3\. Thorn/);
  // A long transcript that names an old order, as a recap or a recalled
  // scene might: the game state block is rebuilt from the party record.
  for (let index = 0; index < 120; index += 1) {
    world.say("system", `Old note ${index}: Thorn walks at the front, Mira behind him.`);
  }
  await call(lead, { do: "set", order: [thorn.id, pip.id, mira.id] });
  const messages = buildDmMessages(
    { campaign: world.campaign(), members: listMembers(world.campaignId), sheets: world.sheets(), recentRolls: [], storySummary: "Long ago Mira led the way." },
    listMessages(world.campaignId).slice(-20),
  );
  const system = messages.find((message) => message.role === "system" && /GAME STATE/.test(String(message.content)));
  assert.ok(system, "the game state rides every turn");
  assert.match(String(system.content), /1\. Thorn, 2\. Pip, 3\. Mira/);
  assert.doesNotMatch(String(system.content), /1\. Pip, 2\. Mira/);
});

await test("a character who joins is shown as not placed, and a departure leaves no stale name", async () => {
  const brin = world.addHero({ name: "Brin", class: "cleric", level: 3 });
  assert.match(gameState(), /Not in the formation yet: Brin/);
  const view = logic.formationView(getParty(world.campaignId).marchingOrder, world.sheets().map((sheet) => sheet.id));
  assert.deepEqual(view.unplaced, [brin.id]);
  // A player with two characters answers for each.
  const second = world.addHero({ name: "Mira's twin", class: "rogue", level: 3, user: { id: mira.userId } });
  await call(lead, { do: "propose", order: [mira.id, second.id, thorn.id, pip.id, brin.id] });
  const change = getParty(world.campaignId).formationChange;
  assert.ok(change.affected.includes(mira.id) && change.affected.includes(second.id));
  await call(asUser(mira), { do: "answer", characterId: mira.id, answer: "agree" });
  const after = getParty(world.campaignId).formationChange;
  assert.equal(after.answers[second.id], undefined, "one answer is for one character");
  assert.equal(after.status, "proposed");
  await call(lead, { do: "withdraw" });
});

await test("start_encounter stands the party by the formation and says so", async () => {
  await call(lead, { do: "set", order: [thorn.id, pip.id, mira.id] });
  const out = await world.invoke("start_encounter", { enemies: [{ monster: "goblin", count: 2 }], summary: "Goblins on the road" });
  assert.ok(out.ok, JSON.stringify(out));
  assert.match(out.result.formation, /front of it nearest the enemy: Thorn, Pip, Mira/);
  assert.match(out.result.formation, /grants no surprise or bonus/);
  const encounter = world.encounter();
  const tokens = listTokens(getBattleMapForEncounter(encounter.id).id);
  const enemyTiles = tokens.filter((token) => token.kind === "enemy");
  const distance = (refId) => {
    const token = tokens.find((entry) => entry.refId === refId);
    return Math.min(...enemyTiles.map((enemy) => Math.max(Math.abs(enemy.x - token.x), Math.abs(enemy.y - token.y))));
  };
  assert.ok(distance(thorn.id) <= distance(mira.id), `front ${distance(thorn.id)} vs rear ${distance(mira.id)}`);
  assert.equal(encounter.surprisedIds.length, 0, "the formation grants no surprise");
  await world.invoke("end_encounter", { reason: "test" });
});

await test("from behind, the party turns to face them: the front still stands nearest, the rear farthest", () => {
  const sheets = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
  const party = [{ x: 1, y: 5 }, { x: 2, y: 5 }, { x: 3, y: 5 }];
  const enemies = [{ x: 9, y: 5 }];
  const ahead = logic.placeByFormation(sheets, party, enemies, ["a", "b", "c"], "ahead");
  assert.deepEqual(ahead.spots.get("a"), { x: 3, y: 5 });
  assert.deepEqual(ahead.spots.get("c"), { x: 1, y: 5 });
  const behind = logic.placeByFormation(sheets, party, enemies, ["a", "b", "c"], "behind");
  assert.deepEqual(behind.spots.get("a"), { x: 3, y: 5 });
  assert.deepEqual(behind.spots.get("c"), { x: 1, y: 5 }, "the rear of the formation never opens nearest the enemy");
  assert.match(behind.line, /turned to face the enemy, who came from behind/);
  const none = logic.placeByFormation(sheets, party, enemies, [], "ahead");
  assert.match(none.line, /No travel formation is set/);
});

await test("a trap catches whoever walks first or last in the formation", async () => {
  await call(lead, { do: "set", order: [pip.id, thorn.id, mira.id] });
  const front = await world.invoke("apply_hazard", { type: "falling", feet: 20, rank: "front", reason: "a pit" });
  assert.ok(front.ok, JSON.stringify(front));
  assert.match(front.result.formation, /Pip walks at the front/);
  const rear = await world.invoke("apply_hazard", { type: "falling", feet: 20, rank: "rear", reason: "a pit" });
  assert.match(rear.result.formation, /walks at the rear/);
  assert.match(JSON.stringify(rear.result), /Mira/);
  // With no formation, there is no front to catch: the hazard names its victims.
  setParty(world.campaignId, { ...getParty(world.campaignId), marchingOrder: [], formationChange: null });
  const refused = await world.invoke("apply_hazard", { type: "falling", feet: 20, rank: "front", reason: "a pit" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /no travel formation/);
});

console.log(`${passed} travel formation checks passed`);
world.close();
