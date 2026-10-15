// Whole DM turns, played against the fake model while the world moves
// between them (scripts/measure-prompt-cache.mjs): with the game state
// before the newest lines, the order a paid API gets
// (src/lib/dm/moment-placement.ts), each turn's prompt reuses the tools, the
// rules and the transcript, and writes little more than the game state and
// the lines since the last turn. With the game state in the system message,
// the changed state splits the prompt before the transcript.
import assert from "node:assert/strict";

// OpenAI's window as the table packs against it (src/lib/model-client.ts).
const saved = { context: process.env.OPENAI_COMPAT_CONTEXT, placement: process.env.DM_MOMENT_PLACEMENT };
process.env.OPENAI_COMPAT_CONTEXT = "128000";
const { measurePromptCache } = await import("./measure-prompt-cache.mjs");

async function run(placement) {
  process.env.DM_MOMENT_PLACEMENT = placement;
  try {
    // Only the DM's own requests: the helpers' prompts are below the size a
    // provider caches at all.
    const { rows } = await measurePromptCache({ turns: 5, seed: 24, log: false });
    return rows.filter((row) => /\.1$/.test(row.label)).slice(1);
  } finally {
    if (saved.placement === undefined) {
      delete process.env.DM_MOMENT_PLACEMENT;
    } else {
      process.env.DM_MOMENT_PLACEMENT = saved.placement;
    }
  }
}

// A table that has fought plays a fight that opens and closes mid-turn
// (MEASURE_FIGHT): with one tool list on every call (DM_STABLE_TOOLS, on by
// itself for OpenAI's own API), the call after the fight opens and the call
// after it closes reuse the tools, the rules and the transcript, and the
// model may call only what each call offered.
async function fight(stable) {
  const before = { placement: process.env.DM_MOMENT_PLACEMENT, stable: process.env.DM_STABLE_TOOLS };
  process.env.DM_MOMENT_PLACEMENT = "state-before-newest";
  process.env.DM_STABLE_TOOLS = stable ? "1" : "0";
  try {
    return await measurePromptCache({ turns: 8, seed: 24, log: false, fight: true, fought: true });
  } finally {
    for (const [key, value] of [["DM_MOMENT_PLACEMENT", before.placement], ["DM_STABLE_TOOLS", before.stable]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
const steady = await fight(true);
const swapped = await fight(false);
const row = (run, label) => run.rows.find((entry) => entry.label === label);
for (const label of ["turn 3.2", "turn 6.2"]) {
  const call = row(steady, label);
  assert.ok(call, `${label} was played`);
  assert.ok(call.written < call.total * 0.05, `${label}: the fight's opening or closing call reuses the prompt before it (${call.written} of ${call.total} chars written)`);
  assert.ok(row(swapped, label).written > call.written * 10, `${label}: with the offer as the tool list, the rules and the transcript were written again (${row(swapped, label).written} against ${call.written})`);
}
// The DM's calls; a helper's (the beat check) carries no tools.
const dmCalls = [...steady.bodies.entries()].filter(([, body]) => body.tools?.length);
assert.ok(dmCalls.length >= 10, `every turn's DM calls were measured (${dmCalls.length})`);
const toolLists = new Set(dmCalls.map(([, body]) => JSON.stringify(body.tools)));
assert.equal(toolLists.size, 1, "one tool list on every DM call, in the fight and out of it");
const allowed = (body) => (typeof body.tool_choice === "object" ? body.tool_choice.allowed_tools.tools.map((entry) => entry.function.name) : body.tool_choice);
const opening = allowed(steady.bodies.get("turn 3.1"));
const inFight = allowed(steady.bodies.get("turn 3.2"));
assert.ok(Array.isArray(opening) && opening.includes("start_encounter") && !opening.includes("end_turn"), "before the fight: the tools between fights");
assert.ok(Array.isArray(inFight) && inFight.includes("end_turn") && !inFight.includes("start_encounter"), "once it opens: the fight's");
assert.ok(steady.totals.cost < swapped.totals.cost * 0.7, `the evening's prompt cost less than 70% of swapping the lists (${steady.totals.cost} against ${swapped.totals.cost})`);

const placed = await run("state-before-newest");
const system = await run("system");
assert.equal(placed.length, 4, "four turns after the first, each with its DM request");
for (const [index, row] of placed.entries()) {
  assert.ok(
    row.written < row.total * 0.05,
    `turn ${index + 2}: the game state and the newest lines written, the rest reused (${row.written} of ${row.total} chars)`,
  );
  assert.ok(
    row.written < system[index].written / 2,
    `turn ${index + 2}: less than half what the state in the system message writes (${row.written} against ${system[index].written})`,
  );
}
if (saved.context === undefined) {
  delete process.env.OPENAI_COMPAT_CONTEXT;
} else {
  process.env.OPENAI_COMPAT_CONTEXT = saved.context;
}
console.log(`prompt cache: ${placed.length + 1} turns, each writing its game state and newest lines, not the transcript; a fight opens and closes on the same tool list`);
