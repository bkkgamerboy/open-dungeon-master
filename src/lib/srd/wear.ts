import { isWorn, pickArmor, wearingIsExplicit, type WornItem } from "@/lib/srd/armor";
import { isHeldItem, matchMagicItem } from "@/lib/srd/magic-items";

// What a sheet keeps on when its wear is set for the first time.
//
// A sheet that has never said what it wears is read as wearing everything it
// carries (src/lib/srd/armor.ts isWorn). The moment one row says worn or not,
// every row is read as it is marked, so the rows that were never marked would
// all come off together: tap "wear" on an amulet and the leather the AC was
// counting is gone, and in a fight it then takes a minute to put back on.
//
// So the first switch marks worn, before it is applied, what was counting:
// the suit and the shield the AC engine picks, and each magic item that works
// while worn. Rows already marked are left as they are, and a sheet that has
// said what it wears is returned unchanged.
type Row = WornItem & { gear?: WornItem["gear"] & { magic?: unknown } };

function worksWhileWorn(item: Row): boolean {
  if (item.gear?.magic) {
    return true;
  }
  const def = matchMagicItem(item.name, item.slug);
  return Boolean(def && !def.carried && !isHeldItem(def));
}

export function settleWear<T extends Row>(equipment: T[], dexMod: number): T[] {
  if (wearingIsExplicit(equipment)) {
    return equipment;
  }
  const worn = equipment.filter((item) => isWorn(item, equipment));
  const { armorItem, shieldItem } = pickArmor(worn, dexMod);
  return equipment.map((item) => {
    if (item.equipped !== undefined) {
      return item;
    }
    const keep = item === armorItem?.item || item === shieldItem?.item || worksWhileWorn(item);
    return keep ? { ...item, equipped: true } : item;
  });
}

// For a writer that replaces the whole pack (an edit, a DM's update): when
// the old pack never said what it wore and the new one does, the rows the old
// pack was counting keep counting unless the new pack marks them itself.
export function keepWornOnFirstSet<T extends Row>(before: Row[], after: T[], dexMod: number): T[] {
  if (wearingIsExplicit(before) || !wearingIsExplicit(after)) {
    return after;
  }
  const kept = new Set(
    settleWear(before, dexMod)
      .filter((item) => item.equipped === true)
      .map((item) => item.name.trim().toLowerCase()),
  );
  return after.map((item) =>
    item.equipped === undefined && kept.has(item.name.trim().toLowerCase())
      ? { ...item, equipped: true }
      : item,
  );
}
