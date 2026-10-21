import type { CharacterSheet } from "@/lib/schemas/sheet";

export function ownedCharacters(sheets: CharacterSheet[], userId: string): CharacterSheet[] {
  return sheets.filter((sheet) => sheet.userId === userId && !sheet.isCompanion);
}

export function selectedCharacter(sheets: CharacterSheet[], userId: string, selectedId = ""): CharacterSheet | null {
  const own = ownedCharacters(sheets, userId);
  return own.find((sheet) => sheet.id === selectedId) ?? own[0] ?? null;
}

// Viewing another sheet does not hand that character the initiative turn.
export function initiativeCharacter(sheets: CharacterSheet[], userId: string, characterId?: string | null): CharacterSheet | null {
  return ownedCharacters(sheets, userId).find((sheet) => sheet.id === characterId) ?? null;
}

export function resolveActionCharacter({ sheets, userId, selectedId, characterId, initiativeId, reaction = false, multiCharacter = "off" }: {
  sheets: CharacterSheet[];
  userId: string;
  selectedId?: string;
  characterId?: string;
  initiativeId?: string | null;
  reaction?: boolean;
  multiCharacter?: "off" | "one_active" | "all_active";
}): { sheet: CharacterSheet } | { error: string; status: number } {
  const selected = selectedCharacter(sheets, userId, selectedId);
  const expected = initiativeCharacter(sheets, userId, initiativeId);
  const sheet = characterId ? initiativeCharacter(sheets, userId, characterId) : (!reaction && expected) || selected;
  if (!sheet) return { error: "That is not one of your characters.", status: 404 };
  if (multiCharacter !== "all_active" && sheet.id !== selected?.id) {
    return { error: "Select that character before acting as them.", status: 409 };
  }
  if (!reaction && initiativeId && sheet.id !== initiativeId) {
    return { error: "Wait for that character's turn in the initiative order.", status: 409 };
  }
  return { sheet };
}

// The characters in play, without the database: with one character active
// per player, each player's selected one (else their first) and every
// companion; otherwise all of them. The server's fieldedSheets
// (src/lib/dm/roster.ts) reads the selections from the members table and
// asks this; the Party panel asks it with the members it already holds.
export function fieldedOf(
  sheets: CharacterSheet[],
  multiCharacter: "off" | "one_active" | "all_active" | undefined,
  activeOf: (userId: string) => string | undefined,
): CharacterSheet[] {
  if (multiCharacter !== "one_active") {
    return sheets;
  }
  const firstByUser = new Map<string, string>();
  for (const sheet of sheets) {
    if (!sheet.isCompanion && !firstByUser.has(sheet.userId)) {
      firstByUser.set(sheet.userId, sheet.id);
    }
  }
  return sheets.filter((sheet) => {
    if (sheet.isCompanion) {
      return true;
    }
    const selected = activeOf(sheet.userId);
    const chosen = sheets.some((entry) => entry.userId === sheet.userId && !entry.isCompanion && entry.id === selected)
      ? selected
      : firstByUser.get(sheet.userId);
    return !chosen || chosen === sheet.id;
  });
}
