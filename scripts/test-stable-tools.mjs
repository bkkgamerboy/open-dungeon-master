// One tool list on every call to OpenAI's own API, with the call's offer
// as tool_choice allowed_tools (src/lib/stable-tools.ts): the pure choice
// first, then requestCustomMessage against a fake OpenAI (fetch is stubbed,
// so the base URL is api.openai.com itself) on both tool routes, a backend
// that refuses the choice, and the backends that never get it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stable-tools-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
delete process.env.DM_STABLE_TOOLS;

register("./lib/register-alias.mjs", import.meta.url);

const { requestCustomMessage } = await import("../src/lib/model-client.ts");
const {
  chatToolChoice,
  refusesAllowedTools,
  responsesToolChoice,
  sendsStableTools,
  stableToolChoice,
  uniqueTools,
} = await import("../src/lib/stable-tools.ts");

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`ok: ${name}`);
};

const tool = (name, description = `The ${name} tool.`) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: {} } },
});
const ROLL = tool("request_roll");
const ATTACK = tool("pc_attack");
const SHOP = tool("open_shop");
const STABLE = [ROLL, ATTACK, SHOP];

// --- the choice on its own ------------------------------------------------
assert.deepEqual(stableToolChoice(STABLE, [ROLL, ATTACK], "auto"), { allowed: ["request_roll", "pc_attack"] });
assert.equal(stableToolChoice(STABLE, [SHOP, ATTACK, ROLL], undefined), "auto", "the whole list offered, in any order, is plain auto");
assert.equal(stableToolChoice(STABLE, [ROLL], "none"), "none", "a call that may only narrate");
assert.equal(stableToolChoice(STABLE, [], "auto"), "none", "nothing offered, nothing callable");
assert.deepEqual(stableToolChoice(STABLE, [tool("pc_attack")], "auto"), { allowed: ["pc_attack"] }, "a definition rebuilt the same is the list's");
assert.equal(stableToolChoice(STABLE, [tool("pc_attack", "Another text.")], "auto"), null, "a definition that differs from the list's: the offer goes out as it is");
assert.equal(stableToolChoice(STABLE, [tool("brand_new")], "auto"), null, "a tool the list does not hold");
assert.deepEqual(uniqueTools([ROLL, ATTACK, tool("request_roll"), SHOP]).map((entry) => entry.function.name), ["request_roll", "pc_attack", "open_shop"]);
ok("the choice offers exactly the call's tools, or stands aside");

assert.deepEqual(chatToolChoice({ allowed: ["request_roll"] }), {
  type: "allowed_tools",
  allowed_tools: { mode: "auto", tools: [{ type: "function", function: { name: "request_roll" } }] },
});
assert.deepEqual(responsesToolChoice({ allowed: ["request_roll"] }), {
  type: "allowed_tools",
  mode: "auto",
  tools: [{ type: "function", name: "request_roll" }],
});
assert.equal(chatToolChoice("none"), "none");
assert.equal(responsesToolChoice("auto"), "auto");
ok("allowed_tools in each API's shape (openai-node 7.34 ChatCompletionAllowedToolChoice, ToolChoiceAllowed)");

assert.equal(sendsStableTools("openai"), true);
assert.equal(sendsStableTools("openrouter"), false);
assert.equal(sendsStableTools("local"), false);
assert.equal(sendsStableTools("local", { DM_STABLE_TOOLS: "1" }), true);
assert.equal(sendsStableTools("openai", { DM_STABLE_TOOLS: "0" }), false);
assert.ok(refusesAllowedTools("Invalid value: 'allowed_tools'. Supported values are: 'none', 'auto' and 'required'."));
assert.ok(!refusesAllowedTools("Unsupported parameter: 'temperature' is not supported with this model."));
ok("only OpenAI's own API gets it, unless the operator says otherwise");

// --- against a fake OpenAI ------------------------------------------------
const GPT6_REFUSAL = (model) => ({
  error: {
    message: `Function tools with reasoning_effort are not supported for ${model} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`,
    type: "invalid_request_error",
    param: "reasoning_effort",
    code: null,
  },
});
const ALLOWED_REFUSAL = {
  error: { message: "Invalid value: 'allowed_tools'. Supported values are: 'none', 'auto' and 'required'.", type: "invalid_request_error", param: "tool_choice", code: "invalid_value" },
};
const seen = [];
const fakeOpenAi = async (url, init) => {
  const { hostname, pathname } = new URL(String(url));
  const body = JSON.parse(init.body);
  seen.push({ host: hostname, path: pathname, body });
  const model = String(body.model);
  if (model.endsWith("-old") && typeof body.tool_choice === "object") {
    return Response.json(ALLOWED_REFUSAL, { status: 400 });
  }
  if (pathname.endsWith("/chat/completions")) {
    if (/^gpt-6/.test(model) && body.tools?.length && body.reasoning_effort !== "none") {
      return Response.json(GPT6_REFUSAL(model), { status: 400 });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "The door creaks." } }] });
  }
  if (pathname.endsWith("/responses")) {
    if (body.temperature !== undefined) {
      return Response.json(
        { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", param: "temperature", code: "unsupported_parameter" } },
        { status: 400 },
      );
    }
    return Response.json({
      id: "resp_1",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "The door creaks." }] }],
    });
  }
  return new Response("nope", { status: 404 });
};

const realFetch = globalThis.fetch;
globalThis.fetch = fakeOpenAi;
const OPENAI = "https://api.openai.com/v1";
const ask = [{ role: "user", content: "I open the door." }];
const last = () => seen.at(-1).body;
const names = (tools) => tools.map((entry) => entry.function?.name ?? entry.name);

try {
  // GPT-6 learns the Responses route on its first call with tools, as in
  // scripts/test-openai-tool-routes.mjs; every call after that is there.
  {
    seen.length = 0;
    const first = await requestCustomMessage(OPENAI, "gpt-6-luna", "sk-test", ask, { tools: [ROLL, ATTACK], stableTools: STABLE });
    assert.ok(!first.error, first.error ? await first.error.text() : "");
    assert.equal(seen[0].path, "/v1/chat/completions");
    assert.deepEqual(names(seen[0].body.tools), names(STABLE), "the whole list on the first try too");
    assert.equal(seen.at(-1).path, "/v1/responses");
    assert.deepEqual(names(last().tools), names(STABLE), "the whole list, in its order");
    assert.deepEqual(last().tool_choice, { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "request_roll" }, { type: "function", name: "pc_attack" }] });

    seen.length = 0;
    await requestCustomMessage(OPENAI, "gpt-6-luna", "sk-test", ask, { tools: [ROLL, SHOP], stableTools: STABLE });
    await requestCustomMessage(OPENAI, "gpt-6-luna", "sk-test", ask, { tools: [], toolChoice: "none", stableTools: STABLE });
    await requestCustomMessage(OPENAI, "gpt-6-luna", "sk-test", ask, { tools: STABLE, stableTools: STABLE });
    assert.equal(seen.length, 3, "one request each, nothing refused");
    assert.deepEqual(seen.map((request) => JSON.stringify(request.body.tools)), Array(3).fill(JSON.stringify(seen[0].body.tools)), "the same tools on every call");
    assert.deepEqual(seen[0].body.tool_choice.tools.map((entry) => entry.name), ["request_roll", "open_shop"]);
    assert.equal(seen[1].body.tool_choice, "none", "a call with its tools closed keeps the list and calls none");
    assert.equal(seen[2].body.tool_choice, "auto", "the whole list offered");
  }
  ok("GPT-6 on the Responses route: one tool list, the offer as allowed_tools");

  {
    seen.length = 0;
    const result = await requestCustomMessage(OPENAI, "gpt-4.1", "sk-test", ask, { tools: [ATTACK], stableTools: STABLE });
    assert.ok(!result.error);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/v1/chat/completions");
    assert.deepEqual(names(last().tools), names(STABLE));
    assert.deepEqual(last().tool_choice, { type: "allowed_tools", allowed_tools: { mode: "auto", tools: [{ type: "function", function: { name: "pc_attack" } }] } });
  }
  ok("Chat Completions: the same, in its own shape");

  {
    seen.length = 0;
    const result = await requestCustomMessage(OPENAI, "gpt-4.1-old", "sk-test", ask, { tools: [ATTACK], stableTools: STABLE });
    assert.ok(!result.error, result.error ? await result.error.text() : "");
    assert.equal(seen.length, 2, "refused once, then sent as before");
    assert.deepEqual(names(seen[1].body.tools), ["pc_attack"], "the offer as the tool list");
    assert.equal(seen[1].body.tool_choice, "auto");
    seen.length = 0;
    await requestCustomMessage(OPENAI, "gpt-4.1-old", "sk-test", ask, { tools: [ROLL], stableTools: STABLE });
    assert.equal(seen.length, 1, "not asked again");
    assert.deepEqual(names(last().tools), ["request_roll"]);
  }
  ok("a backend that refuses allowed_tools is sent the offer, and not asked again");

  {
    seen.length = 0;
    await requestCustomMessage("https://openrouter.ai/api/v1", "openai/gpt-4.1", "sk-test", ask, { tools: [ATTACK], stableTools: STABLE });
    assert.deepEqual(names(last().tools), ["pc_attack"], "OpenRouter: the offer as before");
    assert.equal(last().tool_choice, "auto");
    process.env.DM_STABLE_TOOLS = "0";
    seen.length = 0;
    await requestCustomMessage(OPENAI, "gpt-4.1", "sk-test", ask, { tools: [ATTACK], stableTools: STABLE });
    assert.deepEqual(names(last().tools), ["pc_attack"], "turned off by the operator");
    delete process.env.DM_STABLE_TOOLS;
    seen.length = 0;
    await requestCustomMessage(OPENAI, "gpt-4.1", "sk-test", ask, { tools: [ATTACK, tool("brand_new")], stableTools: STABLE });
    assert.deepEqual(names(last().tools), ["pc_attack", "brand_new"], "an offer the list does not cover goes out as it is");
    seen.length = 0;
    await requestCustomMessage(OPENAI, "gpt-4.1", "sk-test", ask, { tools: [ATTACK] });
    assert.deepEqual(names(last().tools), ["pc_attack"], "no list from the caller: as before");
  }
  ok("everywhere else, and with no list or one that cannot stand in, the offer goes out as before");
} finally {
  globalThis.fetch = realFetch;
  removeTempDir(dir);
}

console.log(`stable tools: ${passed} checks passed`);
