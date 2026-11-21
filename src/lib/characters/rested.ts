import type { CreateSheetInput } from "@/lib/schemas/sheet";
import { chargeRuleOf } from "@/lib/srd/item-charge-rules";

// A hero enters a campaign rested (build 38). A library character carries
// home what it had left when its last campaign ended: slots spent in the
// final fight, hit dice used, a staff down to two charges. None of that
// belongs at the start of the next story, which opens days or weeks later.
//
// createSheet already starts every sheet at full hit points with no
// temporary ones, no conditions, no exhaustion and its limited-use features
// full. This settles the rest of what a long rest (and the dawns since)
// gives back: every spell slot and pact slot, every hit die, and every
// magic item's charges (a row with no count is full: src/lib/dm/
// item-charges.ts).
export function restedForEntry<T extends Pick<CreateSheetInput, "hitDice" | "spellcasting" | "equipment"> & {
  hitDicePools?: CreateSheetInput["hitDicePools"] | null;
}>(input: T): T {
  const spellcasting = input.spellcasting
    ? {
        ...input.spellcasting,
        slots: Object.fromEntries(
          Object.entries(input.spellcasting.slots ?? {}).map(([level, slot]) => [level, { ...slot, used: 0 }]),
        ),
        ...(input.spellcasting.pact ? { pact: { ...input.spellcasting.pact, used: 0 } } : {}),
      }
    : input.spellcasting;
  return {
    ...input,
    hitDice: input.hitDice ? { ...input.hitDice, spent: 0 } : input.hitDice,
    ...(input.hitDicePools ? { hitDicePools: input.hitDicePools.map((pool) => ({ ...pool, spent: 0 })) } : {}),
    spellcasting,
    equipment: (input.equipment ?? []).map((item) => {
      if (typeof item.charges !== "number" || !chargeRuleOf(item)) {
        return item;
      }
      const { charges: _spent, ...full } = item;
      void _spent;
      return full;
    }),
  };
}
