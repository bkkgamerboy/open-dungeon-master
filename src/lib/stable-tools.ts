// One tool list for a whole table on OpenAI's own API, with each call's
// offer sent as the subset the model may call.
//
// OpenAI caches a prompt from its start, and the tool definitions ARE its
// start: they come before the system message and the transcript. The DM's
// set changes when a fight begins or ends (src/lib/dm/turn.ts
// dmTurnTools), and a tools-closed rescue sent none at all, so each of
// those calls missed the cache for everything after the tools, the rules
// and the whole transcript, and wrote it again at 1.25x the input price.
// On a scripted evening of seven turns with one short fight
// (scripts/measure-prompt-cache.mjs MEASURE_FIGHT=1) the fight's opening
// and closing calls wrote two thirds of everything written to the cache.
//
// tool_choice "allowed_tools" (OpenAI's Chat Completions and Responses
// APIs alike) narrows what the model may call without touching the tool
// list, so the prompt and its cached copy stay the same. The model still
// can call only what the turn offers; it reads the other definitions, as an
// agent program reading the whole catalogue already does
// (dmTurnToolCatalogue). Every other backend gets the offer as before:
// llama.cpp and OpenRouter have no such field.
//
// DM_STABLE_TOOLS=1 turns it on for any backend (the measuring scripts run
// against a local fake), =0 off everywhere.

// What a call asks of the model about tools, once the whole list is sent:
// any of them, none, or only the named ones.
export type StableToolChoice = "auto" | "none" | { allowed: string[] };

export function toolName(tool: unknown): string {
  const name = (tool as { function?: { name?: unknown } } | null)?.function?.name;
  return typeof name === "string" ? name : "";
}

// The tools a call names, each once, in the order first named: the list a
// caller hands in as stableTools.
export function uniqueTools(tools: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const tool of tools) {
    const name = toolName(tool);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  return out;
}

// Whether the whole list goes out with this call: OpenAI's own API, unless
// the operator says otherwise.
export function sendsStableTools(endpointKind: string, env: { DM_STABLE_TOOLS?: string } = {}): boolean {
  const forced = (env.DM_STABLE_TOOLS ?? "").trim();
  if (forced === "1") return true;
  if (forced === "0") return false;
  return endpointKind === "openai";
}

// The choice that offers exactly `offered` out of `stable`, or null when
// the whole list cannot stand in for the offer: a tool offered that the
// list does not hold (the caller's list is stale), or two definitions of
// one name that differ, which the model would read as the list's.
export function stableToolChoice(
  stable: readonly unknown[],
  offered: readonly unknown[],
  toolChoice: "auto" | "none" | undefined,
): StableToolChoice | null {
  const byName = new Map(stable.map((tool) => [toolName(tool), tool] as const));
  const names: string[] = [];
  for (const tool of offered) {
    const name = toolName(tool);
    const held = byName.get(name);
    if (!name || held === undefined) return null;
    if (held !== tool && JSON.stringify(held) !== JSON.stringify(tool)) return null;
    if (!names.includes(name)) names.push(name);
  }
  if (toolChoice === "none" || !names.length) return "none";
  if (names.length === byName.size) return "auto";
  return { allowed: names };
}

// The choice as Chat Completions takes it.
export function chatToolChoice(choice: StableToolChoice): unknown {
  if (typeof choice === "string") return choice;
  return {
    type: "allowed_tools",
    allowed_tools: {
      mode: "auto",
      tools: choice.allowed.map((name) => ({ type: "function", function: { name } })),
    },
  };
}

// The choice as the Responses API takes it.
export function responsesToolChoice(choice: StableToolChoice): unknown {
  if (typeof choice === "string") return choice;
  return {
    type: "allowed_tools",
    mode: "auto",
    tools: choice.allowed.map((name) => ({ type: "function", name })),
  };
}

// A 400 that refuses the allowed-tools choice itself: the call goes again
// with the offer as the tool list, and the backend is not asked again.
export function refusesAllowedTools(body: string): boolean {
  return /allowed_tools/i.test(String(body ?? "").slice(0, 4000));
}
