// Build 32: a place the adventure writes (a pack's room, a workshop's place)
// is narrated from that text and never overwritten.
//
// Before this, the DM saw only the room the party stood in. Moving them on,
// it described the next room in its move_party call without having seen what
// the pack wrote there, and the server saved that guess over the pack's room.
// Played for real (The Pirate Queen's Ploy, Nov 2026): a fissure, a pool and
// a stone panel that are not in the pack, the temple's Entry Chamber without
// its passage south, and the whole upper wing skipped.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { call, fakeModel, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-written-places");
const world = await openWorld({ gameSettings: { ttsEnabled: false } });
const { getDatabase, backfillWrittenLayouts } = await import("../src/lib/db/core.ts");
const { insertKnownLocation, getCurrentLocation, getLocationByName, setLocationLayout } = await import("../src/lib/db/locations.ts");
const { composeLayout, additionsTo, followsWritten, SINCE_ARRIVAL, LAYOUT_MAX } = await import("../src/lib/db/written-layout.ts");
const { roomsAhead, ROOM_TEXT_MAX, writtenArrivalPrompt } = await import("../src/lib/dm/written-places.ts");
const { buildGameStateBlock, dmSystemText, movePartyTool } = await import("../src/lib/dm/prompt.ts");
const { createWorkshop } = await import("../src/lib/db/workshops.ts");
const { exportWorkshopBundle, importWorkshopBundle } = await import("../src/lib/db/workshop-bundle.ts");
const { readBundle } = await import("../src/lib/workshop/bundle.ts");
const { runContentImport } = await import("../src/lib/db/content-import.ts");
const { createCampaign } = await import("../src/lib/db/campaigns.ts");

const db = getDatabase();
const quiet = { visionClear: false };

const ENTRANCE =
  "The western cliff of the cove: jagged, moss-curtained rock, a faint clicking like a colossal clock. Opened, it shatters into a man-sized opening. Exit: west, a cold, stale passage into the temple (the Entry Chamber).";
const ENTRY =
  "A natural cave about 50 ft by 45 ft, partly carved, cold and damp. Exits: the passage east back to the cove; a crumbling staircase in the north-west corner descending into darkness (the Sundered Descent); and a narrow passage south (to the Hall of Whispers). The walls are carved with skeletal figures. Afterwards, a loose stone by the stair hides a compartment.";
const WHISPERS =
  "A corridor 10 ft wide and 50 ft long running south, its walls lined with runes pulsing sickly green. Exits: north to the Entry Chamber, a heavy stone door at the south end, and a secret door half way down the east wall (DC 15 Investigation). A hidden alcove (DC 16 Investigation) holds an ornate box.";
const DESCENT = "A crumbling stair spiralling down in three sections for about 60 ft. Exits: up to the Entry Chamber, down to the Ossuary Gate.";
const INVENTED =
  "A narrow fissure passage leads to a shallow pool and a concealed stone panel; beyond it a tight squeeze opens into a broad, low cavern with a water-filled cleft toward the cove.";

const place = (name, text, connections, written = true) =>
  insertKnownLocation({ campaignId: world.campaignId, name, layoutDescription: text, connections, written });
place("The Hidden Entrance", ENTRANCE, ["Entry Chamber"]);
place("Entry Chamber", ENTRY, ["The Hidden Entrance", "Hall of Whispers", "The Sundered Descent", "Old Well"]);
place("Hall of Whispers", WHISPERS, ["Entry Chamber"]);
place("The Sundered Descent", DESCENT, ["Entry Chamber"]);
// An imported map's one-line blurb: not the adventure's room text.
place("Old Well", "A well in the village square.", ["Entry Chamber"], false);

// ---- the record ----

await test("Arriving at a written place the first time keeps its text and hands it to the model, even when the model passed a layout of its own.", async () => {
  const first = await world.invoke("move_party", { ...quiet, name: "The Hidden Entrance" });
  assert.equal(first.ok, true, first.error);
  assert.ok(first.result.note.includes("is written by the adventure"), first.result.note);
  assert.ok(first.result.note.includes(ENTRANCE), "the arrival did not carry the written text");
  assert.ok(first.result.note.includes("stays unmentioned until someone finds it"), "the arrival does not keep hidden things hidden");

  const second = await world.invoke("move_party", { ...quiet, name: "Entry Chamber", layoutDescription: INVENTED });
  assert.equal(second.ok, true, second.error);
  const here = getCurrentLocation(world.campaignId);
  assert.equal(here.name, "Entry Chamber");
  assert.equal(here.layoutDescription, ENTRY, "the model's guess was saved over the written room");
  assert.equal(here.writtenLayout, ENTRY);
  assert.equal(here.visited, true);
  assert.ok(second.result.note.includes("the layout you passed was set aside"), second.result.note);
  assert.ok(second.result.note.includes(ENTRY), "the arrival did not carry the written text");
  assert.equal("_writtenRewrite" in second.result, false, "the corrective-call flag reached a person's result");
  // The way in joins the routes, and the written ones stay.
  for (const route of ["The Hidden Entrance", "Hall of Whispers", "The Sundered Descent"]) {
    assert.ok(here.connections.includes(route), `${route} fell out of the routes`);
  }
});

await test("update_location at a written place adds after the written text, replaces its own earlier additions, and adds nothing for a repeat.", async () => {
  const found = await world.invoke("update_location", { ...quiet, layoutDescription: "The loose stone by the stair lies open, the compartment empty." });
  assert.equal(found.ok, true, found.error);
  assert.ok(found.result.note.includes("stays as written"), found.result.note);
  let here = getCurrentLocation(world.campaignId);
  assert.equal(here.layoutDescription, `${ENTRY}\n\n${SINCE_ARRIVAL} The loose stone by the stair lies open, the compartment empty.`);
  await world.invoke("update_location", { ...quiet, layoutDescription: `${ENTRY} The wights lie destroyed by the stair.` });
  here = getCurrentLocation(world.campaignId);
  assert.equal(here.layoutDescription, `${ENTRY}\n\n${SINCE_ARRIVAL} The wights lie destroyed by the stair.`, "a revision that restated the text was not cut to what it added");
  await world.invoke("update_location", { ...quiet, layoutDescription: ENTRY });
  assert.equal(getCurrentLocation(world.campaignId).layoutDescription, here.layoutDescription, "repeating the written text changed the record");
  assert.equal(getCurrentLocation(world.campaignId).writtenLayout, ENTRY, "the written text moved");
});

await test("A return to a written place keeps its record and is told as it was left, whatever layout the model passes.", async () => {
  await world.invoke("move_party", { ...quiet, name: "The Sundered Descent" });
  const back = await world.invoke("move_party", { ...quiet, name: "Entry Chamber", layoutDescription: "A different cave entirely." });
  assert.equal(back.ok, true, back.error);
  assert.ok(back.result.note.startsWith("Recorded. The party is back at Entry Chamber, as it was left:"), back.result.note);
  assert.ok(getCurrentLocation(world.campaignId).layoutDescription.startsWith(ENTRY));
});

await test("A place nobody wrote is still the DM's to describe: its layout is the one move_party gives.", async () => {
  const out = await world.invoke("move_party", { ...quiet, name: "Old Well", layoutDescription: "A round village square, a mossy well at its centre, lanes north and east." });
  assert.equal(out.ok, true, out.error);
  const well = getCurrentLocation(world.campaignId);
  assert.equal(well.writtenLayout, "");
  assert.ok(well.layoutDescription.startsWith("A round village square"), "an unwritten place lost the DM's arrival");
  assert.equal(out.result.note, "Recorded. Continue the scene.");
  // A first visit with no layout to a place known by a blurb hands the model
  // the blurb, so it is not described blind either.
  place("Mill Town", "A river town of 2,000 souls.", [], false);
  const town = await world.invoke("move_party", { ...quiet, name: "Mill Town" });
  assert.equal(town.result.note, "Recorded. On record for Mill Town: A river town of 2,000 souls. Continue the scene.");
  await world.invoke("move_party", { ...quiet, name: "Entry Chamber" });
});

await test("WorldForge text is written: a place typed in, and a later edit of it, are the adventure's own.", () => {
  const typed = insertKnownLocation({ campaignId: world.campaignId, name: "Forge Room", layoutDescription: "A square forge 20 ft across.", written: true });
  assert.equal(typed.writtenLayout, "A square forge 20 ft across.");
  const edited = setLocationLayout(typed.id, "A square forge 25 ft across, an anvil in the middle.", { written: true });
  assert.equal(edited.writtenLayout, "A square forge 25 ft across, an anvil in the middle.");
  assert.equal(edited.layoutDescription, edited.writtenLayout);
  const generated = setLocationLayout(typed.id, "A generated layout.");
  assert.equal(generated.writtenLayout, "A square forge 25 ft across, an anvil in the middle.", "a generated layout moved the written text");
});

// ---- the pure parts ----

await test("A layout told in the room's own words follows the written text; one with a different room in it does not.", () => {
  assert.equal(followsWritten(INVENTED, ENTRY), false, "the invented cavern passed for the Entry Chamber");
  assert.equal(
    followsWritten("A natural cave, partly carved, cold and damp, about 50 by 45 feet; a crumbling staircase in the north-west corner, a narrow passage south, the passage east to the cove.", ENTRY),
    true,
    "a fair retelling was taken for a different room",
  );
  assert.equal(followsWritten("", ENTRY), true);
});

await test("The written text always survives whole when the record is full; only the additions are cut.", () => {
  const long = "x".repeat(1_900);
  const joined = composeLayout(long, "y".repeat(500));
  assert.equal(joined.length, LAYOUT_MAX);
  assert.ok(joined.startsWith(long));
  assert.equal(composeLayout(ENTRY, ""), ENTRY);
  assert.equal(additionsTo(ENTRY, ENTRY, `${ENTRY}\n\n${SINCE_ARRIVAL} New.`), "New.");
  assert.equal(additionsTo(ENTRY, ENTRY, "  "), null);
});

// ---- what the DM is shown ----

await test("GAME STATE shows the written rooms one step on that the party has not been to, and marks a written Layout.", () => {
  const here = getCurrentLocation(world.campaignId);
  assert.equal(here.name, "Entry Chamber");
  const ahead = roomsAhead(world.campaignId, here);
  assert.deepEqual(ahead.map((room) => room.name), ["Hall of Whispers"], "rooms ahead should be the unvisited written ones only");
  assert.equal(ahead[0].text, WHISPERS);

  const block = buildGameStateBlock({
    ...minimalState(),
    currentLocation: { name: here.name, layoutDescription: here.layoutDescription, connections: here.connections, written: true },
    roomsAhead: ahead,
  });
  assert.ok(block.includes(`Layout (written by the adventure; what follows "${SINCE_ARRIVAL}" is yours): ${ENTRY}`), "the written Layout is not marked");
  assert.ok(block.includes("Rooms ahead, as the adventure writes them."), "no Rooms ahead section");
  assert.ok(block.includes(`- Hall of Whispers: ${WHISPERS}`), "the next room's text is missing");
  assert.ok(block.includes("stays unmentioned until someone finds it"), "Rooms ahead does not keep hidden things hidden");
  assert.ok(block.includes("give move_party its name with no layout"), "Rooms ahead does not say how to move into one");

  const plain = buildGameStateBlock({
    ...minimalState(),
    currentLocation: { name: "Old Well", layoutDescription: "A square.", connections: [] },
  });
  assert.equal(plain.includes("Rooms ahead"), false);
  assert.ok(plain.includes("Layout: A square."));
});

await test("An outsized room is clipped in Rooms ahead; the record keeps it whole.", () => {
  const big = `A vast hall. ${"Pillars line the walls. ".repeat(120)}`;
  place("Great Hall", big, ["Hall of Whispers"]);
  const whispers = getLocationByName(world.campaignId, "Hall of Whispers");
  db.prepare(`UPDATE locations SET connections_json = ? WHERE id = ?`).run(JSON.stringify(["Entry Chamber", "Great Hall"]), whispers.id);
  const ahead = roomsAhead(world.campaignId, getLocationByName(world.campaignId, "Hall of Whispers"));
  const hall = ahead.find((room) => room.name === "Great Hall");
  assert.ok(hall.text.length <= ROOM_TEXT_MAX && hall.text.endsWith("..."));
  assert.equal(getLocationByName(world.campaignId, "Great Hall").writtenLayout, big.trim().slice(0, 2_000));
});

await test("The rules send a move into a written room without a layout, stop there every first time, and forbid rooms between written ones.", () => {
  const text = dmSystemText(false);
  const lines = text.split("\n");
  const pacing = lines.find((line) => line.startsWith("- Exploration pacing:")) ?? "";
  assert.ok(pacing.includes("A room the adventure writes (GAME STATE's Rooms ahead) is always a stop the first time"), "a stretch can still carry the party through a written room");
  assert.ok(pacing.includes("Never invent rooms, passages, squeezes or obstacles between two places the adventure writes"), "the DM may still pad the way between written rooms");
  const arrival = lines.find((line) => line.startsWith("- Arrivals:")) ?? "";
  assert.ok(arrival.includes("Take these facts from the adventure's text when the place is written"), "an arrival is not told from the written text");
  assert.ok(arrival.includes("Never swap a written room's shape, features or exits for ones of your own"));
  const location = lines.find((line) => line.startsWith("- Keep the party's location current")) ?? "";
  assert.ok(location.includes("for a room under Rooms ahead: give its name exactly and leave out the layout"), "the location rule still asks for a layout of a written room");
  assert.ok(movePartyTool.function.parameters.properties.layoutDescription.description.includes("a written place's text is never replaced"));
});

// ---- packs: bundle, workshop, table ----

await test("A pack's rooms are written from the bundle on, travel written into a table, and export without the table's additions.", () => {
  const userId = world.owner.id;
  const source = createWorkshop(userId, { title: "Temple pack" });
  insertKnownLocation({ campaignId: source.id, name: "Ossuary Gate", layoutDescription: "A vast natural cavern 100 ft by 70 ft. Exits: the stair up north-west; an iron-bound door east.", written: true });
  const exported = exportWorkshopBundle(source.id, { name: "Temple pack", blurb: "A test.", inspiredBy: "Original work" });
  assert.ok(!("error" in exported), exported.error);
  const bundle = readBundle(JSON.stringify(exported.bundle)).bundle;
  const imported = importWorkshopBundle(userId, bundle);
  assert.ok(!("error" in imported), imported.error);
  const gate = getLocationByName(imported.workshopId, "Ossuary Gate");
  assert.ok(gate.writtenLayout.startsWith("A vast natural cavern"), "a bundle's room did not arrive written");

  const table = createCampaign(userId, { title: "Temple table", description: "", theme: "high-fantasy", maxPlayers: 4, startingLevel: 9, difficulty: "normal" });
  const outcome = runContentImport({ sourceId: imported.workshopId, campaignId: table.id, selection: ["locations"], houseRulesMode: "replace" });
  assert.ok(!("error" in outcome), outcome.error);
  const copy = getLocationByName(table.id, "Ossuary Gate");
  assert.equal(copy.writtenLayout, gate.writtenLayout, "the table's copy is not written");

  // Played: the DM's words ride after the written text. A copy of the table,
  // and an export, carry the room as written.
  db.prepare(`UPDATE locations SET layout_description = ?, visited = 1 WHERE id = ?`).run(composeLayout(copy.writtenLayout, "The iron door stands open."), copy.id);
  const again = createCampaign(userId, { title: "Temple table two", description: "", theme: "high-fantasy", maxPlayers: 4, startingLevel: 9, difficulty: "normal" });
  runContentImport({ sourceId: table.id, campaignId: again.id, selection: ["locations"], houseRulesMode: "replace" });
  const second = getLocationByName(again.id, "Ossuary Gate");
  assert.equal(second.layoutDescription, gate.writtenLayout, "the first table's play travelled as prep");
  assert.equal(second.visited, false);
});

await test("Boot marks the places already on record: a workshop's, and a table's copies, with an entered room's pack text brought back ahead of the DM's guess.", () => {
  const userId = world.owner.id;
  const prep = createWorkshop(userId, { title: "Old prep" });
  const now = new Date().toISOString();
  const row = (campaignId, name, layout, visited) => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO locations (id, campaign_id, name, layout_description, connections_json, visited, is_current, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', ?, 0, ?, ?)`,
    ).run(id, campaignId, name, layout, visited, now, now);
    return id;
  };
  const origin = (campaignId, rowId, originId, originRowId) =>
    db.prepare(`INSERT INTO content_origins (campaign_id, kind, row_id, origin_id, origin_row_id, created_at) VALUES (?, 'locations', ?, ?, ?, ?)`).run(campaignId, rowId, originId, originRowId, now);

  const srcEntry = row(prep.id, "Old Entry", ENTRY, 0);
  const srcHall = row(prep.id, "Old Hall", WHISPERS, 0);
  const table = createCampaign(userId, { title: "Old table", description: "", theme: "high-fantasy", maxPlayers: 4, startingLevel: 9, difficulty: "normal" });
  const entered = row(table.id, "Old Entry", INVENTED, 1);
  origin(table.id, entered, prep.id, srcEntry);
  const ahead = row(table.id, "Old Hall", WHISPERS, 0);
  origin(table.id, ahead, prep.id, srcHall);
  const madeUp = row(table.id, "Fissure Passage", "A narrow fissure.", 1);
  // What a database from before the column holds.
  db.prepare(`UPDATE locations SET written_layout = '' WHERE id IN (?, ?, ?, ?, ?)`).run(srcEntry, srcHall, entered, ahead, madeUp);

  backfillWrittenLayouts(db);
  const read = (id) => db.prepare(`SELECT layout_description, written_layout FROM locations WHERE id = ?`).get(id);
  assert.equal(read(srcEntry).written_layout, ENTRY, "a workshop's place was not marked written");
  assert.equal(read(ahead).written_layout, WHISPERS, "an unvisited copy was not marked written");
  assert.equal(read(entered).written_layout, ENTRY, "an entered room did not get its pack text back");
  assert.equal(read(entered).layout_description, `${ENTRY}\n\n${SINCE_ARRIVAL} ${INVENTED}`);
  assert.equal(read(madeUp).written_layout, "", "a place made up in play was marked written");
  assert.equal(read(madeUp).layout_description, "A narrow fissure.");
});

// ---- the turn ----

await test("A reply that narrates the party into a written room as some other room is held back, and the model tells the arrival again from the text.", async () => {
  const model = await fakeModel();
  model.pointAt(world);
  const kara = world.addHero({ name: "Kara", class: "fighter", level: 5 });
  const userId = world.sheet(kara.id).userId;
  place("Cliff Door", "A sheer cliff with an opened stone door. Exit: west, a short passage straight into the Bone Hall.", ["Bone Hall"]);
  place("Bone Hall", "A carved cave 40 ft across, cold and damp. Exits: the passage east to the cliff, a stair down in the north-west corner, a narrow passage south.", ["Cliff Door"]);
  await world.invoke("move_party", { ...quiet, name: "Cliff Door" });

  model.script([
    reply({
      text: "You squeeze through a narrow fissure to a shallow pool and a hidden stone panel, then into a broad, low cavern.",
      calls: [call("move_party", { ...quiet, name: "Bone Hall", layoutDescription: "A narrow fissure, a shallow pool, a concealed stone panel and a broad low cavern with a water-filled cleft." })],
    }),
    reply({ text: "The passage runs a few paces west and opens into the Bone Hall: a carved cave about forty feet across, cold and damp. The way east leads back to the cliff; a stair falls away in the north-west corner, and a narrow passage leads south. What do you do?" }),
  ]);
  const dm = await model.turn(world, "We go through the door.", kara.id, userId);

  const shown = model.requests.map((request) => request.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n"));
  assert.ok(shown[0].includes("Rooms ahead, as the adventure writes them."), "the first call was not shown the room ahead");
  assert.ok(shown[0].includes("- Bone Hall: A carved cave 40 ft across"), "the first call did not see the Bone Hall's text");
  assert.ok(model.requests.length >= 2, "the invented arrival was not sent back");
  const nudge = model.requests[1].messages.filter((message) => message.role === "user").at(-1);
  assert.equal(nudge.content, writtenArrivalPrompt(["Bone Hall"]));
  const moved = model.results(model.requests[1]).at(-1).result;
  assert.ok(moved.note.includes("A carved cave 40 ft across"), "the move's result did not carry the written text");
  assert.ok(dm, "the turn wrote no narration");
  assert.equal(dm.content.includes("shallow pool"), false, "the invented arrival reached the table");
  assert.ok(dm.content.includes("opens into the Bone Hall"), "the retold arrival is not what the table read");
  assert.equal(getLocationByName(world.campaignId, "Bone Hall").layoutDescription.startsWith("A carved cave 40 ft across"), true);

  // A move told from the text, with no layout, needs no second call.
  place("Bone Stair", "A spiral stair cut into the rock, 60 ft down. Exits: up to the Bone Hall, down to a cavern.", ["Bone Hall"]);
  db.prepare(`UPDATE locations SET connections_json = ? WHERE id = ?`).run(JSON.stringify(["Cliff Door", "Bone Stair"]), getLocationByName(world.campaignId, "Bone Hall").id);
  model.script([
    reply({ text: "A spiral stair cut into the rock winds sixty feet down; the way back up leads to the Bone Hall. What do you do?", calls: [call("move_party", { ...quiet, name: "Bone Stair" })] }),
  ]);
  const plain = await model.turn(world, "We take the stair.", kara.id, userId);
  assert.equal(model.requests.length, 1, "a move told from the written text was sent back");
  assert.ok(plain.content.includes("A spiral stair cut into the rock"));
  model.close();
});

finish();

function minimalState() {
  return {
    campaign: {
      id: world.campaignId,
      title: "Test Campaign",
      description: "",
      difficulty: "normal",
      theme: "",
      scene: "",
      questLog: [],
      dmOutline: "",
      storyArc: null,
      gameSettings: {
        genre: "high_fantasy",
        customGenreText: "",
        tableLanguage: "english",
        aiStorySetup: true,
        dicePolicy: "digital_only",
        ttsEnabled: false,
        ttsVoice: "af_heart",
        mapsEnabled: false,
        midGameJoinOpen: false,
        holdSubmissions: false,
      },
    },
    members: [],
    sheets: [],
    recentRolls: [],
    storySummary: "",
  };
}
