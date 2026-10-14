// A device's own voice reading the table's passages (src/lib/phone-voice.ts,
// src/lib/native-speech.ts): which voice reads, which passages are handed to
// it and when, and that it reads the same words the server's narration does.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { pickNarrationEngine, serverCannotNarrate, phoneRateFrom, passageKey, PHONE_RATE_MAX, PHONE_RATE_MIN } = await import(
  "../src/lib/phone-voice.ts"
);
const { stripForSpeech } = await import("../src/lib/speech-text.ts");
const { campaignReducer, INITIAL_CAMPAIGN_STATE } = await import("../src/app/campaigns/[campaignId]/useCampaignStream.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

test("a device without a voice always follows the server", () => {
  for (const server of [null, { provider: "off", configured: false }, { provider: "kokoro", configured: true }]) {
    assert.equal(pickNarrationEngine({ phone: false, always: true, server }), "server");
  }
});

test("the phone reads where the server cannot narrate", () => {
  assert.equal(pickNarrationEngine({ phone: true, always: false, server: { provider: "off", configured: false } }), "phone");
  // An OpenAI-kind server with no model picked reads nothing either.
  assert.equal(pickNarrationEngine({ phone: true, always: false, server: { provider: "openai", configured: false } }), "phone");
  // A server older than the provider field, with no narration.
  assert.equal(pickNarrationEngine({ phone: true, always: false, server: { configured: false } }), "phone");
});

test("where the server narrates, the phone reads only when asked to", () => {
  const kokoro = { provider: "kokoro", configured: true };
  assert.equal(pickNarrationEngine({ phone: true, always: false, server: kokoro }), "server");
  assert.equal(pickNarrationEngine({ phone: true, always: true, server: kokoro }), "phone");
});

test("before the server answers, nothing is assumed about it", () => {
  assert.equal(serverCannotNarrate(null), false);
  assert.equal(serverCannotNarrate(undefined), false);
  assert.equal(pickNarrationEngine({ phone: true, always: false, server: null }), "server");
  assert.equal(pickNarrationEngine({ phone: true, always: true, server: null }), "phone");
});

test("a saved speed is read defensively", () => {
  assert.equal(phoneRateFrom(null), 1);
  assert.equal(phoneRateFrom(""), 1);
  assert.equal(phoneRateFrom("abc"), 1);
  assert.equal(phoneRateFrom("1.25"), 1.25);
  assert.equal(phoneRateFrom("9"), PHONE_RATE_MAX);
  assert.equal(phoneRateFrom("0"), PHONE_RATE_MIN);
});

test("a passage read again with new prose is a new take", () => {
  assert.notEqual(passageKey("m1", 11), passageKey("m1", 14));
  assert.equal(passageKey("m1", 11), passageKey("m1", 11));
});

test("the phone hears the words the server's narration would", () => {
  const passage = "**The door** creaks. [roll:1234-abcd] `x`\n\n> \"Who goes there?\" the guard asks.";
  assert.equal(stripForSpeech(passage), 'The door creaks. x\n"Who goes there?" the guard asks.');
  assert.equal(stripForSpeech("[request_roll characterId=a kind=custom]"), "");
});

const event = (eventType, payload = {}, seq = null) => ({ type: "event", eventType, seq, payload });
const loaded = campaignReducer(INITIAL_CAMPAIGN_STATE, { type: "snapshot", payload: { lastSeq: 10, dmStatus: "idle" } });
const dm = (id, seq, content) => ({ id, seq, authorType: "dm", content, speech: [] });

test("a new DM passage is the latest passage; a player's words and system lines are not", () => {
  assert.equal(loaded.latestPassage, null);
  const narrated = campaignReducer(loaded, event("message_added", { message: dm("m1", 11, "The door creaks.") }, 11));
  assert.deepEqual(narrated.latestPassage, { messageId: "m1", seq: 11 });
  const player = campaignReducer(narrated, event("message_added", { message: { id: "p1", seq: 12, authorType: "player", content: "I open it." } }, 12));
  assert.deepEqual(player.latestPassage, { messageId: "m1", seq: 11 });
  const system = campaignReducer(player, event("message_added", { message: { id: "s1", seq: 13, authorType: "system", content: "Initiative." } }, 13));
  assert.deepEqual(system.latestPassage, { messageId: "m1", seq: 11 });
});

test("a beat records what the table already heard and is not read aloud", () => {
  const beat = campaignReducer(loaded, event("message_added", { message: dm("b1", 11, "They won."), beat: true }, 11));
  assert.equal(beat.latestPassage, null);
});

test("the same passage sent again unchanged is not read twice", () => {
  const first = campaignReducer(loaded, event("message_added", { message: dm("m1", 11, "The door creaks.") }, 11));
  const echo = campaignReducer(first, event("message_added", { message: dm("m1", 11, "The door creaks.") }, 12));
  assert.deepEqual(echo.latestPassage, { messageId: "m1", seq: 11 });
});

test("new prose the server reads again is read again; an edit or a correction is not", () => {
  const first = campaignReducer(loaded, event("message_added", { message: dm("m1", 11, "The door creaks.") }, 11));
  const edited = campaignReducer(first, event("message_updated", { message: dm("m1", 11, "The door creaks open.") }, 12));
  assert.deepEqual(edited.latestPassage, { messageId: "m1", seq: 11 }, "a typo fixed is not read again");
  assert.equal(edited.messages[0].content, "The door creaks open.");
  const rerolled = campaignReducer(edited, event("message_updated", { message: dm("m1", 11, "A wind howls."), narrate: true }, 13));
  assert.deepEqual(rerolled.latestPassage, { messageId: "m1", seq: 13 });
});

console.log(`test-phone-voice: ${passed} passed`);
