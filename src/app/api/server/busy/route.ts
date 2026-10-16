import { timingSafeEqual } from "node:crypto";
import { dmQueueTotals } from "@/lib/dm/queue";
import { serverEnv } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whether this server is in the middle of a DM turn, for the Android app
// that hosts it (ODM Voice). The app closes its world a few minutes after
// the player leaves it, and asks here first so that close never lands
// halfway through the AI's answer.
//
// Only the app that started this server knows the token it was started
// with (ODM_DEVICE_TOKEN), so a guest on a shared world, or any server
// started without one, gets the same 404 as an unknown path. Counts only:
// nothing about a campaign or a player.
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const expected = serverEnv("ODM_DEVICE_TOKEN");
  const given = request.headers.get("x-odm-device-token") ?? "";
  if (!expected || !sameToken(given, expected)) {
    return new Response(null, { status: 404 });
  }
  const dm = dmQueueTotals();
  return Response.json(
    { busy: dm.jobs > 0, dmJobs: dm.jobs },
    { headers: { "Cache-Control": "no-store" } },
  );
}
