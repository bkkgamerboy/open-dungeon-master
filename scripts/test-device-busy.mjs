// The Android app's world closes itself a few minutes after the player
// leaves the app, and asks /api/server/busy first so it never closes in the
// middle of a DM turn (android-voice/client.patch, WorldService). The route
// answers only the app that started the server, with the token it passed in
// ODM_DEVICE_TOKEN, and says whether a DM job is queued or running.
import assert from "node:assert/strict";
import { test } from "vitest";

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

const { GET } = await import("../src/app/api/server/busy/route.ts");
const { enqueueDmJob } = await import("../src/lib/dm/queue.ts");

function ask(token) {
  const headers = token === undefined ? {} : { "x-odm-device-token": token };
  return GET(new Request("http://127.0.0.1/api/server/busy", { headers }));
}

test("without a token in the environment the route is not there", async () => {
  delete process.env.ODM_DEVICE_TOKEN;
  assert.equal((await ask(TOKEN)).status, 404);
  assert.equal((await ask("")).status, 404);
});

test("a wrong or missing token gets a 404, not an answer", async () => {
  process.env.ODM_DEVICE_TOKEN = TOKEN;
  assert.equal((await ask(undefined)).status, 404);
  assert.equal((await ask("")).status, 404);
  assert.equal((await ask(TOKEN.slice(0, -1))).status, 404);
  assert.equal((await ask(TOKEN + "0")).status, 404);
  assert.equal((await ask(TOKEN.toUpperCase())).status, 404);
});

test("the app's token reads idle, then busy while a DM turn runs, then idle", async () => {
  process.env.ODM_DEVICE_TOKEN = TOKEN;
  const idle = await ask(TOKEN);
  assert.equal(idle.status, 200);
  assert.deepEqual(await idle.json(), { busy: false, dmJobs: 0 });

  let finish;
  const running = new Promise((resolve) => {
    finish = resolve;
  });
  const done = enqueueDmJob("campaign-1", () => running);
  enqueueDmJob("campaign-2", async () => {});
  const during = await (await ask(TOKEN)).json();
  assert.equal(during.busy, true);
  assert.ok(during.dmJobs >= 1, `expected a job counted, got ${during.dmJobs}`);

  finish();
  await done;
  // Let the second campaign's job settle too.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await (await ask(TOKEN)).json(), { busy: false, dmJobs: 0 });
});
