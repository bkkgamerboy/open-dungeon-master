import type { ParsedToolCall } from "@/lib/dm/rolls";
import { cutSpans, findBareJsonObjects, findHeaderLeaks } from "@/lib/dm/tool-text";

// gpt-oss on vLLM sometimes writes a call into its reply as bare JSON instead
// of a structured tool call: just the arguments ('{"characterIds":[...],
// "prompt":"..."}'), alone or glued to the end of its prose, or the whole call
// ('{"name":"move_token","arguments":{...}}'). Players read the first kind
// verbatim, and a reply that was only the JSON closed the turn on the
// empty-turn line (PR #53). Like the bracket and XML salvages in rolls.ts,
// every such object is cut from the narration, and the ones that name a call
// unambiguously run as one: the named tool when it is offered, or else the one
// offered tool whose parameters take every key and whose required keys are
// all present. An object that fits no tool, or several, is cut and dropped.

type ToolShape = { name: string; properties: Set<string>; required: string[] };

function toolShapes(tools: unknown[]): Map<string, ToolShape> {
  const shapes = new Map<string, ToolShape>();
  for (const tool of tools) {
    const fn = (tool as { function?: { name?: unknown; parameters?: unknown } })?.function;
    if (!fn || typeof fn.name !== "string") {
      continue;
    }
    const parameters = (fn.parameters ?? {}) as { properties?: Record<string, unknown>; required?: unknown };
    shapes.set(fn.name, {
      name: fn.name,
      properties: new Set(Object.keys(parameters.properties ?? {})),
      required: Array.isArray(parameters.required) ? parameters.required.map(String) : [],
    });
  }
  return shapes;
}

function asArguments(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function asToolCall(
  value: Record<string, unknown>,
  shapes: Map<string, ToolShape>,
): { name: string; args: Record<string, unknown> } | null {
  if (typeof value.name === "string" && shapes.has(value.name)) {
    const args = asArguments(value.arguments ?? value.parameters ?? {});
    if (args) {
      return { name: value.name, args };
    }
  }
  const keys = Object.keys(value);
  if (!keys.length) {
    return null;
  }
  const fits = [...shapes.values()].filter(
    (shape) => keys.every((key) => shape.properties.has(key)) && shape.required.every((key) => key in value),
  );
  return fits.length === 1 ? { name: fits[0].name, args: value } : null;
}

export function salvageJsonToolCalls(
  text: string,
  tools: unknown[],
): { text: string; calls: ParsedToolCall[] } {
  if (!text || !text.includes("{")) {
    return { text, calls: [] };
  }
  // The structured story reply ({"storyText": ...}) is extractStoryText's.
  const objects = findBareJsonObjects(text).filter(
    (object) => !("storyText" in object.value) && !("story_text" in object.value),
  );
  if (!objects.length) {
    return { text, calls: [] };
  }
  const shapes = toolShapes(tools);
  const calls: ParsedToolCall[] = [];
  for (const object of objects) {
    const call = asToolCall(object.value, shapes);
    if (call) {
      calls.push({ id: `json-salvaged-${calls.length}`, name: call.name, rawArguments: JSON.stringify(call.args) });
    }
  }
  return { text: cutSpans(text, objects), calls };
}

// The recipient-header leak (src/lib/dm/tool-text.ts findHeaderLeaks): an
// OpenAI-format model addressing a tool in its reply text ("assistant
// to=functions.request_player_input json {...}") instead of making the call.
// The header and everything after it is cut from the narration; the call
// runs when its arguments survived as an object and the tool is offered.
// Arguments lost to a broken decode leave nothing to run, and the turn goes
// on with the prose before the header, which is what players were meant to
// read.
export function salvageHeaderToolCalls(
  text: string,
  tools: unknown[],
): { text: string; calls: ParsedToolCall[] } {
  const leaks = findHeaderLeaks(text);
  if (!leaks.length) {
    return { text, calls: [] };
  }
  const shapes = toolShapes(tools);
  const calls: ParsedToolCall[] = [];
  for (const leak of leaks) {
    const shape = shapes.get(leak.name);
    if (!shape || !leak.args) {
      continue;
    }
    // A whole call ({"name":..., "arguments":...}) or its bare arguments.
    const args =
      typeof leak.args.name === "string" && leak.args.name === leak.name && leak.args.arguments
        ? asArguments(leak.args.arguments)
        : leak.args;
    if (args && shape.required.every((key) => key in args)) {
      calls.push({ id: `header-salvaged-${calls.length}`, name: leak.name, rawArguments: JSON.stringify(args) });
    }
  }
  return { text: cutSpans(text, leaks), calls };
}
