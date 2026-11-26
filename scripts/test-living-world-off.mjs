// Living World (gameSettings.worldSimulation) defaults to off from build 39,
// and the boot switches it off once on every campaign made while it
// defaulted on. Played for real (Deicide, Nov 2026): left on, its sparks and
// off-screen arcs layered invented threads over a prepared pack that went
// round in circles.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "odm-living-world-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");

register("./lib/register-alias.mjs", import.meta.url);

const { getDatabase, nowIso, switchLivingWorldOff } = await import("../src/lib/db/core.ts");
const { createCampaign, getCampaignById } = await import("../src/lib/db/campaigns.ts");
const { normalizeGameSettings } = await import("../src/lib/schemas/game-settings.ts");
const { DEFAULT_DRAFT } = await import("../src/app/create-campaign/draft.ts");

const db = getDatabase();
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAILED: ${name}`);
    throw error;
  }
}

const userId = randomUUID();
db.prepare(
  `INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`,
).run(userId, `tester-${userId.slice(0, 8)}`, nowIso());

const newCampaign = (gameSettings) =>
  createCampaign(userId, {
    title: "A table",
    description: "",
    theme: "",
    maxPlayers: 4,
    startingLevel: 10,
    difficulty: "normal",
    gameSettings,
  });

test("settings that say nothing about Living World read as off", () => {
  assert.equal(normalizeGameSettings({}).worldSimulation, false);
});

test("the new-campaign dialog starts with Living World off", () => {
  assert.equal(DEFAULT_DRAFT.worldSimulation, false);
});

test("a campaign made without a choice starts with Living World off", () => {
  assert.equal(getCampaignById(newCampaign({ dmMode: "ai" }).id).gameSettings.worldSimulation, false);
});

test("a table can still switch Living World on", () => {
  const chosen = newCampaign({ dmMode: "ai", worldSimulation: true });
  assert.equal(getCampaignById(chosen.id).gameSettings.worldSimulation, true);
});

test("the boot switches it off on campaigns made while it defaulted on, and nothing else", () => {
  const old = newCampaign({ dmMode: "ai" });
  const stored = JSON.parse(
    db.prepare(`SELECT game_settings_json FROM campaigns WHERE id = ?`).get(old.id).game_settings_json,
  );
  // Written the way an older build wrote it: on, explicitly.
  db.prepare(`UPDATE campaigns SET game_settings_json = ? WHERE id = ?`).run(
    JSON.stringify({ ...stored, worldSimulation: true, variantRules: { ...(stored.variantRules ?? {}), flanking: true } }),
    old.id,
  );
  // One with the key missing altogether, as before the engine existed.
  const ancient = newCampaign({ dmMode: "ai" });
  const withoutKey = JSON.parse(
    db.prepare(`SELECT game_settings_json FROM campaigns WHERE id = ?`).get(ancient.id).game_settings_json,
  );
  delete withoutKey.worldSimulation;
  db.prepare(`UPDATE campaigns SET game_settings_json = ? WHERE id = ?`).run(JSON.stringify(withoutKey), ancient.id);

  const before = getCampaignById(old.id).gameSettings;
  assert.equal(before.worldSimulation, true);
  assert.ok(switchLivingWorldOff(db) >= 2);
  const after = getCampaignById(old.id).gameSettings;
  assert.equal(after.worldSimulation, false);
  assert.equal(after.variantRules.flanking, true, "the switch-off clobbered the table's other settings");
  assert.equal(after.dmMode, "ai");
  assert.equal(getCampaignById(ancient.id).gameSettings.worldSimulation, false);
  // Idempotent: a second pass finds nothing on.
  assert.equal(switchLivingWorldOff(db), 0);
});

test("the boot pass runs once: a table that turns it back on keeps it", () => {
  const marker = db.prepare(`SELECT key FROM app_settings WHERE key = 'living_world_off_done'`).get();
  assert.ok(marker, "the first boot did not record the one-time switch-off");
});

console.log(`${passed} living world tests passed`);
removeTempDir(dir);
