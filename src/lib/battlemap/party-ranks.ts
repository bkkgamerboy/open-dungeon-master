import { TERRAIN, blocksMove, inBounds, tileIndex, type XY } from "@/lib/battlemap/types";

// Where a party stands as a fight opens: two abreast, the front rank facing
// the enemy and the ranks running back from it, so the travel formation has
// a real front and rear to put people in (formation-logic.ts). One rule for
// every way a fight reaches the board: a generated map (generate.ts), a
// prepared fight's saved map or entry point (template-apply.ts) and a
// regenerated studio map (map-studio.ts).
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
  facing: Facing;
  // Which side of the anchor the second file stands on (+1 or -1 along the
  // axis across the facing); the other side is tried too.
  side?: 1 | -1;
  count: number;
  // Tiles nobody may take: other tokens, props, the enemy.
  taken: Set<number>;
  // Tiles to keep a step away from: the enemy, so the party never opens in
  // reach of them when the block has to slide.
  keepClear?: XY[];
  // How far the block may slide to stand whole (default 3 tiles, 15 ft).
  slide?: number;
  // Tiles this close to the map's edge are left out (the generator keeps
  // its border clear).
  margin?: number;
};

// Front first, rank by rank: [front 1, front 2, second 1, second 2, ...].
export function standInRanks(input: RanksInput): XY[] {
  const { terrain, width, height, anchor, facing, count, taken } = input;
  if (count <= 0) {
    return [];
  }
  const margin = input.margin ?? 0;
  const slide = input.slide ?? 3;
  const keepClear = input.keepClear ?? [];
  const across = { x: facing.dx === 0 ? 1 : 0, y: facing.dy === 0 ? 1 : 0 };
  const inside = (x: number, y: number) =>
    inBounds(width, height, x, y) && x >= margin && y >= margin && x < width - margin && y < height - margin;
  // Ground worth standing on: open floor best, rough ground second, never a
  // wall, a door, water or a climb.
  const quality = (x: number, y: number) => {
    if (!inside(x, y) || taken.has(tileIndex(width, x, y))) {
      return -1;
    }
    if (keepClear.some((spot) => Math.max(Math.abs(spot.x - x), Math.abs(spot.y - y)) <= 1)) {
      return -1;
    }
    const tile = terrain[tileIndex(width, x, y)];
    return tile === TERRAIN.floor ? 2 : tile === TERRAIN.difficult ? 1 : -1;
  };
  // The ground the anchor can walk to; a block across a wall is no block.
  const reach = reachable(terrain, width, height, inside, nearestStandable(anchor, inside, quality, width, height) ?? anchor);
  const slotsFor = (front: XY, side: 1 | -1) =>
    Array.from({ length: count }, (_, index) => {
      const rank = Math.floor(index / 2);
      const file = index % 2;
      return {
        x: front.x - rank * facing.dx + file * side * across.x,
        y: front.y - rank * facing.dy + file * side * across.y,
      };
    });
  const scoreOf = (slots: XY[]) =>
    slots.reduce((sum, slot) => {
      const value = quality(slot.x, slot.y);
      return sum + (value > 0 && reach.has(tileIndex(width, slot.x, slot.y)) ? value : -100);
    }, 0);

  const sides: Array<1 | -1> = input.side === -1 ? [-1, 1] : [1, -1];
  let best: { slots: XY[]; score: number; shift: number; forward: number } | null = null;
  for (let dy = -slide; dy <= slide; dy += 1) {
    for (let dx = -slide; dx <= slide; dx += 1) {
      const front = { x: anchor.x + dx, y: anchor.y + dy };
      const shift = Math.max(Math.abs(dx), Math.abs(dy));
      // A slide toward the enemy is the last resort among equals.
      const forward = Math.max(0, dx * facing.dx + dy * facing.dy);
      for (const side of sides) {
        const slots = slotsFor(front, side);
        const score = scoreOf(slots);
        if (
          !best ||
          score > best.score ||
          (score === best.score && (shift < best.shift || (shift === best.shift && forward < best.forward)))
        ) {
          best = { slots, score, shift, forward };
        }
      }
    }
  }
  const chosen = best?.slots ?? slotsFor(anchor, sides[0]);

  // Whatever still cannot stand where its slot is takes the nearest good
  // ground to that slot, behind the front rank where there is any.
  const used = new Set<number>();
  const frontLine = chosen[0].x * facing.dx + chosen[0].y * facing.dy;
  const free = (x: number, y: number) =>
    quality(x, y) > 0 && reach.has(tileIndex(width, x, y)) && !used.has(tileIndex(width, x, y));
  return chosen.map((slot, index) => {
    if (free(slot.x, slot.y)) {
      used.add(tileIndex(width, slot.x, slot.y));
      return slot;
    }
    const spot =
      nearestWhere(slot, width, height, (x, y) => free(x, y) && (index < 2 || x * facing.dx + y * facing.dy <= frontLine)) ??
      nearestWhere(slot, width, height, free) ??
      nearestWhere(slot, width, height, (x, y) => inBounds(width, height, x, y) && !blocksMove(terrain[tileIndex(width, x, y)]) && !taken.has(tileIndex(width, x, y)) && !used.has(tileIndex(width, x, y))) ??
      slot;
    used.add(tileIndex(width, spot.x, spot.y));
    return spot;
  });
}

function nearestStandable(
  from: XY,
  inside: (x: number, y: number) => boolean,
  quality: (x: number, y: number) => number,
  width: number,
  height: number,
): XY | null {
  return nearestWhere(from, width, height, (x, y) => inside(x, y) && quality(x, y) > 0);
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
  // The prepared fight's entry point, which wins outright.
  entry?: XY | null;
  // How far the nearest enemy should stand, in tiles, when the story said.
  distance?: number;
  taken: Set<number>;
};

// Where the front rank stands on a map the party did not arrive with (a
// prepared fight's saved map). The entry point when the fight has one;
// otherwise the ground nearest where the party already is that the enemy
// can walk to, at the distance asked or, with none asked, never closer than
// 20 ft, so nobody opens the fight already in reach.
export function chooseFront(input: FrontInput): XY {
  const { terrain, width, height, enemies, near, taken } = input;
  if (input.entry) {
    return input.entry;
  }
  if (!enemies.length) {
    return near;
  }
  const standable = (x: number, y: number) => {
    if (!inBounds(width, height, x, y) || taken.has(tileIndex(width, x, y))) {
      return false;
    }
    const tile = terrain[tileIndex(width, x, y)];
    return tile === TERRAIN.floor || tile === TERRAIN.difficult;
  };
  const inside = (x: number, y: number) => inBounds(width, height, x, y);
  const start =
    nearestWhere(enemies[0], width, height, (x, y) => inside(x, y) && !blocksMove(terrain[tileIndex(width, x, y)])) ??
    enemies[0];
  const reach = reachable(terrain, width, height, inside, start);
  const gap = (x: number, y: number) =>
    Math.min(...enemies.map((enemy) => Math.max(Math.abs(enemy.x - x), Math.abs(enemy.y - y))));
  const want = input.distance && input.distance > 0 ? Math.round(input.distance) : null;
  let best: { spot: XY; miss: number; drift: number } | null = null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!standable(x, y) || !reach.has(tileIndex(width, x, y))) {
        continue;
      }
      const apart = gap(x, y);
      // How far from the distance wanted: closer than asked costs double.
      const miss = want !== null ? (apart < want ? 2 * (want - apart) : apart - want) : Math.max(0, 4 - apart);
      const drift = Math.max(Math.abs(x - near.x), Math.abs(y - near.y));
      if (!best || miss < best.miss || (miss === best.miss && drift < best.drift)) {
        best = { spot: { x, y }, miss, drift };
      }
    }
  }
  return best?.spot ?? near;
}
