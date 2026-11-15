import { getLocationByName, routesOf, type CampaignLocation } from "@/lib/db/locations";
import { followsWritten } from "@/lib/db/written-layout";
import { foldName } from "@/lib/language/text-logic";

// The places an adventure writes, as the DM is shown them (build 32).
//
// Before this the model saw only the room the party stood in. Moving them on,
// it had to describe the next room as it called move_party, never having
// seen what the pack wrote there, and its guess was saved over the pack's
// room: a dungeon was played from invention from the first step in, exits
// and caches and all. Now the server keeps the written text
// (src/lib/db/written-layout.ts), GAME STATE shows the model the written
// rooms one step from where the party stands, and arriving somewhere written
// hands it that text.

// How many rooms ahead GAME STATE shows, and how much of each. A pack's room
// runs 300 to 1,000 characters; the cap keeps an outsized one from crowding
// the prompt without cutting a normal room's exits and caches.
export const ROOMS_AHEAD_MAX = 6;
export const ROOM_TEXT_MAX = 1_400;

export type RoomAhead = { name: string; text: string };

// The written places one step from here that the party has not been to:
// where the record's routes lead, read from the rows they name. A place the
// party has been to is left out (a return keeps its record and the
// move_party result hands it back), and so is anywhere unwritten.
export function roomsAhead(campaignId: string, here: CampaignLocation | null): RoomAhead[] {
  if (!here) {
    return [];
  }
  const rooms: RoomAhead[] = [];
  const seen = new Set<string>([here.id]);
  for (const route of routesOf(here)) {
    const place = getLocationByName(campaignId, route);
    if (!place || seen.has(place.id) || place.visited) {
      continue;
    }
    seen.add(place.id);
    const text = place.writtenLayout.trim();
    if (!text) {
      continue;
    }
    rooms.push({ name: place.name, text: clip(text, ROOM_TEXT_MAX) });
    if (rooms.length >= ROOMS_AHEAD_MAX) {
      break;
    }
  }
  return rooms;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

// The written places GAME STATE put in front of the model this turn: where
// the party stands and the rooms ahead. A move into any other written place
// is one the model narrated without having read it (build 33: a return to a
// room three rooms back was told from the model's memory of an old guess).
export function placesShown(campaignId: string, here: CampaignLocation | null): Set<string> {
  const shown = new Set<string>();
  if (here) {
    shown.add(foldName(here.name));
    for (const room of roomsAhead(campaignId, here)) {
      shown.add(foldName(room.name));
    }
  }
  return shown;
}

// Whether the tail of a reply, where its arrival is told, tells the written
// room or another one. A short line ("You head back.") tells no room at all
// and passes; a described room must share a fair part of its words with the
// written text (followsWritten's measure, a little lower for prose that also
// carries the walk there).
export function narrationTellsWritten(narration: string, written: string): boolean {
  const tail = narration.slice(-800);
  const words = tail
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
  if (words.length < 14) {
    return true;
  }
  return followsWritten(tail, written, 0.35);
}

// What arriving somewhere written tells the model, before the text itself.
export const WRITTEN_ARRIVAL_CUE =
  "Narrate the arrival from its text: open with its size and shape, the light and every exit they can see, then what stands out. Anything it calls hidden or secret, or that needs a check to find, stays unmentioned until someone finds it. The text:";

// The one corrective call when a reply narrated the party into a written
// place it described as some other room: the narration is held back and the
// model tells the arrival again from the text the move_party result carries.
export function writtenArrivalPrompt(names: readonly string[]): string {
  const places = names.join(" and ");
  const one = names.length === 1;
  return `${places} ${one ? "is" : "are"} written by the adventure, and your reply described ${one ? "it" : "them"} without that text, so the narration was not shown. Tell the arrival again from the adventure's text in the move_party result: its size and shape, the light, every exit the party can see, and what stands out, with nothing hidden given away and no rooms, passages, arches or obstacles that text does not have. An earlier description of ${one ? "it" : "them"} in the story that disagrees with the text was wrong; the text wins. Do not call move_party again for ${one ? "it" : "them"}.`;
}
