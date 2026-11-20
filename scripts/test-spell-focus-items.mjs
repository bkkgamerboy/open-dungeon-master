// Build 34: magic items a sheet could not attune to, and the spell bonus a
// rod or wand gives.
//
// Played for real (The Pirate Queen's Ploy, Nov 2026): Kramer the warlock
// was handed a Rod of the Pact Keeper, +2 and nothing could attune it. The
// sheet offers Attune only for an item the engine's table holds, and the
// generator dropped every item that asks for attunement without a parsed
// effect: Boots of Speed and a Cloak of Displacement were missing the same
// way. Even attuned, nothing read a bonus to spell attacks or save DCs.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-spell-focus-items");
const world = await openWorld({});
const { matchMagicItem, magicItemRiders, itemSpellBonus, attunementProblem } = await import("../src/lib/srd/magic-items.ts");
const { computeSheetDerived, spellAttackFor, spellSaveDcFor } = await import("../src/lib/srd/index.ts");
const { attunementRefusal } = await import("../src/lib/dm/usage-rules.ts");
const { normalizeEffects } = await import("../src/lib/homebrew/item-data.ts");
const { describeEffect } = await import("../src/lib/homebrew/gear.ts");

await test("Items that ask for attunement are in the table, so a sheet offers Attune for them.", async () => {
  for (const name of ["Boots of Speed", "Cloak of Displacement", "Rod of the Pact Keeper, +2"]) {
    const def = matchMagicItem(name);
    assert.ok(def, `${name} is not in the table`);
    assert.equal(def.requiresAttunement, true, `${name} should ask for attunement`);
  }
});

await test("A +1/+2/+3 family is read by its bare name, and the plain categories are not.", async () => {
  assert.equal(matchMagicItem("Wand of the War Mage, +2")?.match, "wand of the war mage, +1, +2, or +3");
  assert.equal(matchMagicItem("Wand of the War Mage +3")?.match, "wand of the war mage, +1, +2, or +3");
  assert.equal(matchMagicItem("Rod of the Pact Keeper")?.match, "rod of the pact keeper");
  assert.equal(matchMagicItem("Longsword, +2"), null, "a plain +2 sword is not a magic-item row");
  assert.equal(matchMagicItem("Shield, +1"), null);
});

const warlock = world.addHero({
  class: "warlock",
  level: 9,
  name: "Kramer",
  abilities: { cha: 18 },
  spellcasting: { ability: "cha", known: ["Hex"], prepared: [], cantrips: ["Eldritch Blast"], slots: {}, pact: { level: 5, max: 2, used: 0 } },
});
const fighter = world.addHero({ class: "fighter", level: 9, name: "Bruce" });
const rod = { name: "Rod of the Pact Keeper, +2", qty: 1, equipped: true, attuned: true };
const withGear = (sheet, items) => ({ ...sheet, equipment: [...sheet.equipment, ...items] });

await test("A held, attuned rod adds its +2 to a warlock's spell attack and save DC, shown as magic items.", async () => {
  const plain = computeSheetDerived(warlock);
  const armed = computeSheetDerived(withGear(warlock, [rod]));
  assert.ok(plain.spellSaveDc !== null && plain.spellAttack !== null, "the warlock has no spell numbers");
  assert.equal(armed.spellSaveDc, plain.spellSaveDc + 2);
  assert.equal(armed.spellAttack, plain.spellAttack + 2);
  assert.ok(armed.parts.spellSaveDc.some((part) => part.label === "magic items" && part.value === 2));
  const spell = warlock.spellcasting?.cantrips?.[0] ?? warlock.spellcasting?.known?.[0];
  if (spell) {
    assert.equal(spellAttackFor(withGear(warlock, [rod]), spell), plain.spellAttack + 2);
    assert.equal(spellSaveDcFor(withGear(warlock, [rod]), spell), plain.spellSaveDc + 2);
  }
});

await test("The rod does nothing unattuned, and a fighter cannot attune it.", async () => {
  const idle = computeSheetDerived(withGear(warlock, [{ ...rod, attuned: false }]));
  assert.equal(idle.spellSaveDc, computeSheetDerived(warlock).spellSaveDc);
  const problem = attunementProblem({ ...rod, attuned: false }, fighter.equipment, fighter);
  assert.match(problem ?? "", /only by a warlock/);
  assert.equal(attunementProblem({ ...rod, attuned: false }, warlock.equipment, warlock), null);
});

await test("A fourth attunement is still refused: the rod takes one of the three places.", async () => {
  const three = [
    { name: "Amulet of Health", qty: 1, equipped: true, attuned: true },
    { name: "Ring of Protection", qty: 1, equipped: true, attuned: true },
    { name: "Cloak of Displacement", qty: 1, equipped: true, attuned: true },
  ];
  const sheet = withGear(warlock, [...three, { ...rod, attuned: false }]);
  assert.match(attunementRefusal(sheet, { [rod.name]: { attuned: true } }) ?? "", /attuned to 3 items/);
});

await test("A limited bonus counts only for its class's spells; different items stack.", async () => {
  const riders = magicItemRiders(
    [rod, { name: "Wand of the War Mage, +1", qty: 1, equipped: true, attuned: true }],
    warlock,
  );
  assert.deepEqual(itemSpellBonus(riders, "warlock"), { attack: 3, dc: 2 });
  assert.deepEqual(itemSpellBonus(riders, "wizard"), { attack: 1, dc: 0 });
});

// Build 36. Played for real (The Amber Gate, Nov 2026): Kramer attuned the
// rod and his Eldritch Blast still rolled without its +2. The sheet never
// offers to wear a rod, a staff or a wand (it is held), so with his leather
// marked worn the rod counted as not worn, and its bonus never applied. A
// staff's resistance was lost the same way.
await test("A rod, staff or wand works attuned and carried, as the sheet leaves it, with armour marked worn.", async () => {
  const asTheSheetLeavesIt = [
    { name: "Leather", qty: 1, equipped: true },
    { name: "Rod of the Pact Keeper, +2", qty: 1, attuned: true },
    { name: "Staff of Frost (+2 Quarterstaff, Ruling Staff)", qty: 1, attuned: true },
  ];
  const plain = computeSheetDerived(withGear(warlock, [{ name: "Leather", qty: 1, equipped: true }]));
  const armed = computeSheetDerived(withGear(warlock, asTheSheetLeavesIt));
  assert.equal(armed.spellAttack, plain.spellAttack + 2);
  assert.equal(armed.spellSaveDc, plain.spellSaveDc + 2);
  const spell = warlock.spellcasting?.cantrips?.[0] ?? warlock.spellcasting?.known?.[0];
  if (spell) {
    assert.equal(spellAttackFor(withGear(warlock, asTheSheetLeavesIt), spell), plain.spellAttack + 2);
  }
  const riders = magicItemRiders(asTheSheetLeavesIt, warlock);
  assert.ok(riders.resistances.includes("cold"), "the attuned staff's cold resistance");
  // Unattuned, the held rod still gives nothing.
  const idle = computeSheetDerived(withGear(warlock, [{ name: "Leather", qty: 1, equipped: true }, { ...rod, equipped: undefined, attuned: false }]));
  assert.equal(idle.spellAttack, plain.spellAttack);
  // A worn item still has to be worn: an amulet attuned but taken off sets nothing.
  const amulet = magicItemRiders([{ name: "Leather", qty: 1, equipped: true }, { name: "Amulet of Health", qty: 1, attuned: true }], warlock);
  assert.equal(amulet.abilitySet.con, undefined);
});

await test("A homebrew item can carry a spell bonus, and the editor and the DM read it in words.", async () => {
  const [effect] = normalizeEffects([{ kind: "spell_bonus", attack: 2, dc: 9, classes: ["Warlock"] }]);
  assert.deepEqual(effect, { kind: "spell_bonus", attack: 2, dc: 3, classes: ["warlock"] });
  assert.equal(describeEffect(effect), "spell attack +2, spell save DC +3 (warlock spells)");
  assert.deepEqual(normalizeEffects([{ kind: "spell_bonus", attack: 0, dc: 0 }]), []);
});

finish();
