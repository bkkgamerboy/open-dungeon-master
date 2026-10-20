import type { Campaign } from "@/lib/db/campaigns";
import { deployPreparedMap } from "@/lib/dm/map-library";
import { applyStudioMap } from "@/lib/dm/map-studio";
import type { EncounterTemplate } from "@/lib/db/encounter-templates";
import { allocateSeq } from "@/lib/db/campaigns";
import { getActiveEncounter, listEnemies, patchEnemyIdentity } from "@/lib/db/encounters";
import {
  type BattleMap,
  getBattleMapForEncounter,
  getTokenByRef,
  listTokens,
  placeToken,
  renameTokenByRef,
  setTokenHidden,
} from "@/lib/db/battle-maps";
import { insertNote } from "@/lib/db/notes";
import { nearestOpenTile } from "@/lib/battlemap/paint";
import { occupiedTiles } from "@/lib/battlemap/view";
import { publishBattleMapUpdate } from "@/lib/dm/map-tools";
import { publishEncounter } from "@/lib/dm/enemy-damage";
import type { MapTheme } from "@/lib/battlemap/generate";
import { tileIndex, type AmbientLight, type XY } from "@/lib/battlemap/types";
import {
  DEFAULT_OPENING_TILES,
  SAFE_OPENING_TILES,
  centerOf,
  chooseFront,
  clusterAround,
  standInRanks,
} from "@/lib/battlemap/party-ranks";
import { placeByFormation } from "@/lib/dm/formation-logic";
import { getParty } from "@/lib/db/party";
import { describeExtras, expandRoster, matchSlots } from "@/lib/dm/encounter-template-logic";

// What a prepared fight brings to the board once the fight exists: its
// saved map and the rest of its plan. Split from src/lib/dm/encounter-
// templates.ts so the storyteller's run_prepared_encounter tool
// (src/lib/dm/prepared-encounter-tool.ts) applies the very same steps a DM's
// Deploy does, without the encounter tools importing the adjudication
// facade that imports them.

// The saved map settings, applied after the fight exists. Returns the one
// sentence to show when the map could not be applied, or null.
export function applyTemplateMap(campaign: Campaign, template: EncounterTemplate): string | null {
  const settings = template.map;
  // A linked prepared map wins over the generation dials: a DM who picked a
  // drawn map meant that map, not a reroll of its seed. A mapId that no
  // longer resolves (the map was forgotten since, or the template arrived in
  // a bundle whose maps did not travel) lands in mapError through the same
  // half-deploy path as any other map failure, and the fight stands.
  if (settings.mapId) {
    const applied = deployPreparedMap(campaign, settings.mapId);
    return "error" in applied ? applied.error : null;
  }
  const wanted =
    settings.seed !== null ||
    settings.theme !== null ||
    settings.ambient !== null ||
    settings.width !== null ||
    settings.height !== null;
  if (!wanted) {
    return null;
  }
  const applied = applyStudioMap(campaign, {
    seed: settings.seed ?? undefined,
    width: settings.width ?? undefined,
    height: settings.height ?? undefined,
    theme: (settings.theme as MapTheme | null) ?? undefined,
    ambient: (settings.ambient as AmbientLight | null) ?? undefined,
    scene: settings.scene ?? undefined,
  });
  return "error" in applied ? applied.error : null;
}

// The enemy a prepared fight did not place stands together as one force:
// beside the ones it did place, or with none placed, a stride from the way
// in (at the distance the story asked, else 40 ft), or failing both around
// the first of them. On a saved map they otherwise kept the tiles a
// generated map had given them, scattered across ground drawn for another
// board.
function groupUnplacedEnemies(map: BattleMap, placedIds: Set<string>, entry: XY | null, distanceTiles?: number) {
  const tokens = listTokens(map.id);
  const enemy = tokens.filter((token) => token.kind === "enemy");
  const loose = enemy.filter((token) => !placedIds.has(token.refId));
  if (!loose.length) {
    return;
  }
  const placed = enemy.filter((token) => placedIds.has(token.refId));
  const taken = occupiedTiles(
    map,
    tokens.filter((token) => !loose.includes(token)),
    null,
  );
  const want = Math.max(SAFE_OPENING_TILES, Math.round(distanceTiles ?? DEFAULT_OPENING_TILES));
  const around = placed.length
    ? (centerOf(placed) as XY)
    : entry
      ? chooseFront({ terrain: map.terrain, width: map.width, height: map.height, enemies: [entry], near: entry, distance: want, taken })
      : { x: loose[0].x, y: loose[0].y };
  const spots = clusterAround({
    terrain: map.terrain,
    width: map.width,
    height: map.height,
    around: { x: Math.round(around.x), y: Math.round(around.y) },
    count: loose.length,
    taken,
    keepAway: entry ? [entry] : [],
    apart: entry ? SAFE_OPENING_TILES : 0,
  });
  loose.forEach((token, index) => {
    const spot = spots[index];
    if (spot) {
      placeToken(token.id, spot.x, spot.y);
    }
  });
}

// Stands the party on the board as a fight opens, after the enemy is in
// place: two abreast, the front rank toward the enemy and the travel
// formation deciding who stands where (party-ranks.ts, formation-logic.ts).
// The formation wins over any spot drawn on the map: the block is turned to
// keep its rear farthest from every enemy, hidden ones too, and the healer
// the party put at the back takes the tile farthest from all of them, so an
// entry point beside the boss, or a boss waiting behind, never stands her
// next to it.
function standPartyFacingEnemy(campaign: Campaign, map: BattleMap, entry: XY | null, distanceFeet?: number) {
  const tokens = listTokens(map.id);
  const party = tokens.filter((token) => token.kind === "pc");
  if (!party.length) {
    return;
  }
  const enemy = tokens.filter((token) => token.kind === "enemy");
  const foes = enemy.map((token) => ({ x: token.x, y: token.y }));
  const seen = enemy.filter((token) => !token.hidden).map((token) => ({ x: token.x, y: token.y }));
  const taken = occupiedTiles(
    map,
    tokens.filter((token) => token.kind !== "pc"),
    null,
  );
  const middle = centerOf(seen.length ? seen : foes);
  // The party member nearest the enemy marks where the party is now.
  const near = middle
    ? party.reduce((best, token) =>
        Math.hypot(token.x - middle.x, token.y - middle.y) < Math.hypot(best.x - middle.x, best.y - middle.y) ? token : best,
      )
    : party[0];
  const distance = distanceFeet ? distanceFeet / 5 : undefined;
  const front = chooseFront({
    terrain: map.terrain,
    width: map.width,
    height: map.height,
    enemies: foes,
    near: { x: near.x, y: near.y },
    entry,
    distance,
    taken,
  });
  const slots = standInRanks({
    terrain: map.terrain,
    width: map.width,
    height: map.height,
    anchor: front,
    toward: middle,
    count: party.length,
    taken,
    threats: foes,
    keepClear: foes,
    frontMayTouch: distance !== undefined && distance <= 1,
  });
  // Front of the formation on the tiles nearest any enemy, the rear on the
  // farthest: the block's shape cannot put the healer in reach.
  const { spots } = placeByFormation(
    party.map((token) => ({ id: token.refId, name: token.name })),
    slots,
    foes,
    getParty(campaign.id).marchingOrder,
  );
  for (const token of party) {
    const spot = spots.get(token.refId) ?? slots[0];
    placeToken(token.id, spot.x, spot.y);
  }
}

// Placements, hidden enemies, overrides and the DM's note. Every part is
// best effort against the fight that was actually made: a slot the roster
// no longer has, or a tile that is now rock, is skipped rather than
// undoing a fight the enemies are already rolled into.
export function applyTemplateExtras(
  campaign: Campaign,
  userId: string,
  template: EncounterTemplate,
  // How far the nearest enemy stands as the fight opens, when the story
  // said (run_prepared_encounter's distanceFeet).
  options: { distanceFeet?: number } = {},
) {
  const extras = template.extras;
  // A saved map is laid under tokens standing where a generated map put
  // them, so the party needs standing again on it even with no entry point.
  const onSavedMap = Boolean(template.map.mapId);
  const hasBoardWork =
    extras.placements.length || extras.hidden.length || extras.overrides.length || extras.entry || onSavedMap;
  const encounter = getActiveEncounter(campaign.id);
  if (encounter && hasBoardWork) {
    const map = getBattleMapForEncounter(encounter.id);
    const enemies = listEnemies(encounter.id).filter((enemy) => enemy.status === "alive");
    const matched = matchSlots(expandRoster(template.enemies), enemies);
    for (const override of extras.overrides) {
      const enemy = matched.get(override.slot);
      if (!enemy) {
        continue;
      }
      patchEnemyIdentity(enemy.id, { displayName: override.name, maxHp: override.hp });
      if (override.name && map) {
        renameTokenByRef(map.id, enemy.id, override.name);
      }
    }
    if (map) {
      const tokens = listTokens(map.id);
      const taken = occupiedTiles(map, tokens, null);
      const moveTo = (tokenId: string, from: { x: number; y: number }, current: { x: number; y: number }) => {
        taken.delete(tileIndex(map.width, current.x, current.y));
        const spot = nearestOpenTile(map.terrain, map.width, map.height, from, taken);
        taken.add(tileIndex(map.width, spot.x, spot.y));
        placeToken(tokenId, spot.x, spot.y);
      };
      for (const placement of extras.placements) {
        const enemy = matched.get(placement.slot);
        const token = enemy ? getTokenByRef(map.id, enemy.id) : null;
        if (token) {
          moveTo(token.id, placement, token);
        }
      }
      for (const slot of extras.hidden) {
        const enemy = matched.get(slot);
        const token = enemy ? getTokenByRef(map.id, enemy.id) : null;
        if (token) {
          setTokenHidden(token.id, true);
        }
      }
      // The enemy the plan did not place stands together, then the party by
      // its travel formation, two abreast facing the enemy: near the entry
      // point when the fight has one, else near where it stands, never
      // opening in reach of anyone, an ambusher included. Piling everyone
      // onto the entry tile in roster order put whoever was made first
      // nearest the door, and an enemy placed by the plan could land beside
      // a party the generator had already stood.
      if (onSavedMap) {
        const placedIds = new Set(
          extras.placements.flatMap((placement) => {
            const enemy = matched.get(placement.slot);
            return enemy ? [enemy.id] : [];
          }),
        );
        groupUnplacedEnemies(map, placedIds, extras.entry, options.distanceFeet ? options.distanceFeet / 5 : undefined);
      }
      if (extras.entry || onSavedMap || extras.placements.length) {
        standPartyFacingEnemy(campaign, map, extras.entry, options.distanceFeet);
      }
      publishBattleMapUpdate(campaign.id);
    }
    publishEncounter(campaign.id);
  }
  const lines = describeExtras(extras);
  if (lines.length) {
    insertNote({
      campaignId: campaign.id,
      characterId: null,
      authorUserId: userId,
      authorKind: "dm",
      visibility: "private",
      status: "active",
      title: `${template.name}: the plan`,
      body: lines.join("\n"),
      seq: allocateSeq(campaign.id),
    });
  }
}
