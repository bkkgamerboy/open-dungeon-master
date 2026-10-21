// Which cards a player keeps in the visible Hand (issue 231). The Hand is
// still derived from the character and the live turn (hand.ts); a layout
// only decides where each card sits, the fan or the "more" sheet, and in what
// order. It never makes a card playable: a chosen card keeps the reason the
// rules stop it, and a card the character no longer holds is simply not there.
//
// Saved per campaign character on its sheet (character_sheets.hand_layout_json),
// so it follows the player to every device and lasts across fights.
// No runtime imports: the sheet store reads layouts through this module.
import type { HandCard } from "@/lib/battlemap/hand-core";

export type HandLayout = {
  // The cards chosen for the fan, left to right, by card id.
  fan: string[];
  // Every card the hand held when it was arranged, so one gained since (a
  // level-up's spell, a new weapon) can be marked as new in "more".
  known: string[];
};

// Nine cards in the fan. Every seat is the player's to arrange: End turn is
// no longer a card (build 24); it is the End button beside the turn's pips.
export const HAND_FAN_CAP = 9;
export const HAND_SEATS = HAND_FAN_CAP;
const KNOWN_CAP = 240;
const ID_MAX = 160;

// Cards the moment deals that matter most while it lasts: Escape while held,
// Stand up while prone, a reaction an attack just offered, the lead's Skip
// turn while somebody else's turn is under way. They take a seat ahead of
// the chosen ones and give it back when the moment passes.
export function isUrgentCard(card: Pick<HandCard, "id">): boolean {
  return (
    card.id === "basic:escape" ||
    card.id === "basic:stand-up" ||
    card.id === "basic:skip-turn" ||
    card.id.startsWith("reaction:")
  );
}

// A stored or sent layout, bounded: ids are short strings, none twice, no
// more than the seats in the fan. Anything else reads as no layout at all,
// which is the automatic hand.
export function normalizeHandLayout(raw: unknown): HandLayout | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as { fan?: unknown; known?: unknown };
  if (!Array.isArray(record.fan)) {
    return null;
  }
  const ids = (list: unknown[], cap: number) =>
    [...new Set(list.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= ID_MAX))].slice(
      0,
      cap,
    );
  const fan = ids(record.fan, HAND_SEATS);
  const known = ids(Array.isArray(record.known) ? record.known : [], KNOWN_CAP);
  return { fan, known: [...new Set([...fan, ...known])].slice(0, KNOWN_CAP) };
}

export type HandArrangement = {
  fan: HandCard[];
  more: HandCard[];
  // Chosen cards an urgent one has pushed out of the fan for now; the layout
  // still holds them, and they come back when the moment passes.
  displaced: HandCard[];
  // Cards in "more" the hand did not hold when it was arranged.
  fresh: HandCard[];
  // Whether a saved layout placed the cards (false: the automatic split).
  arranged: boolean;
};

// The automatic split: nine in the fan, the rest behind the "more" spine in
// the same order. A playable card is never pushed behind the spine by an
// unplayable one.
export function splitHand(cards: HandCard[], cap = HAND_FAN_CAP): { fan: HandCard[]; more: HandCard[] } {
  if (cards.length <= cap) return { fan: cards, more: [] };
  // A bare fist gives its seat up too when there is steel to swing.
  const armed = cards.some((card) => card.intent.card === "attack" && card.id !== "attack:unarmed strike");
  // Escape and Stand up are dealt only while something holds the character
  // or they lie prone, which is when they matter most: they keep a seat.
  const situational = (card: HandCard) => card.id === "basic:escape" || card.id === "basic:stand-up";
  const rank = (card: HandCard) =>
    card.disabled ? 2 : situational(card) ? -1 : armed && card.id === "attack:unarmed strike" ? 1 : 0;
  const ranked = [...cards].sort((a, b) => rank(a) - rank(b));
  const keep = new Set(ranked.slice(0, cap));
  const fan = cards.filter((card) => keep.has(card));
  return { fan, more: cards.filter((card) => !keep.has(card)) };
}

// The hand as the player arranged it, or the automatic split when they have
// not. Urgent cards sit first; the chosen ones follow in the player's order
// and, when an urgent card needs a seat, the last of them waits in "more".
export function arrangeHand(
  cards: HandCard[],
  layout: HandLayout | null | undefined,
  cap = HAND_FAN_CAP,
): HandArrangement {
  if (!layout) {
    return { ...splitHand(cards, cap), displaced: [], fresh: [], arranged: false };
  }
  const seats = cap;
  const byId = new Map(cards.map((card) => [card.id, card]));
  const urgent = cards.filter((card) => isUrgentCard(card)).slice(0, seats);
  const chosen = layout.fan
    .map((id) => byId.get(id))
    .filter((card): card is HandCard => Boolean(card) && !urgent.includes(card!));
  const free = Math.max(0, seats - urgent.length);
  const fan = [...urgent, ...chosen.slice(0, free)];
  const displaced = chosen.slice(free);
  const inFan = new Set(fan);
  const more = cards.filter((card) => !inFan.has(card));
  const known = new Set(layout.known);
  return {
    fan,
    more,
    displaced,
    fresh: more.filter((card) => !known.has(card.id) && !isUrgentCard(card)),
    arranged: true,
  };
}

// A card picked from "more" to play now takes a seat for the moment: an empty
// one if the fan has room, otherwise the last one. Nothing is saved by it.
export function seatPicked(fan: HandCard[], picked: HandCard | null, cap = HAND_FAN_CAP): HandCard[] {
  if (!picked || fan.includes(picked)) return fan;
  return [...(fan.length < cap ? fan : fan.slice(0, -1)), picked];
}

// ---- changing a layout ----

// The layout a player starts arranging from: their saved one, or the fan the
// automatic split shows them now, so the first change moves one card and
// not the whole hand.
export function startingLayout(cards: HandCard[], saved: HandLayout | null | undefined): HandLayout {
  if (saved) {
    return { fan: [...saved.fan], known: [...new Set([...saved.known, ...cards.map((card) => card.id)])] };
  }
  const { fan } = splitHand(cards);
  return {
    fan: fan.filter((card) => !isUrgentCard(card)).map((card) => card.id).slice(0, HAND_SEATS),
    known: cards.map((card) => card.id),
  };
}

export type LayoutChange = { layout: HandLayout } | { error: string };

// Seats a card. At capacity the change is refused in words, never made by
// pushing another card out: the player decides which one goes.
export function addToHand(layout: HandLayout, card: Pick<HandCard, "id" | "name">): LayoutChange {
  if (layout.fan.includes(card.id)) {
    return { layout };
  }
  if (layout.fan.length >= HAND_SEATS) {
    return {
      error: `Your hand is full: all ${HAND_SEATS} seats are taken. Move a card to More first, then add ${card.name}.`,
    };
  }
  return { layout: { ...layout, fan: [...layout.fan, card.id] } };
}

// Sends a card to "more". It stays playable from there.
export function removeFromHand(layout: HandLayout, cardId: string): HandLayout {
  return { ...layout, fan: layout.fan.filter((id) => id !== cardId) };
}

// Moves a chosen card one seat left or right.
export function moveInHand(layout: HandLayout, cardId: string, direction: -1 | 1): HandLayout {
  const index = layout.fan.indexOf(cardId);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= layout.fan.length) {
    return layout;
  }
  const fan = [...layout.fan];
  [fan[index], fan[target]] = [fan[target], fan[index]];
  return { ...layout, fan };
}

// The cards the layout names that the hand does not hold now (a spell no
// longer prepared, a weapon sold). They keep no seat; the count says why the
// fan has room.
export function missingFromHand(layout: HandLayout, cards: HandCard[]): string[] {
  const held = new Set(cards.map((card) => card.id));
  return layout.fan.filter((id) => !held.has(id));
}
