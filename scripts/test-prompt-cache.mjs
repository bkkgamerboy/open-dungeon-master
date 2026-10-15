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
console.log(`prompt cache: ${placed.length + 1} turns, each writing its game state and newest lines, not the transcript`);
