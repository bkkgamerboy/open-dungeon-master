// A prepared adventure is the script (build 39). Played for real (Deicide,
// Nov 2026): told to "improvise freely" on the way to each beat, the DM ran
// an hour in a sewer the pack does not have, chasing red wool, and later
// sent thugs after "the network information" the moment a player said he
// meant to take the network down. The arc a pack compiles into now tells the
// DM to fill only small gaps, and the chapter refresh can no longer add side
// threads, planned moments or recurring people to it, or rewrite its beats.
import assert from "node:assert/strict";
import {
  applyArcDelta,
  arcIsPrepared,
  parseArcDeltaJson,
  parseArcJson,
  PREPARED_ARC_RULE,
  renderArcForPrompt,
} from "../src/lib/dm/arc-logic.ts";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
}

const arcJson = JSON.stringify({
  premise: "A crime lord tests the heroes in Bridgepuddle, then a gnome war in Port Town.",
  stakes: "Karen's inn, Jimmy's life, and who the heroes become in Kaiser's eyes.",
  antagonist: "Kaiser Soze, through Kobayashi.",
  beats: [
    "Midnight on Tower Bridge: Kobayashi's offer",
    "The Walk of Shame",
    "Aftermath in Bridgepuddle",
    "The road to Steelforge",
  ],
  finale: "Port Town falls; Kobayashi offers a ship.",
  subArcs: [],
});

// As the storyboard importer writes it: every beat carries its card.
function preparedArc() {
  const arc = parseArcJson(arcJson);
  arc.beats.forEach((beat, index) => {
    beat.cardId = `card-${index + 1}`;
  });
  return arc;
}

const delta = parseArcDeltaJson(
  JSON.stringify({
    beatsDone: [1],
    activeBeat: 2,
    beatAnnotations: [{ beat: 2, detail: "The heroes promised Jimmy protection." }],
    beatRewrites: [{ beat: 3, text: "Hunt the network's thugs through the sewers for clues" }],
    newSubArcs: [{ name: "The Network", goal: "Find who sent the thugs", hook: "invented", beats: ["Search the sewers"] }],
    newEvents: [{ kind: "twist", name: "Thugs at the inn", detail: "Network thugs want the heroes' notes", trigger: "night at the inn", actHint: 1 }],
    newCast: [{ name: "Grubb", role: "network enforcer", agenda: "recover the notes", notes: "" }],
    subArcUpdates: [],
  }),
);

test("an arc compiled from a pack reads as prepared; a generated one does not", () => {
  assert.equal(arcIsPrepared(preparedArc()), true);
  assert.equal(arcIsPrepared(parseArcJson(arcJson)), false);
});

test("a prepared arc's prompt makes the pack the script, with no free improvising", () => {
  const rendered = renderArcForPrompt(preparedArc());
  assert.ok(rendered.includes(PREPARED_ARC_RULE));
  assert.ok(!rendered.includes("improvising freely"));
  assert.ok(rendered.includes("never invent dungeons, sewers, side quests, clue trails"));
  assert.ok(rendered.includes("not a request for a new quest"));
  // The beat and waypoint mechanics are still explained.
  assert.ok(rendered.includes("call complete_beat"));
  assert.ok(rendered.includes("`waypoint`"));
});

test("a generated arc keeps its improvising rule unchanged", () => {
  const rendered = renderArcForPrompt(parseArcJson(arcJson));
  assert.ok(rendered.includes("improvising freely on the way there"));
  assert.ok(!rendered.includes(PREPARED_ARC_RULE));
});

test("the chapter refresh adds no invented threads to a prepared arc", () => {
  const before = preparedArc();
  const next = applyArcDelta(before, delta);
  // What the refresh is for still works: progress and table colour.
  assert.equal(next.beats[0].status, "done");
  assert.equal(next.beats[1].status, "active");
  assert.equal(next.beats[1].detail, "The heroes promised Jimmy protection.");
  // What it may not do to a pack.
  assert.equal(next.beats[2].text, "Aftermath in Bridgepuddle", "a pack beat was rewritten");
  assert.equal(next.subArcs.length, 0, "a side thread was invented");
  assert.equal(next.events.length, before.events.length, "a planned moment was invented");
  assert.equal(next.cast.length, before.cast.length, "a recurring person was invented");
});

test("a generated arc still takes the refresh's new threads and rewrites", () => {
  const next = applyArcDelta(parseArcJson(arcJson), delta);
  assert.equal(next.beats[2].text, "Hunt the network's thugs through the sewers for clues");
  assert.equal(next.subArcs.length, 1);
  assert.ok(next.events.some((event) => event.name === "Thugs at the inn"));
  assert.ok(next.cast.some((npc) => npc.name === "Grubb"));
});

test("prepared is judged on the act in play", () => {
  // A pack added as act 2 of a generated saga: prepared while it runs.
  const arc = parseArcJson(arcJson);
  arc.beats[0].status = "done";
  arc.beats[1].status = "done";
  arc.beats[2].act = 2;
  arc.beats[3].act = 2;
  arc.beats[2].cardId = "card-a";
  arc.beats[3].cardId = "card-b";
  arc.beats[2].status = "active";
  arc.acts = 2;
  assert.equal(arcIsPrepared(arc), true);
  // Back in a generated act, it improvises again.
  arc.beats[2].status = "done";
  arc.beats[3].status = "done";
  arc.beats.push({ text: "A generated act 3 beat", status: "active", act: 3 });
  arc.acts = 3;
  assert.equal(arcIsPrepared(arc), false);
});

console.log(`${passed} prepared arc tests passed`);
