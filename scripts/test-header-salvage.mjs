// A tool call's recipient header leaked into the narration (build 16).
//
// An OpenAI-format model addresses a tool internally with a header
// ("assistant to=functions.request_player_input json {...}"). When the
// serving side fails to turn it into a structured call, the header lands in
// the reply as text, usually with junk a broken decode glued around it. One
// reached the table word for word on the phone:
//
//   ...How many shall I put your name down for?
//   ระassistant
//   to=functions.request_player_input$aritycom 玩彩神争霸jsonablytyped ⌫
//
// Held here: the header and everything after it is cut from the narration,
// what is already stored is cut at display and before speech, the live
// stream stops at it, a header whose arguments survived runs as that call,
// and prose that merely says "to" or "assistant" is left alone. Pure helpers
// first, then the real turn machine against a fake OpenAI-compatible server.
//
// Usage: node scripts/test-header-salvage.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";
import { answerReader, isReaderRequest } from "./lib/claims-reader.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-header-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.OPENAI_COMPAT_CONTEXT = "65536";

register("./lib/register-alias.mjs", import.meta.url);

const { findHeaderLeaks, stripToolText } = await import("../src/lib/dm/tool-text.ts");
const { salvageHeaderToolCalls } = await import("../src/lib/dm/json-salvage.ts");
const { createStreamingArtifactFilter } = await import("../src/lib/story-prompt.ts");
const { stripForSpeech } = await import("../src/lib/speech-text.ts");
const { createUser } = await import("../src/lib/db/users.ts");
const { createCampaign, getCampaignById, getFloor, setCampaignStatus, updateStorySettings, allocateSeq } =
  await import("../src/lib/db/campaigns.ts");
const { createSheet } = await import("../src/lib/db/sheets.ts");
const { createSheetSchema } = await import("../src/lib/schemas/sheet.ts");
const { insertCampaignMessage, listRecentMessages } = await import("../src/lib/db/messages.ts");
const { startDmTurn, dmTurnToolCatalogue } = await import("../src/lib/dm/turn.ts");

const PROSE =
  "Mother Fennick's eyes crinkle kindly.\n\n**Mother Fennick:** \"For you, duckling, I'll set aside healing potions from my next batch. They'll be 50 gold each. How many shall I put your name down for?\"";
const LEAK = "\n\nระassistant\nto=functions.request_player_input$aritycom 玩彩神争霸jsonablytyped ⌫";

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`ok: ${label}`);
}

// ---- the pure helpers --------------------------------------------------------
{
  assert.equal(stripToolText(PROSE + LEAK), PROSE);
  assert.equal(findHeaderLeaks(PROSE + LEAK)[0].name, "request_player_input");
  assert.equal(findHeaderLeaks(PROSE + LEAK)[0].args, null);
  ok("the phone's leak is cut back to the prose, role word and junk included");

  for (const prose of [
    "She went to the functions hall at dawn.",
    "The mayor's assistant to the left of the door bows.",
    "Commentary from the crowd: to arms!",
    "Set the dial to = 3, the gnome says.",
  ]) {
    assert.equal(stripToolText(prose), prose, prose);
  }
  ok("prose that only says 'to', 'assistant' or 'functions' is left alone");

  const shapes = [
    "The door creaks open.\nassistant to=functions.request_player_input json {\"characterIds\":[\"c1\"],\"prompt\":\"What now?\"}",
    "The door creaks open.<|start|>assistant<|channel|>commentary to=functions.request_player_input <|constrain|>json<|message|>{\"characterIds\":[\"c1\"],\"prompt\":\"What now?\"}<|call|>",
    "The door creaks open. commentary to=functions.request_player_input code{\"characterIds\":[\"c1\"],\"prompt\":\"What now?\"}",
  ];
  for (const leaked of shapes) {
    assert.equal(stripToolText(leaked).replace(/<\|[a-z]+\|>/g, "").trim(), "The door creaks open.", leaked);
  }
  ok("the header's other shapes (with and without the special tokens) go too");

  // Prose after a call whose arguments parsed is kept.
  const after = 'The door creaks open.\nassistant to=functions.request_roll json {"characterId":"c1","kind":"skill_check","skill":"perception","reason":"listening"}\nSomething stirs below.';
  assert.equal(stripToolText(after).replace(/\n+/g, "\n"), "The door creaks open.\nSomething stirs below.");
  ok("a line of prose after a parsed call is kept");

  assert.ok(!/to=functions|assistant|aritycom/.test(stripForSpeech(PROSE + LEAK)), "speech never reads the header aloud");
  ok("speech text drops the header");
}

{
  const pieces = [
    "Mother Fennick's eyes crinkle kindly. How many shall I put your name down for?\n\nระassist",
    "ant\nto=functions.request_",
    "player_input$aritycom 玩彩神争霸json",
    "ablytyped ⌫",
  ];
  const filter = createStreamingArtifactFilter();
  const streamed = pieces.map((piece) => filter.push(piece)).join("") + filter.flush();
  assert.equal(streamed.trim(), "Mother Fennick's eyes crinkle kindly. How many shall I put your name down for?");
  assert.ok(!/assist/.test(streamed));
  const plain = createStreamingArtifactFilter();
  const prose = ["The mayor's assistant", " bows low."].map((piece) => plain.push(piece)).join("") + plain.flush();
  assert.equal(prose, "The mayor's assistant bows low.");
  ok("the live stream stops at the header and holds a role word only until the next chunk");
}

// ---- the salvage, against the real tool catalogue ------------------------------
const lead = createUser(`lead${randomBytes(3).toString("hex")}`, "x", { isAdmin: true });
const probe = createCampaign(lead.id, {
  title: "Catalogue probe",
  description: "Reads the tool catalogue.",
  theme: "market town",
  maxPlayers: 2,
  startingLevel: 1,
  difficulty: "normal",
  gameSettings: { ttsEnabled: false },
});
const catalogue = dmTurnToolCatalogue(getCampaignById(probe.id), false, false);
{
  const junk = salvageHeaderToolCalls(PROSE + LEAK, catalogue);
  assert.equal(junk.text, PROSE);
  assert.equal(junk.calls.length, 0, "arguments lost to the decode leave nothing to run");
  const asked = salvageHeaderToolCalls(
    'The door creaks.\nassistant to=functions.request_player_input json {"characterIds":["c1"],"prompt":"What now?"}',
    catalogue,
  );
  assert.equal(asked.text, "The door creaks.");
  assert.deepEqual(asked.calls.map((call) => call.name), ["request_player_input"]);
  const missing = salvageHeaderToolCalls('Rain.\nassistant to=functions.request_player_input json {"prompt":"What now?"}', catalogue);
  assert.equal(missing.calls.length, 0, "a call missing a required argument does not run");
  const unknown = salvageHeaderToolCalls('Rain.\nassistant to=functions.dance_wildly json {"style":"jig"}', catalogue);
  assert.equal(unknown.text, "Rain.");
  assert.equal(unknown.calls.length, 0, "an unknown tool is cut, never run");
  ok("a header with whole arguments runs as its call; lost, partial or unknown ones are only cut");
}

// ---- the turn machine ----------------------------------------------------------
let script = [];
let calls = 0;
let sheetId = "";
function sse(res, deltas) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const delta of deltas) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (isReaderRequest(body)) {
      answerReader(res);
      return;
    }
    const reply = script[calls] ?? "narrate";
    if (reply === "leak") {
      // Streamed the way the model sent it: the header split across chunks.
      sse(res, [{ content: PROSE }, { content: "\n\nระassist" }, { content: "ant\nto=functions.request_player_input$arity" }, { content: "com 玩彩神争霸jsonablytyped ⌫" }]);
    } else if (reply === "leak-with-args") {
      sse(res, [
        { content: "The door creaks open." },
        { content: `\nassistant to=functions.request_player_input json ${JSON.stringify({ characterIds: [sheetId], prompt: "What now?" })}` },
      ]);
    } else {
      sse(res, [{ content: "The fog rolls in." }]);
    }
    calls += 1;
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

function table(title) {
  const campaign = createCampaign(lead.id, {
    title,
    description: "A test of the header salvage.",
    theme: "market town",
    maxPlayers: 2,
    startingLevel: 1,
    difficulty: "normal",
    gameSettings: { ttsEnabled: false },
  });
  updateStorySettings(campaign.id, {
    textProvider: "custom",
    customBaseUrl: baseUrl,
    customModel: "fake",
    imageGenerationEnabled: false,
    autoImages: false,
  });
  setCampaignStatus(campaign.id, "active");
  const sheet = createSheet(
    campaign.id,
    lead.id,
    1,
    createSheetSchema.parse({
      name: "Swift Fingers",
      race: "halfling",
      class: "rogue",
      abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 10, cha: 14 },
      maxHp: 9,
      ac: 14,
      hitDice: { die: "d8", total: 1, spent: 0 },
      proficiencies: { saves: ["dex", "int"], skills: ["persuasion"], languages: ["common"], tools: [], armor: [], weapons: [] },
    }),
  );
  sheetId = sheet.id;
  insertCampaignMessage({
    campaignId: campaign.id,
    seq: allocateSeq(campaign.id),
    authorType: "player",
    userId: lead.id,
    characterId: sheet.id,
    content: "I ask Mother Fennick to set some potions aside for me.",
  });
  return campaign;
}

async function run(title, replies) {
  script = replies;
  calls = 0;
  const campaign = table(title);
  await startDmTurn(campaign.id);
  const dm = listRecentMessages(campaign.id, 20).filter((message) => message.authorType === "dm");
  return { campaign, text: dm.at(-1)?.content ?? "" };
}

const leaked = await run("Header leak", ["leak"]);
assert.equal(leaked.text.trim(), PROSE, `stored: ${JSON.stringify(leaked.text)}`);
ok("the turn stores the prose and none of the header");

const withArgs = await run("Header leak with arguments", ["leak-with-args", "narrate"]);
assert.ok(!/to=functions|assistant/.test(withArgs.text), `stored: ${JSON.stringify(withArgs.text)}`);
assert.match(withArgs.text, /The door creaks open\./);
assert.equal(getFloor(withArgs.campaign.id).mode, "spotlight", "the salvaged request_player_input handed the player the floor");
ok("a header with its arguments runs as the call and never reaches the table");

server.close();
removeTempDir(dir);
console.log(`PASS: ${passed} header-salvage checks.`);
