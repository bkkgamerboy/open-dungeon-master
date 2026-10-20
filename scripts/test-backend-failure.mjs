// A model call the backend fails on its own side ("Backend request failed."
// in the middle of a price question). A public API's server error or cut
// stream is asked once more before the turn halts; whatever still fails
// halts with the backend's own reason on the notice, so the table can tell
// a blip from a refusal. A server on this machine or the LAN keeps the old
// behaviour: no second try (a crash crashes again) and its words stay in
// the log, where they may name its hosts.
//
// The pure rules first, then requestCustomMessage against a stubbed
// OpenAI Responses stream, then whole DM turns on the scripted fake model
// reached through a public-looking address.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";
import { failure, fakeModel, reply } from "./lib/enforce-narrator.mjs";

const { test, finish } = suite("test-backend-failure");

const { tableReason, transientFailureCode, transientHttpStatus } = await import("../src/lib/backend-failure.ts");
const { requestCustomMessage } = await import("../src/lib/model-client.ts");
const campaigns = await import("../src/lib/db/campaigns.ts");
const { listRecentMessages } = await import("../src/lib/db/messages.ts");
const { getDmTurn, getLatestDmTurnId } = await import("../src/lib/db/dm-turns.ts");
const { DM_HALTED_PREFIX } = await import("../src/lib/campaign-types.ts");

const OPENAI = "https://api.openai.com/v1";
const SERVER_ERROR =
  "The server had an error while processing your request. Sorry about that! You can retry your request.";

await test("The rules: which failures are blips, and which words reach the table.", () => {
  assert.equal(transientFailureCode("server_error"), true);
  assert.equal(transientFailureCode("rate_limit_exceeded"), true);
  assert.equal(transientFailureCode(undefined), true, "a failure that names no code reads as a blip");
  assert.equal(transientFailureCode("invalid_prompt"), false, "a refused prompt fails the same way twice");
  for (const status of [500, 502, 503]) assert.equal(transientHttpStatus(status), true, String(status));
  for (const status of [400, 401, 404, 429, 504]) assert.equal(transientHttpStatus(status), false, String(status));

  assert.equal(tableReason(SERVER_ERROR, OPENAI), SERVER_ERROR);
  assert.equal(
    tableReason(JSON.stringify({ error: { message: "Rate limit reached for gpt-6-luna.", type: "requests" } }), OPENAI),
    "Rate limit reached for gpt-6-luna.",
    "a JSON error body gives its message",
  );
  assert.equal(tableReason("CUDA out of memory on gpu0 at /srv/models", "http://192.168.1.20:8080/v1"), "", "a LAN server's words stay in the log");
  assert.equal(tableReason("crashed", "http://127.0.0.1:8001/v1"), "");
  assert.equal(tableReason("<html><body>502 Bad Gateway</body></html>", OPENAI), "", "an HTML error page is no sentence");
  assert.ok(tableReason("x ".repeat(400), OPENAI).length <= 200, "a long message is cut");
  assert.equal(tableReason("", OPENAI), "");
});

// ---- requestCustomMessage on OpenAI's Responses stream ----
const realFetch = globalThis.fetch;
let streamFailure = null;
const sse = (events) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
function stubOpenAi() {
  globalThis.fetch = async (url, init) => {
    const { pathname } = new URL(String(url));
    // As OpenAI answers a gpt-6 model's tool call on Chat Completions: the
    // client learns the Responses route from it, as the phone's has.
    if (pathname.endsWith("/chat/completions")) {
      return Response.json(
        {
          error: {
            message:
              "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
            type: "invalid_request_error",
            param: "reasoning_effort",
            code: null,
          },
        },
        { status: 400 },
      );
    }
    if (!pathname.endsWith("/responses")) return realFetch(url, init);
    if (streamFailure?.http) {
      return Response.json({ error: { message: streamFailure.message, type: "server_error" } }, { status: streamFailure.http });
    }
    if (streamFailure) {
      return sse([
        { type: "response.created", response: { status: "in_progress" } },
        { type: "response.failed", response: { status: "failed", error: { code: streamFailure.code, message: streamFailure.message } } },
      ]);
    }
    return sse([
      { type: "response.output_text.delta", delta: "Fine." },
      {
        type: "response.completed",
        response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Fine." }] }] },
      },
    ]);
  };
}
const ask = async (base) => {
  const result = await requestCustomMessage(base, "gpt-6-luna", "sk-test", [{ role: "user", content: "What is the standard rate?" }], {
    onDelta: () => {},
    tools: [{ type: "function", function: { name: "open_shop", description: "Open a shop.", parameters: { type: "object", properties: {} } } }],
  });
  return result.error ? { status: result.error.status, body: await result.error.json() } : { ok: result.message };
};

await test("OpenAI failing the stream with a server error: a blip worth one more try, its words fit for the table.", async () => {
  stubOpenAi();
  try {
    streamFailure = { code: "server_error", message: SERVER_ERROR };
    const failed = await ask(OPENAI);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, "Backend request failed.");
    assert.equal(failed.body.transient, true);
    assert.equal(failed.body.reason, SERVER_ERROR);
    assert.match(failed.body.detail, /^\[server_error\] /, "the log keeps the code");

    streamFailure = { code: "invalid_prompt", message: "Invalid prompt: flagged." };
    const refused = await ask(OPENAI);
    assert.equal(refused.body.transient, undefined, "a refused prompt is not asked again");
    assert.equal(refused.body.reason, "Invalid prompt: flagged.");

    streamFailure = { http: 500, message: SERVER_ERROR };
    const fell = await ask(OPENAI);
    assert.equal(fell.status, 500);
    assert.equal(fell.body.transient, true);
    assert.equal(fell.body.reason, SERVER_ERROR);

    streamFailure = null;
    const fine = await ask(OPENAI);
    assert.equal(fine.ok?.content, "Fine.");
  } finally {
    globalThis.fetch = realFetch;
    streamFailure = null;
  }
});

// ---- whole turns ----
const PUBLIC = "https://dm-cloud.example/v1";
const notices = (world) =>
  listRecentMessages(world.campaignId, 50).filter(
    (message) => message.authorType === "system" && message.content.startsWith(DM_HALTED_PREFIX),
  );

// The fake model, reached through a public address: fetch is stubbed to
// carry PUBLIC's calls to it, so the turn treats it as a public API.
async function publicTable() {
  const world = await openWorld({ gameSettings: { ttsEnabled: false } });
  const kara = world.addHero({ name: "Kara", class: "rogue", level: 3 });
  const model = await fakeModel();
  model.pointAt(world);
  const local = campaigns.getCampaignById(world.campaignId).settings.customBaseUrl;
  campaigns.updateStorySettings(world.campaignId, { customBaseUrl: PUBLIC });
  globalThis.fetch = (url, init) => realFetch(String(url).replace(PUBLIC, local), init);
  return { world, kara, model, local };
}

await test("A public API's server error on the first call is asked once more, and the turn narrates as if nothing happened.", async () => {
  const { world, kara, model } = await publicTable();
  try {
    model.script([failure(500, SERVER_ERROR), reply({ text: "Mother Fennick taps the board: two silver a pound, standard." })]);
    const said = await model.turn(world, "What is the standard rate", kara.id);
    assert.ok(said, "the retried call narrated nothing");
    assert.match(said.content, /two silver a pound/);
    assert.equal(notices(world).length, 0, "a blip the second try cleared still halted the table");
    assert.equal(getDmTurn(getLatestDmTurnId(world.campaignId)).status, "done");
    assert.equal(model.requests.length, 2, "one failed call and its one retry");
  } finally {
    globalThis.fetch = realFetch;
    model.close();
  }
});

await test("A public API that fails twice halts the turn once, and the notice carries its reason.", async () => {
  const { world, kara, model } = await publicTable();
  try {
    model.script([failure(500, SERVER_ERROR), failure(500, SERVER_ERROR)]);
    const said = await model.turn(world, "What is the standard rate", kara.id);
    assert.equal(said, null);
    const [notice, ...more] = notices(world);
    assert.ok(notice, "the table was not told the DM stopped");
    assert.equal(more.length, 0);
    assert.equal(notice.content, `${DM_HALTED_PREFIX}Backend request failed (500): ${SERVER_ERROR}`);
    assert.equal(getDmTurn(getLatestDmTurnId(world.campaignId)).status, "failed");
    assert.equal(model.requests.length, 2, "asked once more, and no more than that");
  } finally {
    globalThis.fetch = realFetch;
    model.close();
  }
});

await test("A server on this machine that falls over halts at once, its words kept off the table.", async () => {
  const world = await openWorld({ gameSettings: { ttsEnabled: false } });
  const kara = world.addHero({ name: "Kara", class: "rogue", level: 3 });
  const model = await fakeModel();
  model.pointAt(world);
  try {
    model.script([failure(500, "CUDA out of memory on /srv/models/gpu0"), reply({ text: "Never asked." })]);
    const said = await model.turn(world, "What is the standard rate", kara.id);
    assert.equal(said, null);
    const [notice] = notices(world);
    assert.equal(notice.content, `${DM_HALTED_PREFIX}Backend request failed (500).`);
    assert.equal(model.requests.length, 1, "a local server was asked again");
  } finally {
    model.close();
  }
});

finish();
