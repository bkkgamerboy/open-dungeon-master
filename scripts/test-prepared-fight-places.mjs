// Build 34: the prepared fight in the place the party stands, with what it
// holds, and fights already played out of the list of fights to come.
//
// Played for real (The Pirate Queen's Ploy, Nov 2026): the Guardian's Rest
// holds a stone golem the party can slip past, with the key to a chest of
// +1 studded leather in its fist. The chest's contents lived only in the
// fight's worth, which the storyteller saw cut at 100 characters, in a list
// of the first eight fights by name wherever the party stood. The party left
// the temple without the armour.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-prepared-fight-places");
const world = await openWorld({ gameSettings: { dmMode: "ai", ttsEnabled: false } });
world.addHero({ class: "fighter", level: 9, name: "Bruce" });
const { insertKnownLocation } = await import("../src/lib/db/locations.ts");
const { insertEncounterTemplate, getEncounterTemplate, markTemplateRan } = await import("../src/lib/db/encounter-templates.ts");
const { preparedFightsBlock, fightBelongsTo } = await import("../src/lib/dm/prepared-encounter-tool.ts");
const { getDatabase } = await import("../src/lib/db/core.ts");

const quiet = { visionClear: false };
const GOLEM_WORTH =
  "In its fist: 75 gp and a silver key. The key opens a locked chest in a wall compartment (DC 16 Investigation): 100 gp, a Potion of Healing, and +1 Studded Leather left by a thief the golem caught.";

const place = (name, text, connections) =>
  insertKnownLocation({ campaignId: world.campaignId, name, layoutDescription: text, connections, written: true });
place(
  "Hall of Whispers",
  "A corridor 10 ft wide running south. Exits: north to the Entry Chamber, a heavy stone door at the south end into the Shrine of Bones.",
  ["Shrine of Bones"],
);
place(
  "Shrine of Bones",
  "A chamber 50 ft by 30 ft of piled bones and a black altar. Exits: the stone door north, a door east to the Guardian's Rest. Fight: Shrine of Bones.",
  ["Hall of Whispers", "Guardian’s Rest"],
);
place(
  "Guardian’s Rest",
  "A narrow chamber 45 ft by 15 ft. A stone golem lies dormant in the far corner (fight: Guardian's Rest: the Stone Golem). A wall compartment (DC 16 Investigation) holds a locked chest.",
  ["Shrine of Bones"],
);

const fight = (name, rewards, notes = "") =>
  insertEncounterTemplate({
    campaignId: world.campaignId,
    name,
    enemies: [{ monster: "skeleton", count: 2 }],
    battlefield: "",
    map: { mapId: null, scene: null, seed: null, theme: null, ambient: null, width: null, height: null },
    notes,
    extras: { rewards, phases: [] },
    createdByUserId: world.owner.id,
  });
// Nine fights that sort before the temple's, as a long pack's ship decks do.
for (const letter of "ABCDEFGHI") {
  fight(`${letter} deck: the crew`, "a few coins");
}
const golem = fight("Guardian's Rest: the Stone Golem", GOLEM_WORTH, "Avoidable. It wakes if touched or if a spell is cast in the room.");
const shrine = fight("Shrine of Bones", "A jewelled dagger (100 gp) behind a skull on the altar.");

await test("A fight belongs to its place by name or by the place's own words, not because a door points at it.", async () => {
  assert.equal(fightBelongsTo({ name: "Shrine of Bones", text: "" }, "Shrine of Bones"), true);
  assert.equal(fightBelongsTo({ name: "Guardian’s Rest", text: "" }, "Guardian's Rest: the Stone Golem"), true);
  assert.equal(fightBelongsTo({ name: "Entry Chamber", text: "Wights wait (fight: Entry Chamber: the Wights)." }, "Entry Chamber: the Wights"), true);
  assert.equal(fightBelongsTo({ name: "Hall of Whispers", text: "a door at the south end into the Shrine of Bones" }, "Shrine of Bones"), false);
  assert.equal(fightBelongsTo(null, "Shrine of Bones"), false);
});

await test("Away from the temple, the list is of fights to come and no place claims one.", async () => {
  const block = preparedFightsBlock(world.campaign());
  assert.match(block, /Prepared fights to come/);
  assert.doesNotMatch(block, /Prepared fights in /);
  assert.match(block, /3 more are prepared/, block);
});

await test("In the Hall of Whispers, a door into the Shrine of Bones does not put the shrine's fight here.", async () => {
  const moved = await world.invoke("move_party", { ...quiet, name: "Hall of Whispers" });
  assert.equal(moved.ok, true, moved.error);
  assert.doesNotMatch(preparedFightsBlock(world.campaign()), /Prepared fights in /);
});

await test("In the Guardian's Rest, its fight comes first with everything it is worth, the armour included.", async () => {
  await world.invoke("move_party", { ...quiet, name: "Shrine of Bones" });
  const moved = await world.invoke("move_party", { ...quiet, name: "Guardian’s Rest" });
  assert.equal(moved.ok, true, moved.error);
  const block = preparedFightsBlock(world.campaign());
  const [here] = block.split("Prepared fights to come");
  assert.match(here, /Prepared fights in Guardian’s Rest/);
  assert.ok(here.includes(GOLEM_WORTH), here);
  assert.match(here, /Avoidable/);
  assert.match(here, /whether or not the fight happens/);
  assert.doesNotMatch(here, /Shrine of Bones:/);
});

await test("A fight that has run leaves the fights to come, and its place still shows what it held.", async () => {
  markTemplateRan(golem.id);
  assert.ok(getEncounterTemplate(golem.id).ranAt);
  const block = preparedFightsBlock(world.campaign());
  const [here, toCome = ""] = block.split("Prepared fights to come");
  assert.match(here, /Guardian's Rest: the Stone Golem \(already fought here\)/);
  assert.match(here, /\+1 Studded Leather/);
  assert.doesNotMatch(toCome, /Stone Golem/);
  assert.match(toCome, /2 more are prepared/, toCome);
});

await test("Back in the Hall, a fight that has run is not listed at all.", async () => {
  await world.invoke("move_party", { ...quiet, name: "Shrine of Bones" });
  await world.invoke("move_party", { ...quiet, name: "Hall of Whispers" });
  assert.doesNotMatch(preparedFightsBlock(world.campaign()), /Stone Golem/);
  assert.ok(getEncounterTemplate(shrine.id), "the shrine's fight is still prepared");
});

await test("The run marker is a column the table keeps.", async () => {
  const columns = getDatabase().prepare("PRAGMA table_info(encounter_templates)").all().map((row) => row.name);
  assert.ok(columns.includes("ran_at"));
});

finish();
