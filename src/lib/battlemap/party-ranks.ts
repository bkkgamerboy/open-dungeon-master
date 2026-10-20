import { TERRAIN, blocksMove, inBounds, tileIndex, type XY } from "@/lib/battlemap/types";

// Where a party stands as a fight opens: two abreast, the front rank facing
// the enemy and the ranks running back from it, so the travel formation has
// a real front and rear to put people in (formation-logic.ts). One rule for
// every way a fight reaches the board: a generated map (generate.ts), a
// prepared fight's saved map or entry point (template-apply.ts) and a
// regenerated studio map (map-studio.ts).
//
// Whichever way the enemy came from, the front rank faces them and the
// travel formation decides who stands in it: the healer the party put at
// the back opens at the back, farthest from every enemy, hidden ones too.
//
// The block is fitted, not stamped: when a wall, a rough patch or the map's
// edge would break a rank at the tile asked for, the whole block slides a
// few tiles to where it stands whole, rather than spilling one character
// off to the side. Pure and without randomness, so a map's seed still makes
// the same ground.

// A grid direction along one axis: the way the enemy lies.
export type Facing = { dx: -1 | 0 | 1; dy: -1 | 0 | 1 };

// Which way a target lies from a tile, snapped to the nearer of the two
// axes; a tie goes to east-west, the generator's own axis.
export function facingToward(from: XY, target: XY): Facing {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { dx: dx < 0 ? -1 : 1, dy: 0 };
  }
  return { dx: 0, dy: dy < 0 ? -1 : 1 };
}

// The middle of a group of tiles, or null for none.
export function centerOf(spots: XY[]): XY | null {
  if (!spots.length) {
    return null;
  }
  return {
    x: spots.reduce((sum, spot) => sum + spot.x, 0) / spots.length,
    y: spots.reduce((sum, spot) => sum + spot.y, 0) / spots.length,
  };
}

export type RanksInput = {
  terrain: string | string[];
  width: number;
  height: number;
  // The tile the front rank's first character should stand on.
  anchor: XY;
  // The way the front rank faces. Left out, every way is tried and the one
  // that keeps the rear farthest from the threats wins.
  facing?: Facing;
  // Where the enemy mostly is, to break a tie between facings.
  toward?: XY | null;
  // Which side of the anchor the second file stands on (+1 or -1 along the
  // axis across the facing); the other side is tried too.
  side?: 1 | -1;
  count: number;
  // Tiles nobody may take: other tokens, props, the enemy.
  taken: Set<number>;
  // Every enemy on the board, hidden ones too: the block is turned and slid
  // so that its rear stands farther from all of them than its front does,
  // whichever way they came from (an ambusher behind is still an enemy).
  threats?: XY[];
  // Tiles to keep a step away from: the enemy, so the party never opens in
  // reach of them when the block has to slide.
  keepClear?: XY[];
  // The front rank may stand next to the enemy (the story put them at arm's
  // length); the ranks behind it never do.
  frontMayTouch?: boolean;
  // How far the block may slide to stand whole (default 3 tiles, 15 ft).
  slide?: number;
  // Tiles this close to the map's edge are left out (the generator keeps
  // its border clear).
  margin?: number;
};

const FACINGS: Facing[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
];

const chebyshev = (a: XY, b: XY) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// How far a tile stands from the nearest of the threats; Infinity for none.
export function gapTo(spot: XY, threats: XY[]): number {
  return threats.length ? Math.min(...threats.map((threat) => chebyshev(spot, threat))) : Infinity;
}

// Front first, rank by rank: [front 1, front 2, second 1, second 2, ...].
export function standInRanks(input: RanksInput): XY[] {
  const { terrain, width, height, anchor, count, taken } = input;
  if (count <= 0) {
    return [];
  }
  const margin = input.margin ?? 0;
  const slide = input.slide ?? 3;
  const keepClear = input.keepClear ?? [];
  const threats = input.threats ?? [];
  const inside = (x: number, y: number) =>
    inBounds(width, height, x, y) && x >= margin && y >= margin && x < width - margin && y < height - margin;
  // Ground worth standing on: open floor best, rough ground second, never a
  // wall, a door, water or a climb.
  const quality = (x: number, y: number) => {
    if (!inside(x, y) || taken.has(tileIndex(width, x, y))) {
      return -1;
    }
    const tile = terrain[tileIndex(width, x, y)];
    return tile === TERRAIN.floor ? 2 : tile === TERRAIN.difficult ? 1 : -1;
  };
  const clear = (x: number, y: number, index: number) =>
    (index < 2 && input.frontMayTouch) || keepClear.every((spot) => chebyshev(spot, { x, y }) > 1);
  // The ground the anchor can walk to; a block across a wall is no block.
  const start = nearestWhere(anchor, width, height, (x, y) => quality(x, y) > 0) ?? anchor;
  const reach = reachable(terrain, width, height, inside, start);
  const fits = (x: number, y: number, index: number) =>
    quality(x, y) > 0 && reach.has(tileIndex(width, x, y)) && clear(x, y, index);
  const slotsFor = (front: XY, facing: Facing, side: 1 | -1) => {
    const across = { x: facing.dx === 0 ? 1 : 0, y: facing.dy === 0 ? 1 : 0 };
    return Array.from({ length: count }, (_, index) => {
      const rank = Math.floor(index / 2);
      const file = index % 2;
      return {
        x: front.x - rank * facing.dx + file * side * across.x,
        y: front.y - rank * facing.dy + file * side * across.y,
      };
    });
  };
  const groundOf = (slots: XY[]) =>
    slots.reduce((sum, slot, index) => sum + (fits(slot.x, slot.y, index) ? quality(slot.x, slot.y) : -100), 0);
  // The rear stands farther from every threat than the front: worth more
  // than a patch of rough ground, never more than a character off the block.
  const orderedOf = (slots: XY[]) => {
    if (!threats.length || slots.length < 3) {
      return 0;
    }
    const front = Math.min(...slots.slice(0, 2).map((slot) => gapTo(slot, threats)));
    const rear = Math.min(...slots.slice(2).map((slot) => gapTo(slot, threats)));
    return rear > front ? 30 : 0;
  };

  const facings = input.facing ? [input.facing] : FACINGS;
  const sides: Array<1 | -1> = input.side === -1 ? [-1, 1] : [1, -1];
  const toward = input.toward ?? null;
  type Pick = { slots: XY[]; facing: Facing; score: number; shift: number; forward: number; align: number };
  let best: Pick | null = null;
  const better = (a: Pick, b: Pick | null) =>
    !b ||
    a.score > b.score ||
    (a.score === b.score &&
      (a.shift < b.shift ||
        (a.shift === b.shift && (a.align > b.align || (a.align === b.align && a.forward < b.forward)))));
  for (const facing of facings) {
    // How squarely this way looks at the enemy (1 straight on, -1 away).
    const look = toward ? { x: toward.x - anchor.x, y: toward.y - anchor.y } : null;
    const align = look && (look.x || look.y) ? (facing.dx * look.x + facing.dy * look.y) / Math.hypot(look.x, look.y) : 0;
    for (let dy = -slide; dy <= slide; dy += 1) {
      for (let dx = -slide; dx <= slide; dx += 1) {
        const front = { x: anchor.x + dx, y: anchor.y + dy };
        const shift = Math.max(Math.abs(dx), Math.abs(dy));
        // A slide toward the enemy is the last resort among equals.
        const forward = Math.max(0, dx * facing.dx + dy * facing.dy);
        for (const side of sides) {
          const slots = slotsFor(front, facing, side);
          const pick = { slots, facing, score: groundOf(slots) + orderedOf(slots), shift, forward, align };
          if (better(pick, best)) {
            best = pick;
          }
        }
      }
    }
  }
  const facing = best?.facing ?? facings[0];
  const chosen = best?.slots ?? slotsFor(anchor, facing, sides[0]);

  // Whatever still cannot stand where its slot is takes the nearest good
  // ground to that slot, behind the front rank where there is any.
  const used = new Set<number>();
  const frontLine = chosen[0].x * facing.dx + chosen[0].y * facing.dy;
  const free = (x: number, y: number, index: number) => fits(x, y, index) && !used.has(tileIndex(width, x, y));
  return chosen.map((slot, index) => {
    if (free(slot.x, slot.y, index)) {
      used.add(tileIndex(width, slot.x, slot.y));
      return slot;
    }
    const spot =
      nearestWhere(slot, width, height, (x, y) => free(x, y, index) && (index < 2 || x * facing.dx + y * facing.dy <= frontLine)) ??
      nearestWhere(slot, width, height, (x, y) => free(x, y, index)) ??
      nearestWhere(slot, width, height, (x, y) => inBounds(width, height, x, y) && !blocksMove(terrain[tileIndex(width, x, y)]) && !taken.has(tileIndex(width, x, y)) && !used.has(tileIndex(width, x, y))) ??
      slot;
    used.add(tileIndex(width, spot.x, spot.y));
    return spot;
  });
}

// The nearest tile to `from`, ring by ring, that passes the test.
function nearestWhere(from: XY, width: number, height: number, ok: (x: number, y: number) => boolean): XY | null {
  if (ok(from.x, from.y)) {
    return { x: from.x, y: from.y };
  }
  for (let ring = 1; ring < Math.max(width, height); ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === ring && ok(from.x + dx, from.y + dy)) {
          return { x: from.x + dx, y: from.y + dy };
        }
      }
    }
  }
  return null;
}

// Every tile a walker reaches from `start` without crossing a wall.
function reachable(
  terrain: string | string[],
  width: number,
  height: number,
  inside: (x: number, y: number) => boolean,
  start: XY,
): Set<number> {
  const seen = new Set<number>([tileIndex(width, start.x, start.y)]);
  const queue: XY[] = [start];
  while (queue.length) {
    const { x, y } = queue.shift() as XY;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const idx = tileIndex(width, nx, ny);
      if (inside(nx, ny) && !seen.has(idx) && !blocksMove(terrain[idx])) {
        seen.add(idx);
        queue.push({ x: nx, y: ny });
      }
    }
  }
  return seen;
}

export type FrontInput = {
  terrain: string | string[];
  width: number;
  height: number;
  enemies: XY[];
  // Where the party is now: the tile its front should stay near.
  near: XY;
  // The prepared fight's entry point: where the party comes in, kept when
  // it is safe; when the enemy stands too close to it, the front moves to the
  // nearest ground near it that is not.
  entry?: XY | null;
  // How far the nearest enemy should stand, in tiles, when the story said.
  distance?: number;
  taken: Set<number>;
};

// The least room between the party and the enemy as a fight opens when the
// story named no distance: 20 ft, more than a step and an attack.
export const SAFE_OPENING_TILES = 4;

// How far the enemy opens when the story named no distance: 40 ft, across a
// room, grouped in front of the party (a small map takes less).
export const DEFAULT_OPENING_TILES = 8;

// Where the front rank stands on a map the party did not arrive with (a
// prepared fight's saved map): the ground nearest the entry point, or
// without one nearest where the party already is, that stands at the
// distance asked from the nearest enemy or, with none asked, never closer
// than 20 ft. The formation always wins over a spot drawn on the map: an
// entry point inside the enemy's reach is moved, not obeyed.
export function chooseFront(input: FrontInput): XY {
  const { terrain, width, height, enemies, near, taken } = input;
  const home = input.entry ?? near;
  if (!enemies.length) {
    return home;
  }
  const standable = (x: number, y: number) => {
    if (!inBounds(width, height, x, y) || taken.has(tileIndex(width, x, y))) {
      return false;
    }
    const tile = terrain[tileIndex(width, x, y)];
    return tile === TERRAIN.floor || tile === TERRAIN.difficult;
  };
  const inside = (x: number, y: number) => inBounds(width, height, x, y);
  const walkable = (x: number, y: number) => inside(x, y) && !blocksMove(terrain[tileIndex(width, x, y)]);
  // The party stands on ground joined to its way in (a closed door is a wall
  // to the engine), or with no way in, on ground the enemy can reach.
  const start = nearestWhere(input.entry ?? enemies[0], width, height, walkable) ?? home;
  const reach = reachable(terrain, width, height, inside, start);
  const want = input.distance && input.distance > 0 ? Math.round(input.distance) : null;
  let best: { spot: XY; miss: number; drift: number } | null = null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!standable(x, y) || !reach.has(tileIndex(width, x, y))) {
        continue;
      }
      const apart = gapTo({ x, y }, enemies);
      // How far from the distance wanted: closer than asked costs double.
      const miss =
        want !== null ? (apart < want ? 2 * (want - apart) : apart - want) : Math.max(0, SAFE_OPENING_TILES - apart);
      const drift = chebyshev({ x, y }, home);
      if (!best || miss < best.miss || (miss === best.miss && drift < best.drift)) {
        best = { spot: { x, y }, miss, drift };
      }
    }
  }
  return best?.spot ?? home;
}

// Tiles for a group around one spot, nearest first: open floor (rough ground
// when floor runs out) that a walker from the spot reaches. For enemies a
// prepared fight did not place, so they stand together as one force.
export function clusterAround(input: {
  terrain: string | string[];
  width: number;
  height: number;
  around: XY;
  count: number;
  taken: Set<number>;
  keepAway?: XY[];
  // Tiles at least this far from keepAway (the party), when there are any.
  apart?: number;
}): XY[] {
  const { terrain, width, height, around, count, taken } = input;
  const inside = (x: number, y: number) => inBounds(width, height, x, y);
  const walkable = (x: number, y: number) => inside(x, y) && !blocksMove(terrain[tileIndex(width, x, y)]);
  const start = nearestWhere(around, width, height, walkable) ?? around;
  const reach = reachable(terrain, width, height, inside, start);
  const away = input.keepAway ?? [];
  const apart = input.apart ?? 0;
  const out: XY[] = [];
  const used = new Set<number>();
  for (const allowed of [TERRAIN.floor, TERRAIN.difficult]) {
    for (let ring = 0; out.length < count && ring < Math.max(width, height); ring += 1) {
      for (let dy = -ring; dy <= ring && out.length < count; dy += 1) {
        for (let dx = -ring; dx <= ring && out.length < count; dx += 1) {
          const x = start.x + dx;
          const y = start.y + dy;
          const idx = tileIndex(width, x, y);
          if (
            Math.max(Math.abs(dx), Math.abs(dy)) === ring &&
            inside(x, y) &&
            terrain[idx] === allowed &&
            reach.has(idx) &&
            !taken.has(idx) &&
            !used.has(idx) &&
            gapTo({ x, y }, away) >= apart
          ) {
            out.push({ x, y });
            used.add(idx);
          }
        }
      }
    }
  }
  return out;
}
