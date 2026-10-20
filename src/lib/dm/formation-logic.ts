// The party's travel formation (issue 230): who walks at the front, in the
// middle and at the rear, as campaign state rather than a line of chat.
//
// The active order is PartyState.marchingOrder (party-logic.ts), front first,
// by character sheet id. A change to it is a FormationChange: made at once
// by whoever arranges it (the party lead, or the DM seat at a table a person
// runs), or proposed first. Either way the players whose characters moved are
// asked to agree or to ask for a change, and a proposal takes effect when all
// of them agree or when the lead makes it active. Until then the active order
// stays in force, so a player who is away never leaves the party without one.
//
// Pure: no imports, so the prompt, the routes, the board and the tests read
// the same rules.

export type FormationAnswer = { answer: "agree" | "change"; note: string; at: string };

export type FormationChange = {
  // The arrangement the change makes, front first.
  order: string[];
  // Proposed: waiting on the players it moves. Active: already in force, and
  // the players it moved may still say they agree or ask for a change.
  status: "proposed" | "active";
  by: string;
  byName: string;
  at: string;
  // The characters it moves whose players are asked (never the arranger's own
  // characters, never an ally the DM plays).
  affected: string[];
  // Each asked character's answer, by sheet id.
  answers: Record<string, FormationAnswer>;
};

export const FORMATION_MAX = 12;
export const FORMATION_NOTE_MAX = 160;

function ids(raw: unknown, cap = FORMATION_MAX): string[] {
  return Array.isArray(raw)
    ? [...new Set(raw.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 80))].slice(0, cap)
    : [];
}

export function normalizeFormationChange(raw: unknown): FormationChange | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const order = ids(record.order);
  if (!order.length) {
    return null;
  }
  const answers: Record<string, FormationAnswer> = {};
  if (record.answers && typeof record.answers === "object") {
    for (const [id, value] of Object.entries(record.answers as Record<string, unknown>).slice(0, FORMATION_MAX)) {
      const entry = value as Partial<FormationAnswer> | null;
      if (entry && (entry.answer === "agree" || entry.answer === "change")) {
        answers[id] = {
          answer: entry.answer,
          note: String(entry.note ?? "").slice(0, FORMATION_NOTE_MAX),
          at: String(entry.at ?? ""),
        };
      }
    }
  }
  return {
    order,
    status: record.status === "proposed" ? "proposed" : "active",
    by: String(record.by ?? ""),
    byName: String(record.byName ?? "").slice(0, 80),
    at: String(record.at ?? ""),
    affected: ids(record.affected),
    answers,
  };
}

// The order against the party that is here now: who is placed, front first,
// and who is not placed yet (a character who joined since, one the lead left
// out). A character who left is simply not named.
export function formationView(order: string[], partyIds: string[]): { placed: string[]; unplaced: string[] } {
  const present = new Set(partyIds);
  const placed = order.filter((id) => present.has(id));
  const seen = new Set(placed);
  return { placed, unplaced: partyIds.filter((id) => !seen.has(id)) };
}

// The characters whose place a change moves: a new position, newly placed,
// or taken out.
export function movedCharacters(before: string[], after: string[]): string[] {
  const moved = after.filter((id, index) => before.indexOf(id) !== index);
  const removed = before.filter((id) => !after.includes(id));
  return [...new Set([...moved, ...removed])];
}

// What a sent order must be: characters of this party, each once.
export function formationProblem(order: string[], partyIds: string[]): string | null {
  if (!order.length) {
    return "Put at least one character in the formation.";
  }
  if (new Set(order).size !== order.length) {
    return "A character holds one place in the formation; that order names one twice.";
  }
  const present = new Set(partyIds);
  if (order.some((id) => !present.has(id))) {
    return "That order names a character who is not in this party. Reload the Party panel and arrange it again.";
  }
  return null;
}

type Actor = { userId: string; name: string };
type Party = { marchingOrder: string[]; formationChange: FormationChange | null };

// A change made by whoever arranges the formation. `askable` are the moved
// characters whose players are asked (the route knows who plays whom). With
// nobody to ask, a proposal has no one to wait on and takes effect at once.
export function changeFormation(
  party: Party,
  order: string[],
  mode: "set" | "propose",
  actor: Actor,
  askable: (moved: string[]) => string[],
  now: string,
): { party: Party; change: FormationChange; status: "active" | "proposed" } | { error: string } {
  const moved = movedCharacters(party.marchingOrder, order);
  if (!moved.length) {
    return { error: "That is the formation already." };
  }
  const affected = askable(moved);
  const status = mode === "propose" && affected.length ? "proposed" : "active";
  const change: FormationChange = { order, status, by: actor.userId, byName: actor.name, at: now, affected, answers: {} };
  return {
    party: { marchingOrder: status === "active" ? order : party.marchingOrder, formationChange: change },
    change,
    status,
  };
}

// A player's answer for one of their characters the change moved. A proposal
// every asked player has agreed to takes effect.
export function answerFormation(
  party: Party,
  characterId: string,
  answer: "agree" | "change",
  note: string,
  now: string,
): { party: Party; activated: boolean } | { error: string } {
  const change = party.formationChange;
  if (!change) {
    return { error: "There is no formation change to answer." };
  }
  if (!change.affected.includes(characterId)) {
    return { error: "That change does not move this character, so there is nothing to answer for them." };
  }
  const answers = { ...change.answers, [characterId]: { answer, note: note.trim().slice(0, FORMATION_NOTE_MAX), at: now } };
  const agreed = change.affected.every((id) => answers[id]?.answer === "agree");
  const activated = change.status === "proposed" && agreed;
  return {
    party: {
      marchingOrder: activated ? change.order : party.marchingOrder,
      formationChange: { ...change, answers, status: activated ? "active" : change.status },
    },
    activated,
  };
}

// The arranger puts a proposal in force without waiting for every answer.
export function activateFormation(party: Party): Party | { error: string } {
  const change = party.formationChange;
  if (!change || change.status !== "proposed") {
    return { error: "There is no proposed formation to make active." };
  }
  return { marchingOrder: change.order, formationChange: { ...change, status: "active" } };
}

// The arranger takes a proposal back (the active order stays), or clears the
// answers of a change already in force.
export function withdrawFormation(party: Party): Party | { error: string } {
  if (!party.formationChange) {
    return { error: "There is no formation change to withdraw." };
  }
  return { marchingOrder: party.marchingOrder, formationChange: null };
}

// ---- the prompt ----

// The block every DM turn reads from campaign state, never from chat: the
// order in force now, who is not placed, and whether a change is waiting.
// Empty for a party of one, which has no formation to speak of.
export function describeFormation(
  party: Party,
  partyIds: string[],
  nameOf: (characterId: string) => string,
): string {
  if (partyIds.length < 2) {
    return "";
  }
  const { placed, unplaced } = formationView(party.marchingOrder, partyIds);
  if (!placed.length) {
    return "Travel formation: none set. Describe where each character walks as the story has it; the party lead can set one in the Party panel.";
  }
  const lines = [
    `Travel formation, front to back (the party's own, the one in force now; it decides who meets a trap, a narrow passage or an ambush first and who scouts ahead. It places the party and grants no surprise or bonus): ${placed
      .map((id, index) => `${index + 1}. ${nameOf(id)}`)
      .join(", ")}.`,
  ];
  if (unplaced.length) {
    lines.push(`Not in the formation yet: ${unplaced.map(nameOf).join(", ")}. Place them where the story has them until the party does.`);
  }
  const change = party.formationChange;
  if (change?.status === "proposed") {
    lines.push("A new formation is proposed and not yet agreed; the order above still holds until it is.");
  }
  return lines.join("\n");
}

// ---- the board ----

type XY = { x: number; y: number };

// Starting tiles for the party, by the formation: the front of it on the
// tiles nearest the enemy, whichever way the enemy came from. An enemy from
// behind is met by a party that turns to face it, so the healer the party
// put at the back is never the one left standing next to them; "behind"
// changes only what the story says. With no enemy on the board (a scene)
// the formation runs along the tiles in the order the map gave them.
// Characters not in the formation take the tiles after it. Returns each
// character's tile and the sentence the tool result says about it.
export function placeByFormation(
  sheets: Array<{ id: string; name: string }>,
  partySpawns: XY[],
  enemySpawns: XY[],
  order: string[],
  from: "ahead" | "behind" = "ahead",
): { spots: Map<string, XY>; line: string } {
  const { placed, unplaced } = formationView(order, sheets.map((sheet) => sheet.id));
  const ranked = [...placed, ...unplaced];
  const nearest = (spot: XY) =>
    enemySpawns.length ? Math.min(...enemySpawns.map((enemy) => Math.max(Math.abs(enemy.x - spot.x), Math.abs(enemy.y - spot.y)))) : 0;
  const tiles = enemySpawns.length
    ? partySpawns
        .map((spot, index) => ({ spot, index, distance: nearest(spot) }))
        .sort((a, b) => a.distance - b.distance || a.index - b.index)
        .map((entry) => entry.spot)
    : partySpawns;
  const fallback = partySpawns[0] ?? { x: 1, y: 1 };
  const spots = new Map(ranked.map((id, index) => [id, tiles[index] ?? fallback]));
  const name = (id: string) => sheets.find((sheet) => sheet.id === id)?.name ?? "someone";
  if (!placed.length) {
    return {
      spots,
      line: "No travel formation is set, so the party starts in no particular order. The party lead can set one in the Party panel.",
    };
  }
  const where = enemySpawns.length
    ? from === "behind"
      ? "turned to face the enemy, who came from behind, the front of it nearest them"
      : "the front of it nearest the enemy"
    : "in its order";
  return {
    spots,
    line: `The party starts by its travel formation, ${where}: ${placed.map(name).join(", ")}.${
      unplaced.length ? ` Not in the formation, placed after it: ${unplaced.map(name).join(", ")}.` : ""
    } The formation places them; it grants no surprise or bonus.`,
  };
}
