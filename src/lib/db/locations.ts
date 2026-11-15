import { foldName } from "@/lib/language/text-logic";
import { getDatabase, nowIso, parseJson } from "@/lib/db/core";
import { additionsTo, composeLayout, LAYOUT_MAX } from "@/lib/db/written-layout";
import type { GeneratedImage } from "@/lib/types";

// Structured location state: the DM records each area's layout and exits so
// narration stays spatially consistent and maps render per area.

export type CampaignLocation = {
  id: string;
  campaignId: string;
  name: string;
  layoutDescription: string;
  // The place as the adventure writes it (a pack's room, a workshop's place,
  // one typed into WorldForge), or '' for a place the DM made up in play.
  // A written place's layoutDescription is this text, then the DM's own
  // additions (src/lib/db/written-layout.ts); the DM never writes over it.
  writtenLayout: string;
  // The routes the adventure gives a written place, or [] when none were
  // recorded. connections also gathers every place the party arrived from
  // and every route the DM named in play, which are not this room's exits.
  writtenConnections: string[];
  connections: string[];
  visited: boolean;
  isCurrent: boolean;
  mapImage: GeneratedImage | null;
  // Why the last map render failed, while the place has no map. Kept so a
  // reload shows the failure instead of a placeholder that never ends.
  mapFailed: string | null;
  // The prepared map this place stands on, when the DM linked one, and the
  // sound it makes (docs/vtt-parity-implementation-plan.md section 3.5).
  preparedMapId: string | null;
  ambience: { bed: string; music: string } | null;
  createdAt: string;
  updatedAt: string;
};

type LocationRow = {
  id: string;
  campaign_id: string;
  name: string;
  layout_description: string;
  written_layout: string | null;
  written_connections: string | null;
  connections_json: string;
  visited: number;
  is_current: number;
  map_image_json: string | null;
  prepared_map_id: string | null;
  ambience_json: string | null;
  created_at: string;
  updated_at: string;
};

// map_image_json holds the map, or, while there is none, why the last render
// failed ({ failed }): the failure needs to outlive its ephemeral
// media_status without a column of its own.
type StoredMap = GeneratedImage | { failed: string };

function storedMap(raw: string | null): { mapImage: GeneratedImage | null; mapFailed: string | null } {
  const stored = parseJson<StoredMap | null>(raw, null);
  if (stored && "url" in stored) {
    return { mapImage: stored, mapFailed: null };
  }
  return { mapImage: null, mapFailed: stored && typeof stored.failed === "string" ? stored.failed : null };
}

function mapLocation(row: LocationRow): CampaignLocation {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    layoutDescription: row.layout_description,
    writtenLayout: row.written_layout ?? "",
    writtenConnections: row.written_connections ? parseJson<string[]>(row.written_connections, []) : [],
    connections: parseJson<string[]>(row.connections_json, []),
    visited: Boolean(row.visited),
    isCurrent: Boolean(row.is_current),
    ...storedMap(row.map_image_json),
    preparedMapId: row.prepared_map_id ?? null,
    ambience: parseJson<{ bed: string; music: string } | null>(row.ambience_json ?? "", null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getLocation(id: string): CampaignLocation | null {
  const row = getDatabase().prepare(`SELECT * FROM locations WHERE id = ?`).get(id) as
    | LocationRow
    | undefined;
  return row ? mapLocation(row) : null;
}

// A place's exits as the DM is shown them: a written place's own routes when
// the adventure gave it some, else every route on record.
export function routesOf(location: Pick<CampaignLocation, "writtenLayout" | "writtenConnections" | "connections">): string[] {
  return location.writtenLayout.trim() && location.writtenConnections.length ? location.writtenConnections : location.connections;
}

// Compared in JavaScript, by Unicode case and form (src/lib/language): SQLite's
// NOCASE folds ASCII only, so "église" after "Église" would be a second place.
export function getLocationByName(campaignId: string, name: string): CampaignLocation | null {
  const wanted = foldName(name);
  return listLocations(campaignId).find((location) => foldName(location.name) === wanted) ?? null;
}

export function listLocations(campaignId: string): CampaignLocation[] {
  const rows = getDatabase()
    .prepare(`SELECT * FROM locations WHERE campaign_id = ? ORDER BY updated_at DESC`)
    .all(campaignId) as LocationRow[];
  return rows.map(mapLocation);
}

export function getCurrentLocation(campaignId: string): CampaignLocation | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM locations WHERE campaign_id = ? AND is_current = 1 LIMIT 1`)
    .get(campaignId) as LocationRow | undefined;
  return row ? mapLocation(row) : null;
}

// Moving to a place already on record (usually a return) adds routes rather
// than replacing them: away from a place the model never sees its recorded
// exits, so what it passes on the way back is a fresh guess that would drop
// the routes already known. update_location remains the way to revise them.
// Names are compared folded, as places are (getLocationByName).
export function withNewNames(known: string[], added: string[]): string[] {
  const seen = new Set(known.map(foldName));
  const merged = [...known];
  for (const name of added) {
    const folded = foldName(name);
    if (!seen.has(folded)) {
      seen.add(folded);
      merged.push(name);
    }
  }
  return merged;
}

// Create-or-update by name, mark it current + visited, clear other currents.
// A written place keeps its record whatever layout comes with the move: the
// DM describes a room it has not seen, and that guess must not replace the
// room the adventure wrote (src/lib/db/written-layout.ts).
export function upsertCurrentLocation(input: {
  campaignId: string;
  name: string;
  layoutDescription?: string;
  connections?: string[];
}): CampaignLocation {
  const db = getDatabase();
  const now = nowIso();
  const existing = getLocationByName(input.campaignId, input.name);

  const apply = db.transaction(() => {
    db.prepare(`UPDATE locations SET is_current = 0 WHERE campaign_id = ?`).run(input.campaignId);
    if (existing) {
      db.prepare(
        `
          UPDATE locations SET
            layout_description = ?, connections_json = ?, visited = 1,
            is_current = 1, updated_at = ?
          WHERE id = ?
        `,
      ).run(
        existing.writtenLayout.trim()
          ? existing.layoutDescription
          : input.layoutDescription?.trim() || existing.layoutDescription,
        JSON.stringify(
          input.connections ? withNewNames(existing.connections, input.connections) : existing.connections,
        ),
        now,
        existing.id,
      );
      return existing.id;
    }
    const id = crypto.randomUUID();
    db.prepare(
      `
        INSERT INTO locations (
          id, campaign_id, name, layout_description, connections_json,
          visited, is_current, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
      `,
    ).run(
      id,
      input.campaignId,
      input.name.trim().slice(0, 80),
      (input.layoutDescription ?? "").trim().slice(0, 2_000),
      JSON.stringify(input.connections ?? []),
      now,
      now,
    );
    return id;
  });

  const id = apply();
  const location = getLocation(id);
  if (!location) {
    throw new Error("Failed to upsert location.");
  }
  return location;
}

// A written place takes a revision as additions after its written text,
// replacing the additions before them; anywhere else the revision is the
// new layout.
export function updateCurrentLocationDetails(
  campaignId: string,
  patch: { layoutDescription?: string; connections?: string[] },
): CampaignLocation | null {
  const current = getCurrentLocation(campaignId);
  if (!current) {
    return null;
  }
  let layout = patch.layoutDescription ?? current.layoutDescription;
  if (current.writtenLayout.trim() && patch.layoutDescription !== undefined) {
    const added = additionsTo(current.writtenLayout, current.layoutDescription, patch.layoutDescription);
    layout = added === null ? current.layoutDescription : composeLayout(current.writtenLayout, added);
  }
  getDatabase()
    .prepare(
      `UPDATE locations SET layout_description = ?, connections_json = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      layout.trim().slice(0, LAYOUT_MAX),
      JSON.stringify(patch.connections ?? current.connections),
      nowIso(),
      current.id,
    );
  return getLocation(current.id);
}

// A place the party has not been to yet: named on the map, unvisited, and
// not where anyone is standing. This is how a DM populates a region before
// play, and how a described overworld's starting locations arrive. Returns
// the existing row untouched when the name is already known, so re-running a
// description never duplicates a town. `written` marks the text as the
// adventure's own (one typed into WorldForge), which the DM narrates from and
// never writes over; an imported map's one-line blurb is not, so the DM's
// arrival can still describe the town properly.
export function insertKnownLocation(input: {
  campaignId: string;
  name: string;
  layoutDescription?: string;
  connections?: string[];
  written?: boolean;
}): CampaignLocation | null {
  const name = input.name.trim().slice(0, 80);
  if (!name) {
    return null;
  }
  const existing = getLocationByName(input.campaignId, name);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  getDatabase()
    .prepare(
      `INSERT INTO locations (
         id, campaign_id, name, layout_description, written_layout, written_connections, connections_json,
         visited, is_current, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    )
    .run(
      id,
      input.campaignId,
      name,
      (input.layoutDescription ?? "").trim().slice(0, 2_000),
      input.written ? (input.layoutDescription ?? "").trim().slice(0, 2_000) : "",
      input.written && input.connections?.length ? JSON.stringify(input.connections) : "",
      JSON.stringify(input.connections ?? []),
      now,
      now,
    );
  return getLocation(id);
}

// Renames a place and repoints every connection that named it. Connections
// are stored as names rather than ids, so a rename that touched only this
// row would quietly cut the location out of the overworld's route graph.
// Returns null when the name is taken or the location is gone.
export function renameLocation(
  campaignId: string,
  locationId: string,
  name: string,
): CampaignLocation | null {
  const trimmed = name.trim().slice(0, 80);
  const location = getLocation(locationId);
  if (!trimmed || !location || location.campaignId !== campaignId) {
    return null;
  }
  if (trimmed.toLowerCase() === location.name.toLowerCase()) {
    return location;
  }
  const clash = getLocationByName(campaignId, trimmed);
  if (clash && clash.id !== locationId) {
    return null;
  }
  const db = getDatabase();
  const now = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE locations SET name = ?, updated_at = ? WHERE id = ?`).run(
      trimmed,
      now,
      locationId,
    );
    for (const other of listLocations(campaignId)) {
      if (other.id === locationId) {
        continue;
      }
      const repoint = (names: string[]) =>
        names.map((connection) => (connection.trim().toLowerCase() === location.name.toLowerCase() ? trimmed : connection));
      const repointed = repoint(other.connections);
      if (repointed.join("\u0000") !== other.connections.join("\u0000")) {
        db.prepare(`UPDATE locations SET connections_json = ? WHERE id = ?`).run(
          JSON.stringify(repointed),
          other.id,
        );
      }
      // A written place's own routes name it too.
      const written = repoint(other.writtenConnections);
      if (written.join("\u0000") !== other.writtenConnections.join("\u0000")) {
        db.prepare(`UPDATE locations SET written_connections = ? WHERE id = ?`).run(JSON.stringify(written), other.id);
      }
    }
  })();
  return getLocation(locationId);
}

// null takes the map away: the panel shows the stand-in plate for the kind
// of place it is until somebody draws or uploads another.
export function setLocationMap(locationId: string, image: GeneratedImage | null): boolean {
  const result = getDatabase()
    .prepare(`UPDATE locations SET map_image_json = ?, updated_at = ? WHERE id = ?`)
    .run(image ? JSON.stringify(image) : null, nowIso(), locationId);
  return result.changes > 0;
}

// A map render failed. Recorded only while the place has no map: a failed
// redraw leaves the map it already had. Not a change to the place itself, so
// updated_at (the panel's order) is left alone.
export function setLocationMapFailed(locationId: string, reason: string): boolean {
  const location = getLocation(locationId);
  if (!location || location.mapImage) {
    return false;
  }
  getDatabase()
    .prepare(`UPDATE locations SET map_image_json = ? WHERE id = ?`)
    .run(JSON.stringify({ failed: reason } satisfies StoredMap), locationId);
  return true;
}

// A new render is on its way: the old failure no longer describes the place.
export function clearLocationMapFailed(locationId: string): boolean {
  if (!getLocation(locationId)?.mapFailed) {
    return false;
  }
  getDatabase().prepare(`UPDATE locations SET map_image_json = NULL WHERE id = ?`).run(locationId);
  return true;
}

// Link a place to a prepared map and a sound, or clear either with null.
export function setLocationLinks(
  locationId: string,
  links: { preparedMapId?: string | null; ambience?: { bed: string; music: string } | null },
) {
  const db = getDatabase();
  if (links.preparedMapId !== undefined) {
    db.prepare(`UPDATE locations SET prepared_map_id = ?, updated_at = ? WHERE id = ?`).run(
      links.preparedMapId,
      nowIso(),
      locationId,
    );
  }
  if (links.ambience !== undefined) {
    db.prepare(`UPDATE locations SET ambience_json = ?, updated_at = ? WHERE id = ?`).run(
      links.ambience ? JSON.stringify(links.ambience) : null,
      nowIso(),
      locationId,
    );
  }
}

// A generated place's description, written only when the place had none
// (docs/vtt-parity-implementation-plan.md 12.1), or the author's own text
// from WorldForge, which `written` makes the place's written text too.
export function setLocationLayout(
  locationId: string,
  layoutDescription: string,
  options: { written?: boolean } = {},
): CampaignLocation | null {
  const text = layoutDescription.slice(0, LAYOUT_MAX);
  const db = getDatabase();
  if (options.written) {
    db.prepare(`UPDATE locations SET layout_description = ?, written_layout = ?, updated_at = ? WHERE id = ?`).run(
      text,
      text.trim(),
      nowIso(),
      locationId,
    );
  } else {
    db.prepare(`UPDATE locations SET layout_description = ?, updated_at = ? WHERE id = ?`).run(text, nowIso(), locationId);
  }
  return getLocation(locationId);
}
