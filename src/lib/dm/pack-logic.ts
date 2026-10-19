import type { PartyItem } from "@/lib/dm/party-logic";

// Pack animals and town storage: where the party's shared things are, and
// what carries them.
//
// The shared pack (src/lib/dm/party-logic.ts) was weightless bookkeeping:
// it held a hundred and twenty kinds of thing whatever they weighed, and it
// was in reach in the deepest dungeon. A table that plays with a mule wants
// the mule to matter, so the pack now has a carrier. With no animal the
// party carries it by hand, a backpack's worth on top of everyone's own
// load (HAND_CARRY_LB). A pack animal carries it up to its load, and where
// the animal waits (a dungeon's mouth, a stable) the pack waits too: what
// the party wants inside has to come off the mule first.
//
// Storage is the other half: a box rented in a town, one per place, used
// only while the party stands there and visible from anywhere, so the hoard
// left in Lanternhill is still on the table's mind three towns later.
//
// Pure by design: types only from party-logic, so the client can render the
// pack and the tests can load this without a database.

export type PlaceRef = { id: string; name: string };

// The SRD's beasts of burden, from the Mounts and Other Animals table (cost,
// speed, carrying capacity) and the creatures' stat blocks (armor class, hit
// points). A riding horse and a warhorse are mounts first (src/lib/srd/
// mounts.ts) and are left out: nobody loads their charger with the tent.
export type PackAnimalKind = {
  slug: string;
  name: string;
  priceCp: number;
  carry: number;
  hp: number;
  ac: number;
  speed: number;
  blurb: string;
};

export const PACK_ANIMAL_KINDS: PackAnimalKind[] = [
  {
    slug: "mule",
    name: "Mule",
    priceCp: 800,
    carry: 420,
    hp: 11,
    ac: 10,
    speed: 40,
    blurb: "Sure-footed and stubborn. The classic choice.",
  },
  {
    slug: "pony",
    name: "Pony",
    priceCp: 3000,
    carry: 225,
    hp: 11,
    ac: 10,
    speed: 40,
    blurb: "Small and steady; a halfling can ride it too.",
  },
  {
    slug: "draft-horse",
    name: "Draft horse",
    priceCp: 5000,
    carry: 540,
    hp: 19,
    ac: 10,
    speed: 40,
    blurb: "Carries the most, and takes a blow better.",
  },
  {
    slug: "camel",
    name: "Camel",
    priceCp: 5000,
    carry: 480,
    hp: 15,
    ac: 9,
    speed: 50,
    blurb: "For the desert road. Spits.",
  },
];

export function packAnimalKind(ref: string): PackAnimalKind | null {
  const needle = ref.trim().toLowerCase();
  if (!needle) {
    return null;
  }
  return (
    PACK_ANIMAL_KINDS.find((kind) => kind.slug === needle) ??
    PACK_ANIMAL_KINDS.find((kind) => kind.name.toLowerCase() === needle) ??
    PACK_ANIMAL_KINDS.find((kind) => needle.includes(kind.slug) || needle.includes(kind.name.toLowerCase())) ??
    // A donkey is the SRD's same line as the mule.
    (/donkey|burro|ass\b/.test(needle) ? PACK_ANIMAL_KINDS[0] : null)
  );
}

export type PackAnimal = {
  id: string;
  name: string;
  // The kind's slug, or the DM's own word for a beast not on the list.
  kind: string;
  carry: number;
  hp: number;
  maxHp: number;
  ac: number;
  speed: number;
};

export const MAX_PACK_ANIMALS = 3;
// What the party carries of the shared pack by hand with no animal: about a
// backpack's worth (30 lb) and a sack's, spread across everyone's shoulders.
export const HAND_CARRY_LB = 50;
export const PACK_ANIMAL_NAME_MAX = 40;

export type StorageBox = {
  place: PlaceRef;
  inventory: PartyItem[];
  copper: number;
};

export const MAX_STORAGE_BOXES = 8;
export const MAX_BOX_ITEMS = 120;

// ---- reading the stored record ----

export function normalizePlace(raw: unknown): PlaceRef | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = String(record.id ?? "").trim().slice(0, 80);
  const name = String(record.name ?? "").trim().slice(0, 120);
  return id && name ? { id, name } : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function normalizePackAnimals(raw: unknown): PackAnimal[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PackAnimal[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const name = String(entry.name ?? "").trim().slice(0, PACK_ANIMAL_NAME_MAX);
    const id = String(entry.id ?? "").trim().slice(0, 60);
    if (!name || !id) {
      continue;
    }
    const kind = String(entry.kind ?? "").trim().slice(0, 40) || "mule";
    const known = packAnimalKind(kind);
    const maxHp = clampInt(entry.maxHp, 1, 300, known?.hp ?? 11);
    out.push({
      id,
      name,
      kind,
      carry: clampInt(entry.carry, 1, 5000, known?.carry ?? 420),
      maxHp,
      hp: clampInt(entry.hp, 0, maxHp, maxHp),
      ac: clampInt(entry.ac, 1, 30, known?.ac ?? 10),
      speed: clampInt(entry.speed, 0, 120, known?.speed ?? 40),
    });
    if (out.length >= MAX_PACK_ANIMALS) {
      break;
    }
  }
  return out;
}

export function normalizeStorage(
  raw: unknown,
  normalizeItem: (item: Record<string, unknown>) => PartyItem | null,
): StorageBox[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: StorageBox[] = [];
  const seen = new Set<string>();
  for (const entry of raw as Array<Record<string, unknown>>) {
    const place = normalizePlace(entry?.place);
    if (!place || seen.has(place.id)) {
      continue;
    }
    seen.add(place.id);
    out.push({
      place,
      inventory: Array.isArray(entry.inventory)
        ? (entry.inventory as Array<Record<string, unknown>>)
            .map((item) => normalizeItem(item))
            .filter((item): item is PartyItem => item !== null)
            .slice(0, MAX_BOX_ITEMS)
        : [],
      copper: Math.max(0, Math.round(Number(entry.copper) || 0)),
    });
    if (out.length >= MAX_STORAGE_BOXES) {
      break;
    }
  }
  return out;
}

// ---- who carries the shared pack ----

export type PackReach = {
  // The animals, or the party's own hands.
  carrier: "hands" | "animals";
  capacityLb: number;
  // Where the pack waits with the animals, when it is not with the party.
  awayAt: PlaceRef | null;
  // Whether the party can reach into it from where it stands.
  reachable: boolean;
  // "the party's own backs", "Bramble", "Bramble and Thistle".
  carriedBy: string;
};

export function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function packReach(
  animals: PackAnimal[],
  leftAt: PlaceRef | null,
  hereId: string | null,
): PackReach {
  if (!animals.length) {
    return {
      carrier: "hands",
      capacityLb: HAND_CARRY_LB,
      awayAt: null,
      reachable: true,
      carriedBy: "the party's own backs",
    };
  }
  const capacityLb = animals.reduce((total, animal) => total + animal.carry, 0);
  const carriedBy = joinNames(animals.map((animal) => animal.name));
  if (!leftAt) {
    return { carrier: "animals", capacityLb, awayAt: null, reachable: true, carriedBy };
  }
  return {
    carrier: "animals",
    capacityLb,
    awayAt: leftAt,
    reachable: Boolean(hereId) && hereId === leftAt.id,
    carriedBy,
  };
}

// Pounds the shared pack weighs (items with no weight count as nothing, so
// this is a floor; the panel says how many went unweighed).
export function packWeightLb(inventory: PartyItem[]): number {
  return Math.round(inventory.reduce((total, item) => total + (item.weight ?? 0) * item.qty, 0) * 100) / 100;
}

// Why the pack cannot take this much more, or null when it can. The limit
// only ever refuses an addition: a pack already over it (an animal lost, a
// load from before the rule) keeps everything and takes nothing more.
export function packRoomProblem(current: PartyItem[], addLb: number, reach: PackReach): string | null {
  if (addLb <= 0) {
    return null;
  }
  const now = packWeightLb(current);
  const after = Math.round((now + addLb) * 100) / 100;
  if (after <= reach.capacityLb) {
    return null;
  }
  return reach.carrier === "hands"
    ? `That would make the shared pack ${after} lb, and the party can carry ${reach.capacityLb} lb of it by hand. A pack animal carries far more (a mule takes 420 lb); buy one in a town's market.`
    : `That would make the shared pack ${after} lb, and ${reach.carriedBy} can carry ${reach.capacityLb} lb.`;
}

// ---- storage ----

export function boxAt(storage: StorageBox[], placeId: string): StorageBox | null {
  return storage.find((box) => box.place.id === placeId) ?? null;
}

export function rentBox(storage: StorageBox[], place: PlaceRef): { storage: StorageBox[] } | { error: string } {
  if (boxAt(storage, place.id)) {
    return { error: `The party already keeps a box in ${place.name}.` };
  }
  if (storage.length >= MAX_STORAGE_BOXES) {
    return { error: `The party keeps ${MAX_STORAGE_BOXES} boxes already; empty one and give it up first.` };
  }
  return { storage: [...storage, { place, inventory: [], copper: 0 }] };
}

export function replaceBox(storage: StorageBox[], box: StorageBox): StorageBox[] {
  return storage.map((entry) => (entry.place.id === box.place.id ? box : entry));
}

export function describePackAnimal(animal: PackAnimal): string {
  const kind = packAnimalKind(animal.kind)?.name.toLowerCase() ?? animal.kind;
  return `${animal.name} (${kind}, ${animal.hp}/${animal.maxHp} HP, AC ${animal.ac}, carries ${animal.carry} lb)`;
}
