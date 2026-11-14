import { z } from "zod";
import type { Campaign } from "@/lib/db/campaigns";
import { getTokenByRef, setTokenHidden } from "@/lib/db/battle-maps";
import { activePublicEncounter } from "@/lib/db/encounter-view";
import { getActiveEncounter, listEnemies } from "@/lib/db/encounters";
import { getActiveBattleMap } from "@/lib/battlemap/view";
import { publishEphemeral, publishPersisted } from "@/lib/events";

// A hidden enemy (a prepared fight's ambusher, or one the DM hid from the
// board) is off the players' map and their initiative tracker
// (src/lib/battlemap/view.ts, src/lib/db/encounter-view.ts). At a table a
// human DM lifts that with the board's Reveal button; nothing did for an
// AI-narrated table, where the party lead holds no DM seat, so an ambusher
// stayed invisible for the whole fight it was fighting in.
//
// So an ambusher shows itself the way 5e says it does: attacking or casting
// gives away where it is (SRD 5.1, Unseen Attackers and Targets), and so
// does being struck, since whoever struck it knew where to aim. The AI DM
// can also reveal one when the party spots it (reveal_enemy).
//
// Imports point downward only (db, events, battlemap/view): enemy-attack,
// enemy-damage, cast-at-player, aoe-damage and pc-attack all call this.

// Lifts the hidden flag from the enemy's token on the live board. The
// token's name when it was hidden and now is not; null when there was
// nothing to reveal (no board, no token, already in view).
export function revealIfHidden(campaignId: string, enemyId: string): string | null {
  const map = getActiveBattleMap(campaignId);
  const token = map ? getTokenByRef(map.id, enemyId) : null;
  if (!token || !token.hidden || token.kind !== "enemy") {
    return null;
  }
  setTokenHidden(token.id, false);
  publishEphemeral(campaignId, "battle_map_updated", {});
  publishPersisted(campaignId, "encounter_updated", { encounter: activePublicEncounter(campaignId) });
  return token.name;
}

// The line a tool result carries so the DM narrates the moment.
export function revealedLine(name: string, why: "acts" | "struck" | "spotted"): string {
  const how =
    why === "acts"
      ? "gives itself away by acting"
      : why === "struck"
        ? "is struck and shows where it is"
        : "is spotted";
  return `${name} was hidden from the party and ${how}: it is on their map and in the turn order now. Narrate them seeing it.`;
}

// Reveals one enemy and returns the result fields to merge: { revealed }
// when something came into view, nothing otherwise.
export function revealOnAct(campaignId: string, enemyId: string, why: "acts" | "struck"): { revealed?: string } {
  const name = revealIfHidden(campaignId, enemyId);
  return name ? { revealed: revealedLine(name, why) } : {};
}

// ---- reveal_enemy tool ----

type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export const revealEnemyTool: ToolDef = {
  type: "function",
  function: {
    name: "reveal_enemy",
    description:
      "Bring a hidden enemy into the party's view: its token appears on their map and in their turn order. GAME STATE marks such an enemy [hidden from the party]. Call it when they notice it (check_notice, a Search, light falling on it) or when the story has it step out; a hidden enemy that attacks, casts, or is struck is revealed by the server on its own. Leave an ambusher hidden until then.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        enemyId: {
          type: "string",
          description: "Exact enemyId from GAME STATE, or 'all' for every hidden enemy in the fight.",
        },
        reason: { type: "string", description: "Short in-fiction cause." },
      },
      required: ["enemyId"],
    },
  },
};

const revealArgsSchema = z.object({ enemyId: z.string(), reason: z.string().optional() });

export function handleRevealEnemy(campaign: Campaign, rawArguments: string): Record<string, unknown> {
  const encounter = getActiveEncounter(campaign.id);
  if (!encounter) {
    return { error: "No active encounter." };
  }
  let args: z.infer<typeof revealArgsSchema>;
  try {
    args = revealArgsSchema.parse(JSON.parse(rawArguments || "{}"));
  } catch {
    return { error: "Invalid arguments: reveal_enemy needs enemyId." };
  }
  const alive = listEnemies(encounter.id).filter((enemy) => enemy.status === "alive");
  const wanted = args.enemyId.trim().toLowerCase();
  const picked =
    wanted === "all"
      ? alive
      : alive.filter(
          (enemy) => enemy.id === args.enemyId.trim() || enemy.displayName.trim().toLowerCase() === wanted,
        );
  if (!picked.length) {
    return { error: "Unknown enemyId; use one from GAME STATE, or 'all'." };
  }
  const revealed = picked.flatMap((enemy) => {
    const name = revealIfHidden(campaign.id, enemy.id);
    return name ? [name] : [];
  });
  if (!revealed.length) {
    return {
      ok: true,
      note:
        wanted === "all"
          ? "No enemy in this fight is hidden; the party already sees every one."
          : `${picked[0].displayName} is already in the party's view.`,
    };
  }
  return {
    ok: true,
    revealed,
    note: `${revealed.join(", ")} ${revealed.length === 1 ? "is" : "are"} on the party's map and in the turn order now. Narrate them seeing ${revealed.length === 1 ? "it" : "them"}.`,
  };
}
