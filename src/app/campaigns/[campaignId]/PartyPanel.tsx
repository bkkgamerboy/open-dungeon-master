"use client";

import { TravelFormation } from "@/app/campaigns/[campaignId]/TravelFormation";
import { PartyPackPanel } from "@/app/campaigns/[campaignId]/PartyPackPanel";
import type { PlaceRef } from "@/lib/dm/pack-logic";
import type { PartyState } from "@/lib/dm/party-logic";
import { fieldedOf } from "@/lib/player-characters";
import { Bot, Check, Crown, Heart, ImagePlus, PawPrint, Save, Sparkles, Swords, UserPlus } from "lucide-react";
import { describeExhaustion } from "@/lib/dm/condition-logic";
import { namesLookup } from "@/lib/battlemap/condition-notes";
import { conditionIconKey } from "@/lib/battlemap/condition-glyphs";
import { conditionDetail, maxHpView } from "@/components/sheet/sheet-state";
import type { PublicEncounter } from "@/lib/db/encounter-view";
import { GameIcon } from "@/components/ui/GameIcon";
import { SectionHead } from "@/components/ui/SectionHead";
import { KitButton, SettingToggle } from "./PanelKit";
import { PartyOrderBar, PartyOrderHandle, usePartyOrder } from "./PartyOrder";
import { useEffect, useId, useState, Suspense, lazy } from "react";
import { cn } from "@/lib/cn";
import { CountPop } from "@/components/ui/Reveal";
import { CharacterPortrait } from "@/lib/ui";
import { CharacterMenu } from "@/app/campaigns/[campaignId]/CharacterMenu";
import { CharacterNotesDialog } from "@/app/campaigns/[campaignId]/CharacterNotesDialog";
import { CharacterSheetDialog } from "@/app/campaigns/[campaignId]/CharacterSheetDialog";
import { TradeDialog } from "@/app/campaigns/[campaignId]/TradeDialog";
import { CompanionBuilderDialog } from "@/app/campaigns/[campaignId]/CompanionBuilderDialog";
import { DiceSourcesButton } from "@/app/campaigns/[campaignId]/DiceSourcesDialog";
import { DiceLookButton } from "@/components/DiceLookEditor";
import { LeadEditDialog } from "@/app/campaigns/[campaignId]/LeadEditDialog";
import type { CampaignMember } from "@/lib/campaign-types";
import type { Note } from "@/lib/db/notes";
import type { Genre, LastingCompanionBlock } from "@/lib/schemas/game-settings";
import type { CharacterSheet } from "@/lib/schemas/sheet";
import { computeSheetDerived, formatModifier, levelForXp } from "@/lib/srd";
import type { HpMethod } from "@/lib/srd/hit-points";
import { usePackArt } from "@/lib/worlds/use-pack-art";

// The portrait cropper (and its cropping library) loads when a portrait is
// being cropped, not with the table.
const AvatarCropDialog = lazy(() =>
  import("@/app/settings/AvatarCropDialog").then((module) => ({ default: module.AvatarCropDialog })),
);
// The level-up dialog, for a companion whose lead builds their levels; a
// player's own opens from the session view.
const LevelUpDialog = lazy(() =>
  import("@/app/campaigns/[campaignId]/LevelUpDialog").then((module) => ({ default: module.LevelUpDialog })),
);

// Inspiration held (resources.inspiration, used below its one use).
function inspired(sheet: CharacterSheet): boolean {
  const pool = sheet.resources?.inspiration;
  return Boolean(pool && pool.used < pool.max);
}

// Mid-game physical-dice opt-in/out; the same per-member preference the
// Lobby toggle writes. Turning it ON means the DM pauses on your rolls and
// asks for the numbers from your real dice.
function RealDiceToggle({
  campaignId,
  member,
}: {
  campaignId: string;
  member: CampaignMember;
}) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try {
      await fetch(`/api/campaigns/${campaignId}/members/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useRealDice: !member.useRealDice }),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingToggle
      on={member.useRealDice}
      onToggle={() => void toggle()}
      disabled={busy}
      aria-busy={busy}
      label="Physical dice"
      title={
        member.useRealDice
          ? "The game pauses on your rolls and asks for your real dice results. Click to switch back to automatic digital rolls."
          : "Roll your own physical dice: the game will tell you what to roll and wait for your result. Click to opt in."
      }
      className="w-full text-xs"
    >
      <GameIcon icon={{ kind: "glyph", key: "die-d20" }} size="size-4" className="mr-1 inline-block align-middle" />
      {member.useRealDice ? "Physical dice: ON" : "Physical dice: off"}
    </SettingToggle>
  );
}

// Nudges the DM to write an AI companion into the story (the DM decides who
// arrives and how); shown while the table is below its companion cap.
function RequestCompanionButton({ campaignId }: { campaignId: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  async function request() {
    setState("sending");
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/companions/request`, {
        method: "POST",
      });
      setState(response.ok ? "sent" : "idle");
      if (response.ok) {
        setTimeout(() => setState("idle"), 4_000);
      }
    } catch {
      setState("idle");
    }
  }
  return (
    <KitButton
      tone="secondary"
      onClick={request}
      disabled={state !== "idle"}
      busy={state === "sending"}
      title="Ask the DM to write an ally with a real character sheet into the story"
      className="w-full disabled:opacity-60"
    >
      {state === "sending" ? null : <GameIcon icon={{ kind: "glyph", key: "system-party" }} size="size-5" />}
      {state === "sent" ? "The DM has been asked" : "Request a companion"}
    </KitButton>
  );
}

// Brings a Game settings row into view once the Setup tab has mounted it
// (a moment after the switch) and flashes it, so "change this" lands on
// the one control meant rather than the top of a long panel.
function revealSettingsRow(row: string, tries = 40) {
  const element = document.querySelector<HTMLElement>(`[data-settings-row="${row}"]`);
  if (!element) {
    if (tries > 0) window.setTimeout(() => revealSettingsRow(row, tries - 1), 50);
    return;
  }
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  element.removeAttribute("data-flash");
  void element.offsetWidth;
  element.setAttribute("data-flash", "");
}

// A player sheet whose library entry is an ally the DM plays came in through
// the wrong door before the doors checked (issue 192). Whoever runs the
// story hands it to the DM: same sheet, same progress, a bot owner and the
// DM's turns from here. The server holds the companion setting and cap;
// when either shuts the door the button says so before it is pressed, with
// the setting to change (issue 209), and the server refuses in the same
// words for a stale page.
function HandToDmButton({
  campaignId,
  sheet,
  blocked,
  onOpenSettings,
}: {
  campaignId: string;
  sheet: CharacterSheet;
  blocked: LastingCompanionBlock | null;
  onOpenSettings?: () => void;
}) {
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [error, setError] = useState("");
  const whyId = useId();
  async function adopt() {
    setState("sending");
    setError("");
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/companions/adopt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetId: sheet.id }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || "Could not hand the character to the DM.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setState("idle");
    }
  }
  return (
    <div className="reveal mt-2 space-y-1">
      <p className="text-[11px] leading-4 text-amber-200">
        {sheet.name} is filed in the library as an ally the DM plays, but sits here as a player&apos;s character, so the DM takes no turns for them.
      </p>
      {blocked ? (
        <div
          id={whyId}
          key={blocked.code}
          className="reveal space-y-1 rounded-md border border-amber-700/40 bg-amber-950/20 p-2 text-[11px] leading-4 text-stone-300"
        >
          <p>{blocked.reason}</p>
          <p className="text-stone-400">{blocked.remedy}</p>
          {onOpenSettings ? (
            <button
              type="button"
              onClick={() => {
                onOpenSettings();
                revealSettingsRow("allies");
              }}
              className="font-medium text-amber-300 underline decoration-amber-500/40 underline-offset-2 transition-colors hover:text-amber-100"
            >
              Open Game settings
            </button>
          ) : null}
        </div>
      ) : null}
      <KitButton
        tone="secondary"
        onClick={adopt}
        disabled={state === "sending" || Boolean(blocked)}
        busy={state === "sending"}
        aria-describedby={blocked ? whyId : undefined}
        title={
          blocked
            ? blocked.reason
            : "Make this character a party companion: the sheet and its progress stay, the DM plays it from here"
        }
        className="w-full justify-center"
      >
        {state === "sending" ? null : <Bot className="size-3.5" />} Hand to the DM
      </KitButton>
      {error ? (
        <p role="alert" className="motion-shake text-[11px] text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// "Play this ally yourself": an ally the DM plays becomes one of the lead's
// own characters, in fights and in the story (companions/[id]/take). Its
// sheet, progress and place in a fight in progress stay; a table that fields
// one character each starts fielding them all, so the ally's Hand comes up
// on its turn. Asked once before it happens, since the DM stops speaking
// for the ally from then on.
function TakeOverAllyButton({ campaignId, sheet }: { campaignId: string; sheet: CharacterSheet }) {
  const [state, setState] = useState<"idle" | "asking" | "sending">("idle");
  const [error, setError] = useState("");
  async function take() {
    setState("sending");
    setError("");
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/companions/${sheet.id}/take`, { method: "POST" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || `Could not take over ${sheet.name}.`);
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setState("idle");
    }
  }
  return (
    <div className="reveal mt-2 space-y-1">
      {state === "asking" ? (
        <div className="reveal space-y-1.5 rounded-md border border-amber-700/40 bg-amber-950/20 p-2 text-[11px] leading-4 text-stone-300">
          <p>
            You play {sheet.name} from now on: their turns in a fight, and what they say and do in the story. The DM
            stops playing them. You can hand them back any time.
          </p>
          <div className="flex gap-1.5">
            <KitButton tone="primary" onClick={take} className="flex-1 justify-center">
              Play {sheet.name}
            </KitButton>
            <KitButton onClick={() => setState("idle")} className="flex-1 justify-center">
              Not now
            </KitButton>
          </div>
        </div>
      ) : (
        <KitButton
          tone="secondary"
          onClick={() => setState("asking")}
          disabled={state === "sending"}
          busy={state === "sending"}
          title={`Control ${sheet.name} yourself: their sheet and progress stay`}
          className="w-full justify-center"
        >
          {state === "sending" ? null : <Swords className="size-3.5" />} Play this ally yourself
        </KitButton>
      )}
      {error ? (
        <p role="alert" className="motion-shake text-[11px] text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// The way back: one of the player's own characters, an ally they took over,
// travels on as an ally the DM plays (companions/hand-back). Only while they
// keep another character to play; the server holds the companion setting
// and cap, and says so in its refusal.
function HandBackButton({ campaignId, sheet }: { campaignId: string; sheet: CharacterSheet }) {
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [error, setError] = useState("");
  async function handBack() {
    setState("sending");
    setError("");
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/companions/hand-back`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetId: sheet.id }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || `Could not hand ${sheet.name} back to the DM.`);
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setState("idle");
    }
  }
  return (
    <div className="reveal mt-2 space-y-1">
      <KitButton
        onClick={handBack}
        disabled={state === "sending"}
        busy={state === "sending"}
        title={`${sheet.name} travels on as an ally the DM plays; the sheet and progress stay`}
        className="w-full justify-center"
      >
        {state === "sending" ? null : <Bot className="size-3.5" />} Hand {sheet.name} back to the DM
      </KitButton>
      {error ? (
        <p role="alert" className="motion-shake text-[11px] text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// A table below the library character's level saves gear, gold and notes
// only; the library keeps its own level (issue #36), and the button says so
// for a moment instead of a bare "Saved".
// A companion's card has one too, for whoever runs the story: it saves the
// ally to their own library (companions/[id]/library), linking it first if
// it was never linked, and says when that made a new library entry.
function SaveToLibraryButton({ campaignId, sheetId, companion = false }: { campaignId: string; sheetId: string; companion?: boolean }) {
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [keptLevel, setKeptLevel] = useState<number | null>(null);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setState("saving");
    setError("");
    try {
      // The card's own sheet: a player fielding several has a button on each.
      const response = companion
        ? await fetch(`/api/campaigns/${campaignId}/companions/${sheetId}/library`, { method: "POST" })
        : await fetch(`/api/campaigns/${campaignId}/sheet/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ characterId: sheetId }),
          });
      const data = await response.json().catch(() => ({}));
      const kept = response.ok && typeof data.keptLevel === "number" ? data.keptLevel : null;
      setKeptLevel(kept);
      setCreated(response.ok && data.created === true);
      if (!response.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not save to your library.");
      }
      setState(response.ok ? "saved" : "idle");
      if (response.ok) {
        const shown = kept === null && data.created !== true ? 2_000 : 5_000;
        setTimeout(() => {
          setState("idle");
          setKeptLevel(null);
          setCreated(false);
        }, shown);
      }
    } catch {
      setState("idle");
    }
  }
  return (
    <div className="space-y-1">
      <KitButton onClick={save} disabled={state === "saving"} busy={state === "saving"} title="Save level, gear, and spells back to your character library. A character above this table's level keeps its own level; gear, gold and notes still save." className="w-full justify-center">
        {state === "saved" ? (
          <>
            <Check className="motion-pop size-3.5 text-emerald-400" /> {keptLevel === null ? "Saved" : "Gear and notes saved"}
          </>
        ) : state === "saving" ? (
          "Save to library"
        ) : (
          <>
            <Save className="size-3.5" /> Save to library
          </>
        )}
      </KitButton>
      {state === "saved" && keptLevel !== null ? (
        <p className="reveal text-center text-[11px] text-amber-200">
          Level {keptLevel} kept in your library; this table is below it.
        </p>
      ) : null}
      {state === "saved" && created ? (
        <p className="reveal text-center text-[11px] text-emerald-300">Added to your library as a companion.</p>
      ) : null}
      {error ? <p className="reveal text-center text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
}

export function PartyPanel({
  sheets,
  meUserId,
  spotlightUserIds = [],
  onlineUserIds = [],
  embedded = false,
  steersStory = false,
  leadUserId = "",
  canTransferLead = false,
  notes = [],
  members = [],
  refreshNotes,
  onMessageUser,
  realDiceAllowed = false,
  encumbranceRule = false,
  inCombat = false,
  encounter = null,
  campaignId = "",
  companionsAvailable = false,
  companionBuildAvailable = false,
  companionBlock = null,
  onOpenSettings,
  humanDmTable = false,
  companionGenre,
  companionLevel = 1,
  worldPack = "",
  lights = {},
  activeSheetId = "",
  multiCharacter = "off",
  levelUpLevel = null,
  onLevelUp,
  party,
  arrangesFormation = false,
  companionLevelUps = "lead",
  multiclassAllowed = true,
  hpMethod = "average",
  here = null,
}: {
  // Where the party stands, for the pack animals and the town boxes.
  here?: PlaceRef | null;
  sheets: CharacterSheet[];
  meUserId: string;
  // Who builds a party companion's level-up (game setting), and the table's
  // rules the dialog follows when it is the lead.
  companionLevelUps?: "lead" | "auto";
  multiclassAllowed?: boolean;
  hpMethod?: HpMethod;
  // The party record, for the travel formation, and whether this seat
  // arranges it (the party lead, or the DM seat where a person runs it).
  party?: PartyState;
  arrangesFormation?: boolean;
  // A level-up the experience has earned and nobody has taken yet: the
  // owner's card offers it.
  levelUpLevel?: number | null;
  onLevelUp?: () => void;
  // The table's optional encumbrance rule; the sheet only warns about a
  // heavy pack when the rule that penalizes it is actually on.
  encumbranceRule?: boolean;
  spotlightUserIds?: string[];
  // Who has the campaign open in a live tab (presence). Shown to every seat:
  // who is at the table is not a secret from anyone.
  onlineUserIds?: string[];
  embedded?: boolean;
  steersStory?: boolean;
  leadUserId?: string;
  canTransferLead?: boolean;
  notes?: Note[];
  members?: CampaignMember[];
  refreshNotes?: () => Promise<void>;
  onMessageUser?: (userId: string) => void;
  realDiceAllowed?: boolean;
  // Active encounter: the owner's counter steppers lock the recover side.
  inCombat?: boolean;
  // The fight as the engine projects it: whose turn it is, and the names a
  // condition's "until X's turn" or "from X" may show.
  encounter?: PublicEncounter | null;
  // AI companions: when a party or guest slot is free, show the request button.
  campaignId?: string;
  companionsAvailable?: boolean;
  // Manual build (lasting party companion) is offered only when the table
  // allows party companions and a party slot is free.
  companionBuildAvailable?: boolean;
  // Why a lasting party companion cannot join now, and how to allow one
  // (game-settings.ts lastingCompanionBlock): said beside Hand to the DM.
  companionBlock?: LastingCompanionBlock | null;
  // Opens the Setup tab, where that setting lives.
  onOpenSettings?: () => void;
  // A person runs this table. There is no AI to ask for an ally, so the
  // request button goes and the build button is the only door left; it is
  // also the door that lets a human DM hold a character sheet of their own.
  humanDmTable?: boolean;
  companionGenre?: Genre;
  companionLevel?: number;
  // The campaign's world pack, whose art stands in for an unpainted portrait.
  worldPack?: string;
  // A carried light burning down, by character id
  // (docs/vtt-parity-implementation-plan.md 7.3).
  lights?: Record<string, { remaining: number; total: number }>;
  // Several characters per player (11.3): which of mine is in play.
  activeSheetId?: string;
  multiCharacter?: "off" | "one_active" | "all_active";
}) {
  const packArt = usePackArt(worldPack);
  const [editingSheetId, setEditingSheetId] = useState("");
  const [viewingSheetId, setViewingSheetId] = useState("");
  const [croppingSheetId, setCroppingSheetId] = useState("");
  const [notesSheetId, setNotesSheetId] = useState("");
  const [buildingCompanion, setBuildingCompanion] = useState(false);
  const [levelingCompanionId, setLevelingCompanionId] = useState("");
  const [tradingWithId, setTradingWithId] = useState("");
  const [switching, setSwitching] = useState("");
  const [switchError, setSwitchError] = useState("");
  const tradingWith = sheets.find((sheet) => sheet.id === tradingWithId);
  const myOwn = sheets.filter((sheet) => sheet.userId === meUserId && !sheet.isCompanion);
  const mySheet = myOwn.find((sheet) => sheet.id === activeSheetId) ?? myOwn[0];
  const myMember = members.find((member) => member.userId === meUserId);
  // Each viewer's own order for the cards (issue 240): display only, kept
  // on their membership so it follows their account.
  const order = usePartyOrder({ campaignId, member: myMember, cards: sheets });

  async function playAs(sheetId: string) {
    setSwitching(sheetId);
    try {
      setSwitchError("");
      const response = await fetch(`/api/campaigns/${campaignId}/sheet/switch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: sheetId }) });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        setSwitchError(result.error || "Could not select the character.");
      }
    } catch {
      setSwitchError("Could not reach the server.");
    } finally {
      setSwitching("");
    }
  }
  const editingSheet = sheets.find((sheet) => sheet.id === editingSheetId);
  const viewingSheet = sheets.find((sheet) => sheet.id === viewingSheetId);
  const levelingCompanion = levelingCompanionId ? sheets.find((sheet) => sheet.id === levelingCompanionId) : undefined;
  const croppingSheet = sheets.find((sheet) => sheet.id === croppingSheetId);
  const notesSheet = sheets.find((sheet) => sheet.id === notesSheetId);
  // Who a condition's metadata may name: the party, and the fight's order as
  // this viewer sees it.
  const conditionNames = [
    ...sheets.map((entry) => ({ id: entry.id, name: entry.name })),
    ...(encounter?.order ?? []).map((entry) => ({ id: entry.id, name: entry.name })),
  ];
  const nameOf = namesLookup(conditionNames);
  const Wrapper = embedded ? "div" : "aside";

  // Safety net for the Radix dropdown-opens-dialog race: whenever every
  // dialog owned by this panel is closed, body pointer-events must be back;
  // a stranded pointer-events:none makes the whole page unclickable.
  const anyDialogOpen = Boolean(
    editingSheetId || viewingSheetId || croppingSheetId || notesSheetId || buildingCompanion,
  );
  useEffect(() => {
    if (!anyDialogOpen && document.body.style.pointerEvents === "none") {
      document.body.style.pointerEvents = "";
    }
  }, [anyDialogOpen]);

  // A companion's sheet is owned by its bot, so the route needs to be told
  // which sheet is meant; a player's own sheet is found from the session.
  async function setPortrait(sheet: CharacterSheet, url: string) {
    await fetch(`/api/campaigns/${sheet.campaignId}/sheet`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        sheet.userId === meUserId
          ? { characterId: sheet.id, portrait: { url } }
          : { sheetId: sheet.id, portrait: { url } },
      ),
    });
  }
  return (
    <Wrapper
      className={cn(
        embedded
          ? "stagger-up space-y-3"
          : "stagger-up hidden w-64 shrink-0 space-y-3 overflow-y-auto border-l border-stone-800 p-3 lg:block",
      )}
    >
      {embedded ? null : (
        <SectionHead title="Party" glyph="tab-party" level="h2" aside={sheets.length} />
      )}
      {switchError ? <p role="alert" className="text-sm text-red-300">{switchError}</p> : null}
      <PartyOrderBar
        count={campaignId && myMember ? sheets.length : 0}
        arranging={order.arranging}
        custom={order.custom}
        error={order.error}
        onToggle={() => order.setArranging(!order.arranging)}
        onReset={order.reset}
      />
      {order.ordered.map((sheet, cardIndex) => {
        const derived = computeSheetDerived(sheet);
        const mine = sheet.userId === meUserId;
        // Companions belong to nobody at the table, so their portrait is
        // whoever runs the story's to set (uploaded, since the render that
        // would have painted one needs an image backend the server may lack).
        const setsPortrait = mine || (sheet.isCompanion && steersStory);
        // Wild Shape: the beast's pool is what damage actually hits, so the
        // bar tracks it and the druid's own hit points wait in the label.
        const shape = sheet.wildShape;
        // The maximum the engine heals to (exhaustion 4 halves it).
        const hp = maxHpView(sheet);
        const hpFraction = shape
          ? shape.beastMaxHp > 0
            ? shape.beastHp / shape.beastMaxHp
            : 0
          : hp.max > 0
            ? sheet.currentHp / hp.max
            : 0;
        const publicNoteCount = notes.filter(
          (note) => note.characterId === sheet.id && note.visibility === "public",
        ).length;
        return (
          <div
            key={sheet.id}
            data-party-card={sheet.id}
            data-dragging={order.drag?.id === sheet.id ? "" : undefined}
            data-drop={order.drag?.over?.id === sheet.id ? order.drag.over.side : undefined}
            data-moved={order.moved === sheet.id ? "" : undefined}
            className={cn(
              "party-card panel rounded-xl p-3 transition-shadow duration-200",
              mine && "ornate border-amber-600/40",
              spotlightUserIds.includes(sheet.userId) &&
                "border-amber-500/70 ring-1 ring-amber-500/60 shadow-glow-gold-strong",
            )}
          >
            <div className="flex items-start gap-1">
              {order.arranging ? (
                <PartyOrderHandle
                  id={sheet.id}
                  name={sheet.name}
                  index={cardIndex}
                  count={order.ordered.length}
                  drag={order.drag}
                  onMove={order.move}
                  onPlace={order.place}
                  onDrag={order.setDrag}
                />
              ) : null}
              <button
                type="button"
                onClick={() => setViewingSheetId(sheet.id)}
                title="View full character sheet"
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 motion-press"
              >
              <CharacterPortrait
                url={sheet.portrait?.url}
                fallback={packArt.characterUrl({ race: sheet.race, class: sheet.class })}
                look={{ race: sheet.race, class: sheet.class, gender: sheet.gender }}
                alt={sheet.name}
                size="size-12"
                className="border-amber-500/30 shadow-glow-gold"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-medium">
                  <span className="truncate">{sheet.name}</span>
                  {lights[sheet.id] ? <LightBar light={lights[sheet.id]} /> : null}
                  {mine && multiCharacter !== "off" && myOwn.length > 1 ? (
                    mySheet?.id === sheet.id ? (
                      <span className="eyebrow rounded-sm border border-amber-500/50 bg-amber-400/10 px-1 text-[9px] text-amber-300">playing</span>
                    ) : (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-disabled={switching === sheet.id}
                        // The chip sits inside the card's own button; its press is
                        // its own, or taking a seat would also open the sheet.
                        onClick={(event) => {
                          event.stopPropagation();
                          if (switching !== sheet.id) void playAs(sheet.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          event.stopPropagation();
                          if (switching !== sheet.id) void playAs(sheet.id);
                        }}
                        className="eyebrow inline-flex cursor-pointer items-center rounded-sm border border-stone-600 px-1 text-[9px] text-stone-300 transition-colors duration-[var(--dur-quick,150ms)] hover:border-amber-500/60 hover:text-amber-200 aria-disabled:opacity-50 motion-press"
                      >
                        Play as
                      </span>
                    )
                  ) : null}
                  {!sheet.isCompanion && onlineUserIds.includes(sheet.userId) ? (
                    <span
                      title="Online now"
                      className="size-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.7)]"
                    />
                  ) : null}
                  {sheet.userId === leadUserId ? (
                    <Crown className="size-3.5 shrink-0 text-amber-300" aria-label="Party lead" />
                  ) : null}
                  {sheet.isCompanion ? (
                    <Bot
                      className="size-3.5 shrink-0 text-sky-300"
                      aria-label="AI companion"
                    />
                  ) : null}
                </span>
                <span className="block text-xs text-stone-400">
                  {sheet.raceLabel ?? sheet.race.replaceAll("_", " ")}{" "}
                  {(sheet.classes?.length ?? 0) > 1
                    ? (sheet.classes ?? []).map((entry) => `${entry.id} ${entry.level}`).join(" / ")
                    : `${sheet.class} ${sheet.level}`}
                </span>
              </span>
              </button>
              {publicNoteCount ? (
                <KitButton
                  onClick={() => setNotesSheetId(sheet.id)}
                  title={`${publicNoteCount} party ${publicNoteCount === 1 ? "note" : "notes"} on ${sheet.name}`}
                  className="shrink-0 gap-0.5 rounded-full px-1.5 py-0.5 text-[11px]"
                >
                  <GameIcon icon={{ kind: "glyph", key: "tab-notes" }} size="size-4" /> {publicNoteCount}
                </KitButton>
              ) : null}
              <CharacterMenu
                sheet={sheet}
                steersStory={steersStory}
                leadUserId={leadUserId}
                canTransferLead={canTransferLead}
                onViewSheet={() => setViewingSheetId(sheet.id)}
                onNotes={() => setNotesSheetId(sheet.id)}
                onAdjust={() => setEditingSheetId(sheet.id)}
                onMessage={
                  onMessageUser && !mine && !sheet.isCompanion
                    ? () => onMessageUser(sheet.userId)
                    : undefined
                }
                onTrade={mySheet && sheet.id !== mySheet.id ? () => setTradingWithId(sheet.id) : undefined}
                canModerate={!mine && !sheet.isCompanion}
                canMute={canTransferLead && !mine && !sheet.isCompanion}
                muted={Boolean(
                  members.find((member) => member.userId === sheet.userId)?.muted,
                )}
              />
            </div>

            {shape ? (
              <div
                className="mt-2 flex items-center gap-1.5 rounded-md border border-lime-800/60 bg-lime-950/40 px-2 py-1 text-xs text-lime-300"
                title={`Wild Shaped: damage hits the beast's hit points first. ${sheet.name}'s own ${sheet.currentHp}/${hp.max} waits for them when the form breaks.`}
              >
                <PawPrint className="size-3.5 shrink-0" />
                <span className="truncate capitalize">{shape.form}</span>
              </div>
            ) : null}

            <div className="mt-2 flex items-center gap-2 text-sm">
              <Heart className={cn("size-4", shape ? "text-lime-400" : "text-red-400")} />
              <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-stone-800/80 shadow-[0_1px_2px_rgba(4,2,12,0.6)_inset]">
                {/* The shine is its own keyed layer, so it replays on a change
                    while the fill below stays mounted and eases to its width. */}
                <span
                  key={`hp-${sheet.currentHp}`}
                  data-changed=""
                  aria-hidden="true"
                  className="motion-bar pointer-events-none absolute inset-0 z-[1] rounded-full"
                />
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-500 ease-snap",
                    shape
                      ? "bg-gradient-to-r from-lime-700 to-lime-400"
                      : hpFraction > 0.5
                        ? "bg-gradient-to-r from-emerald-600 to-emerald-400"
                        : hpFraction > 0.25
                          ? "bg-gradient-to-r from-amber-600 to-amber-400"
                          : "bg-gradient-to-r from-red-700 to-ember-500",
                  )}
                  style={{ width: `${Math.max(0, Math.min(1, hpFraction)) * 100}%` }}
                />
              </div>
              {shape ? (
                <span
                  className="font-mono text-xs text-lime-300"
                  title={`Beast form hit points. ${sheet.name}'s own: ${sheet.currentHp}/${hp.max}`}
                >
                  {shape.beastHp}
                  {sheet.tempHp ? `+${sheet.tempHp}` : ""}/{shape.beastMaxHp}
                </span>
              ) : (
                <CountPop value={`${sheet.currentHp}+${sheet.tempHp}/${hp.max}`} className={cn("font-mono text-xs", hp.note && "text-orange-300")}>
                  <span title={hp.note ?? undefined}>
                    {sheet.currentHp}
                    {sheet.tempHp ? `+${sheet.tempHp}` : ""}/{hp.max}
                  </span>
                </CountPop>
              )}
            </div>

            {shape ? (
              <div className="reveal mt-1 text-right font-mono text-[10px] text-stone-500">
                own {sheet.currentHp}/{hp.max}
              </div>
            ) : null}

            {(sheet.pets ?? []).map((pet) => (
              <div
                key={pet.name}
                className="mt-1 flex items-center justify-between text-[10px] text-stone-400"
                title={pet.notes || pet.form}
              >
                <span className="flex min-w-0 items-center gap-1 truncate">
                  <PawPrint className="size-3 shrink-0 text-stone-500" />
                  {pet.name}
                  {pet.name.toLowerCase() !== pet.form.toLowerCase() ? ` (${pet.form})` : ""}
                </span>
                <span className={cn("font-mono", pet.hp <= 0 && "text-red-400")}>
                  {pet.hp}/{pet.maxHp}
                </span>
              </div>
            ))}

            {sheet.deathSaves ? (
              <div
                className={cn(
                  "mt-1.5 flex items-center gap-2 rounded-lg border px-2 py-1.5",
                  sheet.deathSaves.dead
                    ? "border-stone-700/60 bg-stone-950/60"
                    : sheet.deathSaves.stable
                      ? "border-amber-700/50 bg-amber-950/20"
                      : "death-beat border-red-700/60 bg-red-950/30",
                )}
              >
                <GameIcon icon={{ kind: "glyph", key: "rest-death-save" }} size="size-6" className="border-red-800/60" />
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    sheet.deathSaves.dead
                      ? "border-stone-600 bg-stone-900 text-stone-400"
                      : sheet.deathSaves.stable
                        ? "border-amber-700 bg-amber-950/40 text-amber-300"
                        : "border-red-700 bg-red-950/50 text-red-300",
                  )}
                >
                  {sheet.deathSaves.dead ? "Dead" : sheet.deathSaves.stable ? "Stable" : "Dying"}
                </span>
                {!sheet.deathSaves.dead && !sheet.deathSaves.stable ? (
                  <span className="flex items-center gap-1.5" title="Death saves: successes and failures">
                    <span className="flex gap-1.5">
                      {[0, 1, 2].map((pip) => (
                        <span
                          key={`s${pip}`}
                          className={cn(
                            "size-3 rotate-45 rounded-[3px] border transition-colors duration-300",
                            pip < sheet.deathSaves!.successes
                              ? "motion-pop border-amber-300 bg-gradient-to-br from-amber-100 to-amber-500 shadow-[0_0_8px_rgba(212,171,58,0.6)]"
                              : "border-stone-600 bg-transparent",
                          )}
                        />
                      ))}
                    </span>
                    <span className="flex gap-1.5">
                      {[0, 1, 2].map((pip) => (
                        <span
                          key={`f${pip}`}
                          className={cn(
                            "size-3 rotate-45 rounded-[3px] border transition-colors duration-300",
                            pip < sheet.deathSaves!.failures
                              ? "motion-pop border-red-400 bg-gradient-to-br from-red-500 to-stone-950 shadow-[0_0_8px_rgba(220,38,38,0.55)]"
                              : "border-stone-600 bg-transparent",
                          )}
                        />
                      ))}
                    </span>
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
              {(
                [
                  ["AC", String(shape ? shape.beastAc : sheet.ac)],
                  ["PP", String(derived.passivePerception)],
                  ["Init", formatModifier(derived.initiative)],
                ] as const
              ).map(([statLabel, statValue]) => (
                <span
                  key={statLabel}
                  className={cn(
                    "rounded-md border border-stone-700/50 bg-stone-950/60 py-1 shadow-[0_1px_2px_rgba(4,2,12,0.5)_inset]",
                    shape && statLabel === "AC" && "border-lime-800/60 text-lime-300",
                  )}
                  title={
                    shape && statLabel === "AC"
                      ? `The beast form's armor class; ${sheet.name}'s own is ${sheet.ac}.`
                      : undefined
                  }
                >
                  <span className="eyebrow block text-[8px] text-stone-500">
                    <GameIcon
                      icon={{ kind: "glyph", key: statLabel === "AC" ? "rest-ac" : statLabel === "PP" ? "sense-passive-perception" : "rest-initiative" }}
                      size="size-3.5"
                      className="mr-0.5 inline-block -translate-y-px align-middle"
                    />
                    {statLabel}
                  </span>
                  <span className="font-mono text-xs text-stone-200">{statValue}</span>
                </span>
              ))}
            </div>

            {Object.keys(sheet.resources ?? {}).length ? (
              <div className="stagger-pop mt-1.5 flex flex-wrap gap-1">
                {Object.entries(sheet.resources).map(([id, state]) => (
                  <span
                    key={id}
                    className="rounded-full border border-stone-700/50 bg-stone-950/60 px-2 py-0.5 text-[10px] capitalize text-stone-300"
                    title="Limited-use resource: remaining/max"
                  >
                    {id.replaceAll("_", " ")} {state.max - state.used}/{state.max}
                  </span>
                ))}
              </div>
            ) : null}

            {sheet.conditions.length || sheet.concentratingOn || (sheet.exhaustion ?? 0) > 0 || inspired(sheet) ? (
              <div className="stagger-pop mt-1.5 flex flex-wrap gap-1">
                {(sheet.exhaustion ?? 0) > 0 ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-orange-950 px-2 py-0.5 text-xs text-orange-300"
                    title={`${describeExhaustion(sheet.exhaustion ?? 0)}. A long rest lowers it by one.`}
                  >
                    <GameIcon icon={{ kind: "glyph", key: "rest-exhaustion" }} size="size-4" />
                    exhaustion {sheet.exhaustion}
                  </span>
                ) : null}
                {sheet.conditions.map((condition) => {
                  // Rounds, "until Kael's turn", "save ends (WIS 13)", "from
                  // Goblin 2": what the engine stored with the condition.
                  const detail = conditionDetail(sheet, condition, nameOf);
                  return (
                    <span
                      key={condition}
                      className="motion-pop inline-flex max-w-full items-center gap-1 rounded-full bg-red-950 px-2 py-0.5 text-xs text-red-300"
                      title={detail || undefined}
                    >
                      <GameIcon icon={{ kind: "condition", key: conditionIconKey(condition) }} size="size-4" className="border-red-800/60" />
                      {condition}
                      {detail ? <span className="truncate text-red-300/70">({detail})</span> : null}
                    </span>
                  );
                })}
                {inspired(sheet) ? (
                  <span
                    className="motion-pop inline-flex items-center gap-1 rounded-full bg-amber-950 px-2 py-0.5 text-xs text-amber-200"
                    title="Inspiration: spent for advantage on one attack, save or check."
                  >
                    <GameIcon icon={{ kind: "glyph", key: "rest-inspiration" }} size="size-4" />
                    Inspiration
                  </span>
                ) : null}
                {sheet.concentratingOn ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-sky-950 px-2 py-0.5 text-xs text-sky-300"
                    title="Concentrating on this spell"
                  >
                    <GameIcon icon={{ kind: "spell", key: sheet.concentratingOn }} size="size-4" />
                    {sheet.concentratingOn}
                  </span>
                ) : null}
              </div>
            ) : null}

            {mine && !sheet.isCompanion && levelUpLevel && onLevelUp && levelUpLevel > sheet.level ? (
              <KitButton
                tone="primary"
                onClick={onLevelUp}
                title="You have the experience for a new level"
                className="reveal mt-2 w-full justify-center"
              >
                <Sparkles className="size-3.5" /> Level up to {levelUpLevel}
              </KitButton>
            ) : null}

            {campaignId &&
            steersStory &&
            sheet.isCompanion &&
            companionLevelUps === "lead" &&
            sheet.companionKind !== "guest" &&
            !sheet.summon &&
            !sheet.deathSaves?.dead &&
            Math.min(20, levelForXp(sheet.xp)) > sheet.level ? (
              <KitButton
                tone="primary"
                onClick={() => setLevelingCompanionId(sheet.id)}
                title={`${sheet.name} has the experience for a new level; you choose how they grow`}
                className="reveal mt-2 w-full justify-center"
              >
                <Sparkles className="size-3.5" /> Level up {sheet.name} to {sheet.level + 1}
              </KitButton>
            ) : null}

            {/* An ally the lead took over is filed as a companion on purpose,
                and its way back is Hand back, offered just below; this repair
                is for a sheet that has no such way back. */}
            {campaignId &&
            steersStory &&
            !sheet.isCompanion &&
            sheet.libraryRole === "companion" &&
            !(mine && myOwn.length > 1) ? (
              <HandToDmButton campaignId={campaignId} sheet={sheet} blocked={companionBlock} onOpenSettings={onOpenSettings} />
            ) : null}

            {campaignId && steersStory && !humanDmTable && sheet.isCompanion && sheet.companionKind !== "guest" && !sheet.summon ? (
              <TakeOverAllyButton campaignId={campaignId} sheet={sheet} />
            ) : null}

            {/* An ally taken over keeps its brief: the take-over gives a
                blank one a brief of its own (takeOverCompanionSheet). */}
            {campaignId && mine && !sheet.isCompanion && myOwn.length > 1 && (sheet.personality || sheet.libraryRole === "companion") ? (
              <HandBackButton campaignId={campaignId} sheet={sheet} />
            ) : null}

            {setsPortrait ? (
              <div className="reveal mt-2 space-y-1.5">
                {/* Hit points are driven by the server rules engines now, so
                    there is no manual HP stepper here; the lead's Adjust
                    dialog remains for corrections. */}
                <KitButton onClick={() => setCroppingSheetId(sheet.id)} className="w-full justify-center">
                  <ImagePlus className="size-3.5" />
                  {sheet.portrait ? "Change portrait" : "Add portrait"}
                </KitButton>
                {mine ? <DiceLookButton /> : null}
                {mine && realDiceAllowed && myMember ? (
                  <>
                    <RealDiceToggle campaignId={sheet.campaignId} member={myMember} />
                    <DiceSourcesButton />
                  </>
                ) : null}
                {/* An ally taken over before it was ever saved has no row yet
                    but keeps its brief; its first save links or files one
                    (sheet/sync). */}
                {mine && (sheet.libraryCharacterId || (!sheet.isCompanion && sheet.personality.trim())) ? (
                  <SaveToLibraryButton campaignId={sheet.campaignId} sheetId={sheet.id} />
                ) : null}
                {sheet.isCompanion && steersStory && sheet.companionKind !== "guest" && !sheet.summon ? (
                  <SaveToLibraryButton campaignId={sheet.campaignId} sheetId={sheet.id} companion />
                ) : null}
              </div>
            ) : null}

          </div>
        );
      })}

      {campaignId && companionsAvailable && steersStory ? (
        <div className="reveal space-y-1.5">
          {humanDmTable ? null : <RequestCompanionButton campaignId={campaignId} />}
          {companionBuildAvailable ? (
            <KitButton tone="secondary" onClick={() => setBuildingCompanion(true)} title="Build a companion yourself with the character creator" className="w-full">
              <UserPlus className="size-3.5" />
              Build a companion
            </KitButton>
          ) : null}
        </div>
      ) : null}

      {/* Who walks first (issue 230): every seat sees it; the lead arranges. */}
      {campaignId ? (
        <TravelFormation
          campaignId={campaignId}
          sheets={fieldedOf(sheets, multiCharacter, (userId) => members.find((member) => member.userId === userId)?.activeCharacterId)}
          party={party}
          meUserId={meUserId}
          arranges={arrangesFormation}
        />
      ) : null}

      {/* The shared pack, the animals that carry it and the town boxes. */}
      {campaignId ? (
        <PartyPackPanel
          campaignId={campaignId}
          party={party}
          sheets={sheets}
          meUserId={meUserId}
          steersStory={steersStory}
          decides={arrangesFormation || steersStory}
          here={here}
          inCombat={inCombat}
        />
      ) : null}

      {buildingCompanion && campaignId ? (
        <CompanionBuilderDialog
          campaignId={campaignId}
          genre={companionGenre}
          level={companionLevel}
          humanDm={humanDmTable}
          onClose={() => setBuildingCompanion(false)}
        />
      ) : null}

      {levelingCompanion && campaignId ? (
        <Suspense fallback={null}>
          <LevelUpDialog
            campaignId={campaignId}
            sheet={levelingCompanion}
            companion
            multiclassAllowed={multiclassAllowed}
            hpMethod={hpMethod}
            onDone={() => setLevelingCompanionId("")}
          />
        </Suspense>
      ) : null}

      {editingSheet ? (
        <LeadEditDialog
          campaignId={editingSheet.campaignId}
          sheet={editingSheet}
          onClose={() => setEditingSheetId("")}
        />
      ) : null}

      {viewingSheet ? (
        <CharacterSheetDialog
          sheet={viewingSheet}
          mine={viewingSheet.userId === meUserId}
          steersStory={steersStory}
          // Who corrects a counter: whoever runs the story (the DM, or the
          // lead of an AI table) and the party lead at any table.
          corrects={Boolean(steersStory) || meUserId === leadUserId}
          encumbranceRule={encumbranceRule}
          inCombat={inCombat}
          myTurn={encounter?.acting?.id === viewingSheet.id}
          names={conditionNames}
          portraitFallback={packArt.characterUrl({ race: viewingSheet.race, class: viewingSheet.class })}
          onAdjust={() => {
            // Close the sheet dialog fully before mounting the edit dialog;
            // swapping two modals in one commit can strand the body scroll
            // lock (same family of bug as the dropdown race above).
            const sheetId = viewingSheet.id;
            setViewingSheetId("");
            setTimeout(() => setEditingSheetId(sheetId), 0);
          }}
          onClose={() => setViewingSheetId("")}
        />
      ) : null}

      {croppingSheet ? (
        <Suspense fallback={null}>
          <AvatarCropDialog
            title={`${croppingSheet.name}'s portrait`}
            onUploaded={(image) => setPortrait(croppingSheet, image.url)}
            onClose={() => setCroppingSheetId("")}
          />
        </Suspense>
      ) : null}

      {tradingWith && mySheet ? (
        <TradeDialog campaignId={campaignId} me={mySheet} them={tradingWith} onClose={() => setTradingWithId("")} />
      ) : null}
      {notesSheet && refreshNotes ? (
        <CharacterNotesDialog
          campaignId={notesSheet.campaignId}
          sheet={notesSheet}
          notes={notes}
          members={members}
          meUserId={meUserId}
          steersStory={steersStory}
          refreshNotes={refreshNotes}
          onClose={() => setNotesSheetId("")}
        />
      ) : null}
    </Wrapper>
  );
}

// A torch burning down: a sliver of ember that shortens as the clock moves,
// and reddens when the last quarter hour is on it.
function LightBar({ light }: { light: { remaining: number; total: number } }) {
  const fraction = light.total > 0 ? Math.max(0, Math.min(1, light.remaining / light.total)) : 0;
  const low = light.remaining <= 15;
  return (
    <span
      title={`Light: ${light.remaining} minutes left`}
      aria-label={`Light: ${light.remaining} minutes left`}
      className="flex h-1.5 w-8 shrink-0 items-center overflow-hidden rounded-full border border-amber-900/60 bg-stone-900"
    >
      <span
        className={cn("h-full rounded-full transition-[width] duration-700 ease-out", low ? "bg-red-400 animate-pulse" : "bg-amber-400")}
        style={{ width: `${Math.round(fraction * 100)}%` }}
      />
    </span>
  );
}
