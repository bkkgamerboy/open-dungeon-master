// A place the adventure writes (a pack's room, a workshop's place, one the
// table's author typed into WorldForge) keeps that text for good: the DM's
// own words about it ride beside it, never over it. Before build 32 the
// first move_party into a pack's room saved the DM's guess over the room,
// so a dungeon was played from invention from the first step in.
//
// Pure, so the database boot (core.ts) and the location rows (locations.ts)
// share it without importing each other.

export const LAYOUT_MAX = 2_000;

// The heading the DM's own additions sit under, after the written text.
export const SINCE_ARRIVAL = "Since the party arrived:";

// The written text, then the DM's additions under SINCE_ARRIVAL. The written
// text always survives whole; what is cut to fit the record is the end of the
// additions.
export function composeLayout(written: string, notes: string): string {
  const base = written.trim();
  const extra = notes.trim();
  if (!extra) {
    return base.slice(0, LAYOUT_MAX);
  }
  const joined = `${base}\n\n${SINCE_ARRIVAL} ${extra}`;
  return joined.length <= LAYOUT_MAX ? joined : joined.slice(0, LAYOUT_MAX);
}

// What update_location adds to a written place: the DM's revision less
// anything that only repeats the written text or the record as it stands.
// Null when nothing new is left.
export function additionsTo(written: string, current: string, revision: string): string | null {
  let text = revision.trim();
  const base = written.trim();
  if (!text || text === base || text === current.trim()) {
    return null;
  }
  if (base && text.startsWith(base)) {
    text = text.slice(base.length).trim();
  }
  if (text.startsWith(SINCE_ARRIVAL)) {
    text = text.slice(SINCE_ARRIVAL.length).trim();
  }
  return text || null;
}

// Whether the layout the DM passed for a written place is that place, told
// in its own words, or a different room it made up. A good share of the DM's
// longer words should be the written text's: a fair retelling keeps the
// room's nouns (cave, carved, staircase, passage), an invented one brings
// its own (pool, panel, cleft). The bar is low on purpose: a miss only costs
// the one corrective call in turn.ts.
export function followsWritten(layout: string, written: string): boolean {
  const words = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4);
  const told = words(layout);
  if (!told.length) {
    return true;
  }
  const source = new Set(words(written));
  const shared = told.filter((word) => source.has(word)).length;
  return shared / told.length >= 0.4;
}
