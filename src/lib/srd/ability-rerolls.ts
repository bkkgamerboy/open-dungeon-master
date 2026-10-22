// How freely a player may throw the 4d6 ability dice again, as one number:
// a fresh six only while the kept six add up to less than it. 0 keeps the
// first roll, 108 (six 18s) rerolls anything (issue #128). The server sets
// it for the library (Admin > Server), and a table may set its own for the
// characters made at it; a table that sets none follows the server and
// hands back the player's library six (src/lib/db/creation-rolls.ts).
//
// The number is what is stored and enforced; the words are the three ways a
// group actually plays it, so neither screen asks anyone to know that 108
// means "as often as you like". Pure, no "@/" imports, so a test can load it.

export const REROLL_NEVER = 0;
export const REROLL_ALWAYS = 108;
// The threshold "reroll a poor roll" starts at when it is chosen, and the
// server's rule before build 26.
export const REROLL_LOW_DEFAULT = 70;
// The server's rule until an admin changes it (build 26): throw the six
// again as often as you like, as players rolling up heroes for an evening
// always have. global-config.ts and the builder's bundled rule
// (abilityDice.ts) take it from here.
export const REROLL_DEFAULT = REROLL_ALWAYS;

export type RerollChoice = "keep" | "low" | "free";

export function rerollChoiceOf(rerollBelow: number): RerollChoice {
  if (rerollBelow <= REROLL_NEVER) {
    return "keep";
  }
  return rerollBelow >= REROLL_ALWAYS ? "free" : "low";
}

// The number a choice stores; "low" keeps a threshold already chosen.
export function rerollBelowFor(choice: RerollChoice, current: number): number {
  if (choice === "keep") {
    return REROLL_NEVER;
  }
  if (choice === "free") {
    return REROLL_ALWAYS;
  }
  return current > REROLL_NEVER && current < REROLL_ALWAYS ? current : REROLL_LOW_DEFAULT;
}

export function describeReroll(rerollBelow: number): string {
  const choice = rerollChoiceOf(rerollBelow);
  if (choice === "keep") {
    return "The first roll stands";
  }
  if (choice === "free") {
    return "Reroll as often as you like";
  }
  return `Reroll a roll totalling under ${rerollBelow}`;
}

// The rule at a table: its own when it set one, else the server's.
export function tableRerollBelow(tableSetting: number | null | undefined, serverSetting: number): number {
  return typeof tableSetting === "number" ? tableSetting : serverSetting;
}

// A table's setting in a settings row: its own rule, or the server's, named
// when it is known so "follow the server" says what that means.
export function describeTableReroll(tableSetting: number | null | undefined, serverSetting: number | null): string {
  if (typeof tableSetting === "number") {
    return describeReroll(tableSetting);
  }
  return serverSetting === null
    ? "The server's reroll rule"
    : `The server's rule (${describeReroll(serverSetting).toLowerCase()})`;
}

// The builder's words for the rule a player is rolling under, from the
// choice the number stands for, and whose rule it is: the table's when the
// character is made at one, the server's otherwise. `rule` is the sentence
// the 4d6 method's explainer carries; `open` and `closed` (and their short
// `Title` forms for the reroll button) describe a six on the tray that may,
// or may not, be thrown again; `keptClosed` is a six on record that may not.
export type RerollWords = {
  rule: string;
  open: string;
  openTitle: string;
  closed: string;
  closedTitle: string;
  keptClosed: string;
};

export function rerollWords(rerollBelow: number, atTable: boolean): RerollWords {
  const here = atTable ? "this table" : "this server";
  const Here = atTable ? "This table" : "This server";
  const choice = rerollChoiceOf(rerollBelow);
  const underOpen = `Under ${rerollBelow}: you may throw all six again.`;
  const underOpenTitle = `These add up to less than ${rerollBelow}, so you may throw again`;
  const underClosed = `A reroll opens only under ${rerollBelow}. These six are yours.`;
  const underClosedTitle = `A reroll opens only when the six add up to less than ${rerollBelow}`;
  const underKept = `It stays until a character uses it; a reroll opens only under ${rerollBelow}.`;
  if (choice === "keep") {
    const closed = `${Here} allows no second throw. These six are yours.`;
    return {
      rule: `The six are yours to keep: ${here} allows no second throw.`,
      open: underOpen,
      openTitle: underOpenTitle,
      closed,
      closedTitle: `${Here} allows no second throw`,
      keptClosed: closed,
    };
  }
  if (choice === "free") {
    return {
      rule: `${Here} lets you throw all six again as often as you like.`,
      open: `${Here} lets you throw all six again as often as you like.`,
      openTitle: `${Here} lets you throw again as often as you like`,
      closed: underClosed,
      closedTitle: underClosedTitle,
      keptClosed: underKept,
    };
  }
  return {
    rule: `The six are yours to keep: ${atTable ? "at this table " : ""}you may throw again only if they add up to less than ${rerollBelow}.`,
    open: underOpen,
    openTitle: underOpenTitle,
    closed: underClosed,
    closedTitle: underClosedTitle,
    keptClosed: underKept,
  };
}
