import { capsFor, isErrorResponse, requireMember, requireStoryAuthority } from "@/lib/campaign-api";
import { getFloor, setFloor } from "@/lib/db/campaigns";
import { endEncounter, getActiveEncounter, listEnemies, patchEnemyHp } from "@/lib/db/encounters";
import { activePublicEncounter } from "@/lib/db/encounter-view";
import { publishBattleMapUpdate } from "@/lib/dm/map-tools";
import { publishPersisted } from "@/lib/events";
import { invokeEngine } from "@/lib/dm/invoke";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The caller's projection of the active fight. The shared stream carries
// only the player-safe payload, so a DM (who is allowed the real hit points
// and AC) re-fetches here after every encounter_updated ping, the same
// ping-and-self-fetch pattern the fogged battle map already uses.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const context = await requireMember(campaignId);
  if (isErrorResponse(context)) {
    return context;
  }
  return Response.json({
    encounter: activePublicEncounter(campaignId, {
      enemyNumbers: capsFor(context).enemyNumbers,
    }),
  });
}

// The party lead's End encounter. At a table the AI runs, the lead holds no
// DM seat, and this was their only way to close a fight the story had
// already finished (the last foes ran off in the narration, an ambusher was
// never revealed): it ended the fight with no XP, so a whole fight's XP was
// lost. Now it ends the fight the way the engine does (end_encounter): XP
// for every enemy the party beat and half for any still standing, which slip
// away, the after-the-fight card, the music. ?abort=1 is the old escape
// hatch, kept for a fight the engine will not end: no XP, no outcome
// narration; the fiction is the lead's to patch up with a direction.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const context = await requireStoryAuthority(campaignId);
  if (isErrorResponse(context)) {
    return context;
  }
  const encounter = getActiveEncounter(campaignId);
  if (!encounter) {
    return Response.json({ error: "No active encounter." }, { status: 404 });
  }
  const abort = new URL(request.url).searchParams.get("abort") === "1";
  if (!abort) {
    const ended = await invokeEngine(
      context.campaign,
      { kind: "human", userId: context.user.id },
      { name: "end_encounter", args: { outcome: "enemies_fled", reason: "the party lead ended the fight" } },
    );
    if (ended.ok) {
      return Response.json({ ok: true, result: ended.result });
    }
    return Response.json({ error: ended.error }, { status: 409 });
  }
  for (const enemy of listEnemies(encounter.id)) {
    if (enemy.status === "alive") {
      patchEnemyHp(enemy.id, enemy.currentHp, "fled");
    }
  }
  endEncounter(encounter.id, "aborted");
  const floor = getFloor(campaignId);
  if (floor.mode === "initiative" || (floor.mode === "hold" && floor.next.mode === "initiative")) {
    setFloor(campaignId, { mode: "open" });
    publishPersisted(campaignId, "floor_changed", { floor: { mode: "open" } });
  }
  publishPersisted(campaignId, "encounter_updated", { encounter: null });
  publishBattleMapUpdate(campaignId);
  return Response.json({ ok: true });
}
