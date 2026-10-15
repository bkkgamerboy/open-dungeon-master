// How much of each DM turn's prompt a provider that caches the prompt's
// start (OpenAI, from GPT-5.6 on) could reuse from the turns before it, and
// how much it would write to its cache again at 1.25x the input price.
//
// A scripted table plays a run of turns against the fake model
// (scripts/lib/enforce-narrator.mjs), and between them the world moves the
// way play moves it: the scene line changes, a hero is hurt, time passes, an
// NPC is met, the newest player line re-picks the arc's planned events. Each
// DM request is flattened the way a provider tokenizes it (tools, then the
// messages in order), and its reused part is the longest start it shares
// with any request before it, counted only past the 1,024-token minimum
// (4,096 characters at the codebase's chars/4 proxy).
//
// The fake model runs on this machine, so it gets a local model's order
// unless the placement is forced (src/lib/dm/moment-placement.ts):
//
//   DM_MOMENT_PLACEMENT=state-before-newest node scripts/measure-prompt-cache.mjs   a paid API's order
//   DM_MOMENT_PLACEMENT=system node scripts/measure-prompt-cache.mjs                the state in the system message
//
// OPENAI_COMPAT_CONTEXT=128000 packs against OpenAI's window; MEASURE_SEED
// (exchanges played before the run, 24), MEASURE_TURNS (8) and
// MEASURE_NARRATION_REPEAT (how long each narration runs, 4) size the table:
// MEASURE_SEED=50 MEASURE_NARRATION_REPEAT=9 fills the transcript past its
// share of the window, so the cut from the front is in play. Prints one line
// per request and the totals, and fails only on a broken run, never on the
// numbers: scripts/test-prompt-cache.mjs holds the assertions.
import { openWorld } from "./lib/enforce-world.mjs";
import { fakeModel, reply } from "./lib/enforce-narrator.mjs";

export async function measurePromptCache({ turns = 8, seed = 24, log = true } = {}) {
  const world = await openWorld({ campaign: { description: "A drowned cathedral rises from the salt flats." } });
  const { setStoryArc, setCampaignScene } = await import("../src/lib/db/campaigns.ts");
  const { normalizeStoryArc } = await import("../src/lib/dm/arc-logic.ts");
  const hero = world.addHero({ class: "fighter", level: 3 });
  setStoryArc(
    world.campaignId,
    normalizeStoryArc({
      premise: "The heart wakes beneath the drowned cathedral.",
      beats: [
        { text: "Leave Halvord's Reach.", status: "done", act: 1 },
        { text: "Cross the glass plain to the drowned cathedral.", status: "active", act: 1 },
        { text: "Confront the vicar.", status: "pending", act: 1 },
      ],
      events: [
        { name: "Salt storm", detail: "A wall of salt rolls over the plain and hides the path.", trigger: "travel across the plain" },
        { name: "The ferryman", detail: "An old ferryman offers passage across the brine for a secret.", trigger: "the river or the brine" },
        { name: "Husk ambush", detail: "Salt-glass husks rise from the ground around the party.", trigger: "camping or resting" },
        { name: "Bell toll", detail: "The cathedral bell rings from under the water.", trigger: "approach the cathedral" },
        { name: "Pilgrim's plea", detail: "A pilgrim begs the party to carry a relic to the vicar.", trigger: "talk to pilgrims" },
      ],
    }),
  );
  // A table some way into its evening: a transcript of play before this run.
  // Varied prose, so the stream guard's repetition check lets it through.
  const words = ["salt", "glass", "bell", "dune", "brine", "lantern", "pilgrim", "husk", "shrine", "tide", "wind", "ash", "rope", "ferry", "vicar", "relic", "spire", "mist", "crow", "chain"];
  const verbs = ["glints", "shifts", "rings", "cracks", "hums", "drifts", "settles", "sways", "flickers", "creaks"];
  const narration = (index) => {
    const sentences = [];
    const count = 4 + Number(process.env.MEASURE_NARRATION_REPEAT || 4) * 2;
    for (let at = 0; at < count; at += 1) {
      const a = words[(index * 7 + at * 3) % words.length];
      const b = words[(index * 11 + at * 5 + 1) % words.length];
      const v = verbs[(index * 13 + at) % verbs.length];
      sentences.push(`The ${a} ${v} near the ${b} as passage ${index} turns ${at}.`);
    }
    return sentences.join(" ");
  };
  for (let index = 0; index < seed; index += 1) {
    world.say("player", `I keep walking and watch the horizon, step ${index}.`, hero);
    world.say("dm", narration(index));
  }
  const model = await fakeModel();
  await model.pointAt(world);
  model.script([]);

  const lines = [
    "I ask the pilgrims about the cathedral.",
    "I look for the river and the old ferry.",
    "We make camp for the night behind a dune.",
    "I walk toward the bell and the drowned cathedral.",
    "I search the salt for tracks.",
    "I ask the ferryman his price.",
    "I rest and bandage my arm.",
    "I travel across the plain at first light.",
  ];
  // Between turns, the world moves as play moves it.
  const moves = [
    () => setCampaignScene(world.campaignId, "Pilgrims huddle around a salt-crusted shrine."),
    () => world.patch(hero.id, { hp: Math.max(1, world.sheet(hero.id).hp - 4) }),
    () => world.invoke("pass_time", { minutes: 90, reason: "travel" }),
    () => world.invoke("set_npc", { name: "Brisca Hale", attitude: "friendly", trait: "a salt-stained guide" }),
    () => {},
    () => setCampaignScene(world.campaignId, "The ferry rocks at the edge of the brine."),
    () => world.patch(hero.id, { hp: world.sheet(hero.id).maxHp }),
    () => world.invoke("pass_time", { minutes: 480, reason: "rest" }),
  ];

  const MIN_CHARS = 4_096;
  const flat = (request) =>
    [
      JSON.stringify(request.tools ?? []),
      ...request.messages.map((message) => `<${message.role}>${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}${message.tool_calls ? JSON.stringify(message.tool_calls) : ""}`),
    ].join("\n");
  const seen = [];
  const rows = [];
  const account = (label, request) => {
    const text = flat(request);
    let best = 0;
    for (const earlier of seen) {
      const limit = Math.min(earlier.length, text.length);
      let at = 0;
      while (at < limit && earlier.charCodeAt(at) === text.charCodeAt(at)) {
        at += 1;
      }
      best = Math.max(best, at);
    }
    const reused = best >= MIN_CHARS ? best : 0;
    if (process.env.MEASURE_SHOW_SPLIT && seen.length) {
      console.log(`   splits at: ${JSON.stringify(text.slice(Math.max(0, best - 160), best + 120))}`);
    }
    seen.push(text);
    rows.push({ label, total: text.length, reused, written: text.length - reused });
    if (log) {
      console.log(`${label.padEnd(10)} prompt ${String(text.length).padStart(7)} chars  reused ${String(reused).padStart(7)}  written ${String(text.length - reused).padStart(7)}`);
    }
  };

  try {
    for (let index = 0; index < turns; index += 1) {
      await moves[index % moves.length]();
      // script() starts the request log afresh.
      model.script([reply({ text: narration(100 + index) })]);
      const said = await model.turn(world, lines[index % lines.length], hero.id);
      if (!said && log) {
        console.log(`turn ${index + 1}: no narration stored`);
      }
      model.requests.forEach((request, call) => account(`turn ${index + 1}.${call + 1}`, request));
    }
  } finally {
    model.close();
    world.close();
  }
  const sum = (key) => rows.slice(1).reduce((total, row) => total + row[key], 0);
  const totals = { prompt: sum("total"), reused: sum("reused"), written: sum("written") };
  if (log) {
    console.log(
      `after the first turn: ${totals.prompt} chars sent, ${totals.reused} reused (${((totals.reused / totals.prompt) * 100).toFixed(0)}%), ${totals.written} written (${((totals.written / totals.prompt) * 100).toFixed(0)}%)`,
    );
  }
  return { rows, totals };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await measurePromptCache({ seed: Number(process.env.MEASURE_SEED || 24), turns: Number(process.env.MEASURE_TURNS || 8) });
}
