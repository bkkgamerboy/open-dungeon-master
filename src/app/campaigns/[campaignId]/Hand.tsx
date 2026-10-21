"use client";

import { selectedCharacter, initiativeCharacter } from "@/lib/player-characters";

import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, Dispatch, RefObject, SetStateAction } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import { askConcentrationSwap, isConcentrationQuestion } from "@/components/concentration-prompt";
import type { ConcentrationSwap } from "@/lib/dm/concentration-confirm-logic";
import { HandAimBar, type HandTargetChip } from "@/app/campaigns/[campaignId]/HandAimBar";
import { HandCardFace, HandPlayedCard } from "@/app/campaigns/[campaignId]/HandCardFace";
import { HandArrange } from "@/app/campaigns/[campaignId]/HandArrange";
import { HandMoreSheet } from "@/app/campaigns/[campaignId]/HandMoreSheet";
import { useHandLayout } from "@/app/campaigns/[campaignId]/useHandLayout";
import { HAND_TUTORIAL_ID, HandTutorial } from "@/app/campaigns/[campaignId]/HandTutorial";
import { useHandSpells } from "@/app/campaigns/[campaignId]/HandSpells";
import { HandReactPrompt } from "@/app/campaigns/[campaignId]/HandReactPrompt";
import { HandPips } from "@/app/campaigns/[campaignId]/HandPips";
import { handTargets } from "@/app/campaigns/[campaignId]/handTargets";
import { holdPendingCards, useHandChoices, useHandPending } from "@/app/campaigns/[campaignId]/useHandChoices";
import { SKIP_TURN_ID, deriveHand, skipTurnCard, waitingHand, type HandCard } from "@/lib/battlemap/hand";
import { arrangeHand, isUrgentCard, seatPicked, startingLayout } from "@/lib/battlemap/hand-layout";
import {
  COMPOSER_SENT_EVENT,
  HAND_TARGET_EVENT,
  composeSentence,
  intentBody,
  previewRows,
  targetFromComposedText,
  type HandTargetDetail,
} from "@/lib/battlemap/hand-play";
import { reactionAim, reactionCards, withReactions } from "@/lib/battlemap/hand-react";
import { turnFromEncounter, turnPips, turnSignature } from "@/lib/battlemap/hand-table";

import type { TargetEdge } from "@/lib/battlemap/view-tactics";
import { replayAnimation } from "@/lib/motion/replay";
import { finishTour, useTourFinished } from "@/lib/tours/tour-store";
import type { InputKind } from "@/lib/campaign-types";
import type { Floor } from "@/lib/db/campaigns";
import type { PublicEncounter } from "@/lib/db/encounter-view";
import type { CharacterSheet } from "@/lib/schemas/sheet";

// The Hand: on your turn in a fight, your options as cards above the message
// box (docs/visual-overhaul-plan.md 5.2, 5.3, 5.7). It adds to the composer
// and replaces nothing: every card ends as the same POST the box makes, and
// the box is always there to type in instead.

const COLLAPSED_KEY = "odm:hand-collapsed";
// Set when the hand put itself away after a card was sent (build 24), so it
// comes back out on this player's next turn; a hand put away by its own
// button stays away until it is opened.
const AUTO_COLLAPSED_KEY = "odm:hand-auto-collapsed";
const STORE_EVENT = "odm-hand-store";
// The committed card's beats, in step with hand.css and hand-motion.css: the
// card has left the fan by LEFT_MS, and its face-up copy has played, waited
// out the die and spent itself by PLAYED_MS. FOLD_MS is the fan folding away.
const LEFT_MS = 420;
const PLAYED_MS = 1240;
const FOLD_MS = 420;

function subscribeStore(callback: () => void) {
  window.addEventListener(STORE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(STORE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Storage can be denied; the choice then lasts as long as the page.
  }
  window.dispatchEvent(new Event(STORE_EVENT));
}

function HandInner({
  campaignId,
  sheets,
  meUserId,
  activeSheetId,
  encounter,
  floor,
  inputBlocked,
  blockedReason,
  input,
  setInput,
  onKindChange,
  composerRef,
  trackAmmo,
  leaving,
  edges,
  steersStory = false,
}: {
  campaignId: string;
  sheets: CharacterSheet[];
  meUserId: string;
  activeSheetId?: string;
  encounter: PublicEncounter;
  floor: Floor;
  inputBlocked: boolean;
  blockedReason: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  onKindChange: (kind: InputKind) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  // The table's ammunition variant rule: on, an empty quiver stops the card.
  trackAmmo?: boolean;
  // The fight is over and the mount is about to go: the fan folds away (FOLD_MS).
  leaving?: boolean;
  // The board's verdict from this character to each enemy (cover, flanking),
  // keyed by enemy id; absent off the map.
  edges?: Record<string, TargetEdge>;
  // Whoever runs the story: their hand holds Skip turn on others' turns.
  steersStory?: boolean;
}) {
  const sheet = useMemo(
    () => initiativeCharacter(sheets, meUserId, encounter.acting?.id) ?? selectedCharacter(sheets, meUserId, activeSheetId),
    [sheets, meUserId, activeSheetId, encounter.acting?.id],
  );
  const floorTurn = floor.mode === "initiative" ? floor.userIds.includes(meUserId) : !inputBlocked;
  const floorName = floor.mode === "initiative" ? floor.currentName : undefined;

  // The engine's count, and nothing else: the Hand keeps no ledger of its own
  // (src/lib/battlemap/hand-table.ts).
  const turn = useMemo(
    () => (sheet ? turnFromEncounter(encounter, sheet, { myTurn: floorTurn, currentName: floorName }) : null),
    [encounter, sheet, floorTurn, floorName],
  );
  const myTurn = turn?.myTurn ?? floorTurn;
  const currentName = turn?.currentName ?? floorName;
  const signature = turn ? turnSignature(turn) : "";

  const spells = useHandSpells(sheet);
  // A card sent and not yet resolved holds the cards of its cost (useHandChoices.ts).
  const { waiting, setPending } = useHandPending(signature);

  const hits = encounter.lastHits;
  const reactions = useMemo(
    () => (sheet && turn ? reactionCards(sheet, turn, hits ?? [], sheets) : []),
    [sheet, turn, hits, sheets],
  );
  // The lead skips a turn under way from the hand now the round banner is
  // gone (build 24): only on somebody else's turn, since their own ends with
  // the End button beside the pips.
  const skips = steersStory && floor.mode === "initiative" && !myTurn;
  const cards = useMemo(() => {
    if (!sheet || !turn) return [];
    const dealt = holdPendingCards(withReactions(reactions, deriveHand(sheet, turn, { spells, trackAmmo })), waiting);
    return skips ? [...dealt, skipTurnCard(currentName ?? "")] : dealt;
  }, [sheet, turn, reactions, spells, trackAmmo, waiting, skips, currentName]);

  // Where each card sits, the fan or "more": the player's own arrangement
  // for this character when they have made one (issue 231).
  const { layout, save: saveLayout } = useHandLayout(campaignId, sheet);
  const arrangement = useMemo(() => arrangeHand(cards, layout), [cards, layout]);
  const [arranging, setArranging] = useState(false);

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [riderIds, setRiderIds] = useState<string[]>([]);
  const [played, setPlayed] = useState<{ card: HandCard; seq: number } | null>(null);
  const playedTimer = useRef<number | undefined>(undefined);
  const [folding, setFolding] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  // A card's sentence went to the message box to be finished there: when the
  // box sends it, the hand puts itself away as it does after a card is sent.
  const composedRef = useRef(false);
  const [notice, setNotice] = useState("");
  const noticeRef = useRef<HTMLParagraphElement>(null);

  const collapsed = useSyncExternalStore(subscribeStore, () => readFlag(COLLAPSED_KEY), () => false);
  // Once per account, like the tours (issue #306): only a definite "not
  // finished" from the account shows it unasked.
  const tutorialFinished = useTourFinished(HAND_TUTORIAL_ID);
  const [tutorialAsked, setTutorialAsked] = useState(false);
  const showTutorial = !collapsed && (tutorialAsked || (tutorialFinished === false && myTurn));

  // A card that stopped being playable (the turn moved on) drops out of aim.
  const picked = cards.find((card) => card.id === pickedId && !card.disabled) ?? null;
  const riders = useMemo(
    () => cards.filter((card) => riderIds.includes(card.id) && !card.disabled),
    [cards, riderIds],
  );

  const targets = useMemo<HandTargetChip[]>(
    () => handTargets(encounter.enemies, sheets, sheet?.id, edges),
    [encounter.enemies, sheets, sheet?.id, edges],
  );
  const enemyTargets = useMemo(() => targets.filter((target) => target.kind === "enemy"), [targets]);
  const partyTargets = useMemo(() => targets.filter((target) => target.kind !== "enemy"), [targets]);

  // A tap on the board while a card is raised arrives as the HUD's own
  // sentence in the message box; it is read here rather than stored, so the
  // board needs to know nothing about the Hand.
  const boardName = picked?.target === "enemy" ? targetFromComposedText(input, enemyTargets.map((target) => target.name)) : null;
  // A reaction answers one recorded attack: its target is fixed by it (the
  // attacker for Hellish Rebuke, the ally for Cutting Words), not picked.
  const fixed = picked?.intent.card === "reaction" && sheet ? reactionAim(picked, hits ?? [], sheet.id, sheets) : null;
  const fixedChip = fixed ? targets.find((target) => target.id === fixed.id) ?? { ...fixed, note: "" } : null;
  const offered = fixedChip
    ? [fixedChip]
    : picked?.target === "enemy"
      ? enemyTargets
      : picked?.target === "ally"
        ? partyTargets
        : [];
  const self = partyTargets.find((target) => target.kind === "self") ?? null;
  const aim =
    picked?.target === "self"
      ? self
      : fixedChip ??
        (boardName ? offered.find((target) => target.name === boardName) : null) ??
        offered.find((target) => target.id === targetId) ??
        null;
  // What the hover previews are worked against until something is aimed at.
  const defaultAim = aim?.kind === "enemy" ? aim : enemyTargets[0] ?? null;
  const conditions = sheet?.conditions ?? EMPTY;

  const attachedRiders = picked?.intent.card === "attack" && !picked.intent.offHand ? riders : EMPTY_CARDS;
  // The options, trigger, choice and area the card carries; the board hears
  // of the raised card from here too (useHandChoices.ts).
  const { choices, resetChoices, barProps } = useHandChoices(picked);
  const sentence = picked ? composeSentence(picked, aim, attachedRiders, choices) : "";
  const rows = useMemo(
    () => (picked ? previewRows(picked, aim ?? (picked.target === "enemy" ? defaultAim : null), conditions, choices) : []),
    [picked, aim, defaultAim, conditions, choices],
  );

  const clearAim = useCallback(() => {
    setPickedId(null);
    setTargetId(null);
    resetChoices();
  }, [resetChoices]);

  useEffect(() => {
    const onTarget = (event: Event) => {
      const detail = (event as CustomEvent<HandTargetDetail>).detail ?? {};
      const found = targets.find((target) => target.id === detail.id || target.name === detail.name);
      if (found) setTargetId(found.id);
    };
    window.addEventListener(HAND_TARGET_EVENT, onTarget);
    return () => window.removeEventListener(HAND_TARGET_EVENT, onTarget);
  }, [targets]);

  const say = useCallback((text: string) => {
    setNotice(text);
    replayAnimation(noticeRef.current, "shake-x var(--dur-beat) var(--ease-snap) both");
  }, []);

  const pick = useCallback(
    (card: HandCard) => {
      if (card.disabled) {
        say(card.disabled);
        return;
      }
      setNotice("");
      setMoreOpen(false);
      if (card.type === "rider") {
        setRiderIds((current) => (current.includes(card.id) ? current.filter((id) => id !== card.id) : [...current, card.id]));
        return;
      }
      setTargetId(null);
      resetChoices();
      setPickedId((current) => (current === card.id ? null : card.id));
    },
    [say, resetChoices],
  );

  const toComposer = useCallback(
    (text: string) => {
      onKindChange("do");
      setInput(text);
      composedRef.current = true;
      clearAim();
      // After the box has the text, put the caret where the blank is.
      window.setTimeout(() => {
        const area = composerRef.current;
        if (!area) return;
        area.focus();
        const gap = text.indexOf("  ");
        const at = gap >= 0 ? gap + 1 : text.length;
        area.setSelectionRange(at, at);
      }, 50);
    },
    [onKindChange, setInput, clearAim, composerRef],
  );

  // After a card is sent the hand puts itself away so the DM's answer can be
  // read (build 24): once the played card has had its beat, the fan folds as
  // it does for the chevron, and the turn's pips and End stay in view. It
  // comes back out on this player's next turn.
  const putAway = useCallback(() => {
    composedRef.current = false;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const close = () => {
      writeFlag(AUTO_COLLAPSED_KEY, true);
      writeFlag(COLLAPSED_KEY, true);
      setFolding(false);
    };
    if (still) {
      close();
      return;
    }
    setFolding(true);
    window.setTimeout(close, FOLD_MS);
  }, []);

  // The sentence a card left in the message box, sent from there.
  useEffect(() => {
    const onSent = () => {
      if (composedRef.current) putAway();
    };
    window.addEventListener(COMPOSER_SENT_EVENT, onSent);
    return () => window.removeEventListener(COMPOSER_SENT_EVENT, onSent);
  }, [putAway]);

  // A new turn in the order (round and seat) that is this player's: a hand
  // that put itself away comes back out. One its player put away stays so.
  const turnKey = `${encounter.round}:${encounter.turnIndex}`;
  const lastTurnKey = useRef("");
  useEffect(() => {
    if (turnKey === lastTurnKey.current) return;
    lastTurnKey.current = turnKey;
    composedRef.current = false;
    if (myTurn && readFlag(AUTO_COLLAPSED_KEY)) {
      writeFlag(AUTO_COLLAPSED_KEY, false);
      writeFlag(COLLAPSED_KEY, false);
    }
  }, [turnKey, myTurn]);

  // The one-tap End beside the pips: the end-turn route the card used.
  const endTurn = useCallback(async () => {
    if (ending) return;
    setEnding(true);
    setNotice("");
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/encounter/end-turn`, { method: "POST" });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        say(data.error || "The turn could not be ended.");
      } else {
        clearAim();
      }
    } catch {
      say("Could not reach the server.");
    } finally {
      setEnding(false);
    }
  }, [ending, campaignId, say, clearAim]);

  const commit = useCallback(async () => {
    if (!picked || !sheet || sending) return;
    if (picked.compose) {
      toComposer(sentence);
      return;
    }
    setSending(true);
    setNotice("");
    try {
      const skipping = picked.id === SKIP_TURN_ID;
      // Skip turn is the lead's floor route, as the Lead panel's is;
      // everything else is the composer's POST with the card riding along as
      // an optional field.
      const post = (concentrationAck?: ConcentrationSwap) =>
        skipping
          ? fetch(`/api/campaigns/${campaignId}/floor`, { method: "POST" })
          : fetch(`/api/campaigns/${campaignId}/actions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: sentence,
                kind: "do",
                characterId: sheet?.id,
                intent: intentBody(picked, aim, attachedRiders, choices),
                ...(concentrationAck ? { concentrationAck } : {}),
              }),
            });
      let response = await post();
      if (!response.ok) {
        // The engine's own reason (the actions route asks canAct and the
        // cast guard before anything is posted); the card stays playable.
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        // A cast that ends the spell held now is asked about first (issue
        // 252); a no keeps it, spending nothing.
        if (isConcentrationQuestion(response.status, data)) {
          const ack = await askConcentrationSwap(data);
          if (!ack) {
            say(`Kept ${(data as { confirmConcentration?: { current?: string } }).confirmConcentration?.current ?? "your spell"}; nothing was spent.`);
            return;
          }
          response = await post(ack);
          if (!response.ok) {
            const again = (await response.json().catch(() => ({}))) as { error?: string };
            say(again.error || "Could not send your action.");
            return;
          }
        } else {
          say(data.error || "Could not send your action.");
          return;
        }
      }
      // Nothing is marked spent: the engine's count arrives with the
      // encounter. Until it moves, the same cost waits on this card.
      if (!skipping) {
        setPending({
          cost: picked.cost,
          attack: picked.intent.card === "attack" || picked.intent.card === "rider",
          name: picked.name,
          signature,
        });
      }
      setPlayed((current) => ({ card: picked, seq: (current?.seq ?? 0) + 1 }));
      setRiderIds([]);
      // The board's sentence has done its work as the pick; it is not sent twice.
      if (boardName) setInput("");
      window.setTimeout(clearAim, LEFT_MS);
      // A second card played inside the first one's beat takes the stage over.
      window.clearTimeout(playedTimer.current);
      playedTimer.current = window.setTimeout(() => {
        setPlayed(null);
        // Skipping somebody else's turn leaves the hand where it was.
        if (!skipping) putAway();
      }, PLAYED_MS);
    } catch {
      say("Could not reach the server.");
    } finally {
      setSending(false);
    }
  }, [picked, sheet, sending, sentence, campaignId, aim, attachedRiders, choices, signature, setPending, boardName, setInput, clearAim, say, toComposer, putAway]);

  if (!sheet || !turn) return null;

  // Off this character's turn (or while initiative is rolled) the whole
  // hand is held for one reason, the engine's own. The header already says
  // to look the cards over, so a card held only by that stays readable
  // (issue 96): its preview still opens, and the reason is said once.
  const waitingOn = waitingHand(sheet, turn);
  const isWaiting = (card: HandCard) => card.disabled !== null && Boolean(waitingOn?.sentences.has(card.disabled));

  const { fan, more, displaced, fresh } = arrangement;
  const urgent = fan.filter(isUrgentCard);
  // A card chosen from behind the spine takes a seat for the moment: a free
  // one, else the last. The arrangement is not changed by it.
  const shown = seatPicked(fan, picked && more.includes(picked) ? picked : null);
  const middle = (shown.length - 1) / 2;
  // The mockup's 4.4 degrees between neighbours, eased off as the hand fills
  // so nine cards lean no further than five did.
  const step = shown.length > 1 ? Math.min(4.4, 13 / (shown.length - 1)) : 0;
  // The engine's count, the same one the cards read.
  const pips = turnPips(turn);

  return (
    <section
      className="hand"
      data-tour="battle-hand"
      data-tutorial={showTutorial ? "true" : undefined}
      aria-label="Your hand"
      onKeyDown={(event) => {
        if (event.key === "Escape" && picked) {
          event.stopPropagation();
          clearAim();
        }
      }}
    >
      {/* The label keeps its whole words: on a phone the pips wrap under it
          rather than squeeze it to "YOUR HAN...". */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          key={myTurn ? "mine" : (currentName ?? "other")}
          className="hand-label min-w-0 break-words font-display text-[11px] uppercase tracking-[0.22em] text-amber-200/90"
        >
          {myTurn ? "Your hand" : `${currentName ?? "Another hero"}'s turn`}
        </span>
        <span className="hidden text-[11px] text-stone-500 sm:inline">
          {myTurn ? "Play a card, or type your move below." : "Look your cards over while you wait."}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <HandPips pips={pips} flurryStrikes={turn.flurryStrikes} />
          {/* End your turn in one tap, beside what the turn has left (build
              24): End turn was a card, which took a seat and a second tap. */}
          {myTurn ? (
            <Tooltip content="Done with your action, movement and bonus action? End your turn.">
              <button
                type="button"
                onClick={() => void endTurn()}
                disabled={ending}
                aria-busy={ending || undefined}
                className="hand-end motion-press rounded-full border border-amber-500/60 bg-amber-500/15 px-2.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
              >
                End
              </button>
            </Tooltip>
          ) : null}
          <Tooltip content="Customize your hand: choose which cards stay in it">
            <button
              type="button"
              onClick={() => {
                if (collapsed) writeFlag(COLLAPSED_KEY, false);
                clearAim();
                setArranging(true);
                setMoreOpen(true);
              }}
              aria-label="Customize your hand"
              className="flex size-9 items-center justify-center rounded-lg text-stone-500 hover:text-amber-200 sm:size-7"
            >
              <SlidersHorizontal className="size-4" />
            </button>
          </Tooltip>
          <Tooltip content={collapsed ? "Show your hand" : "Put your hand away. The message box stays."}>
            <button
              type="button"
              onClick={() => {
                clearAim();
                // Opened or put away by hand: the player's choice from here.
                writeFlag(AUTO_COLLAPSED_KEY, false);
                const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                if (collapsed || still) {
                  writeFlag(COLLAPSED_KEY, !collapsed);
                  return;
                }
                if (folding) return;
                // The fan folds away first; the flag follows once it has.
                setFolding(true);
                window.setTimeout(() => {
                  writeFlag(COLLAPSED_KEY, true);
                  setFolding(false);
                }, FOLD_MS);
              }}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Show your hand" : "Hide your hand"}
              className="flex size-9 items-center justify-center rounded-lg text-stone-500 hover:text-amber-200 sm:size-7"
            >
              <ChevronDown className={cn("chevron-turn size-4", collapsed && "rotate-180")} />
            </button>
          </Tooltip>
        </span>
      </div>

      {showTutorial ? (
        <HandTutorial
          onDismiss={(how) => {
            finishTour(HAND_TUTORIAL_ID, how);
            setTutorialAsked(false);
          }}
        />
      ) : null}

      {/* A reaction the moment offers (an attack just hit you or an ally):
          above the fan, even while the hand is put away, because it is gone
          once the turn moves on. */}
      <HandReactPrompt
        cards={reactions}
        pickedId={picked?.id ?? null}
        onPick={(card) => {
          // The aim bar that sends it lives in the fan's space: a put-away
          // hand comes back out for it.
          if (collapsed) writeFlag(COLLAPSED_KEY, false);
          pick(card);
        }}
      />

      {collapsed ? null : (
        <>
          <div
            className="hand-fan"
            data-aiming={picked ? "true" : undefined}
            data-more={more.length ? "true" : undefined}
            data-folding={folding || leaving ? "true" : undefined}
            role="group"
            aria-label="Cards"
          >
            {shown.map((card, index) => (
              <HandCardFace
                key={card.id}
                card={card}
                index={index}
                offset={index - middle}
                step={step}
                picked={picked?.id === card.id}
                attached={riderIds.includes(card.id)}
                played={played?.card.id === card.id}
                aim={card.intent.card === "reaction" ? null : defaultAim}
                conditions={conditions}
                waiting={isWaiting(card)}
                onPick={pick}
              />
            ))}
            {more.length ? (
              <button
                type="button"
                className="hand-more"
                style={{ "--i": shown.length } as CSSProperties}
                onClick={() => setMoreOpen(true)}
                aria-label={`${more.length} more cards`}
              >
                +{more.length} more
              </button>
            ) : null}
          </div>
          {played ? <HandPlayedCard key={played.seq} card={played.card} /> : null}
          {picked ? (
            <HandAimBar
              card={picked}
              targets={offered}
              aim={aim}
              onAim={(target) => {
                setTargetId(target.id);
                // A chip outranks a tap made on the board earlier, whose
                // sentence is still in the box; it goes so the chip can win.
                if (boardName) setInput("");
              }}
              riders={attachedRiders}
              onDropRider={(rider) => setRiderIds((current) => current.filter((id) => id !== rider.id))}
              rows={rows}
              sentence={sentence}
              sending={sending}
              {...barProps}
              onRefused={say}
              // A reaction is taken on anyone's turn: the initiative floor
              // does not hold it (the engine's canAct judges it instead).
              // Nor does it hold the lead's Skip turn, made for others' turns.
              blocked={inputBlocked && picked.cost !== "reaction" && picked.id !== SKIP_TURN_ID ? blockedReason : null}
              onBack={clearAim}
              onEdit={() => toComposer(sentence)}
              onCommit={() => void commit()}
            />
          ) : riders.length ? (
            <p className="mt-1 animate-fade-up text-xs text-amber-200/80">
              {riders.map((rider) => rider.name).join(", ")} will ride your next attack card. Press it again to take it off.
            </p>
          ) : null}
        </>
      )}
      <p ref={noticeRef} role="status" className={cn("mt-1 text-xs text-amber-300", notice ? "" : "hidden")}>
        {notice}
      </p>
      <HandMoreSheet
        open={moreOpen}
        onOpenChange={(open) => {
          setMoreOpen(open);
          if (!open) setArranging(false);
        }}
        arranging={arranging}
        onArrange={setArranging}
        displaced={displaced}
        urgent={urgent}
        fresh={fresh}
        arrange={
          arranging ? (
            <HandArrange
              cards={cards}
              working={startingLayout(cards, layout)}
              arranged={arrangement.arranged}
              urgent={urgent}
              displaced={displaced}
              fresh={fresh}
              onChange={saveLayout}
              onReset={() => saveLayout(null)}
              onDone={() => {
                setArranging(false);
                if (!more.length) setMoreOpen(false);
              }}
              // "How the hand works" lives here now, off the pips' row.
              onHelp={() => {
                setArranging(false);
                setMoreOpen(false);
                if (collapsed) writeFlag(COLLAPSED_KEY, false);
                writeFlag(AUTO_COLLAPSED_KEY, false);
                setTutorialAsked(true);
              }}
            />
          ) : null
        }
        cards={more}
        onPick={pick}
        waitingNote={waitingOn?.note ?? null}
        isWaiting={isWaiting}
        aim={defaultAim}
        conditions={conditions}
      />
    </section>
  );
}

const EMPTY: string[] = [];
const EMPTY_CARDS: HandCard[] = [];

// Memoized like the composer it sits in: unchanged props while the DM streams.
export const Hand = memo(HandInner);
