"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { TokenFace, type FaceLookup, type TurnHudBudget } from "@/app/campaigns/[campaignId]/BoardChrome";
import type { HudAction } from "@/app/campaigns/[campaignId]/TokenHud";
import type { PublicEncounter } from "@/lib/db/encounter-view";

// The compact board's own chrome (a phone held upright, useCompactBoard.ts).
// On a wider board the turn order, the turn's budget and the actions float
// over the board; on a phone they covered most of it. Here they sit around
// it instead: the order and the budget in two slim rows above, the actions
// in a sheet that slides up under the board when you tap your figure, so
// the board itself carries nothing but the fight.

// The order, one row of faces that scrolls sideways, whoever is up framed
// in gold and kept in view. A tap opens the full order, as the rail does.
export function CompactTurnRow({
  encounter,
  round,
  faceOf,
  onOpen,
}: {
  encounter: PublicEncounter;
  round: number;
  faceOf: FaceLookup;
  onOpen?: () => void;
}) {
  const current = useRef<HTMLLIElement | null>(null);
  const turn = encounter.turnIndex;
  useEffect(() => {
    current.current?.scrollIntoView?.({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [turn]);
  if (!encounter.orderReady || !encounter.order.length) {
    return null;
  }
  return (
    <div className="board-compact-row flex items-center gap-2" data-compact-turns="">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className="board-eyebrow shrink-0 rounded px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        aria-label={`Round ${round}, initiative order. ${encounter.order[turn]?.name ?? ""} is up. Open the order.`}
      >
        Rd {round}
      </button>
      <ol className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-0.5 [scrollbar-width:none]" aria-label="Turn order">
        {encounter.order.map((entry, index) => {
          const up = index === turn;
          return (
            <li
              key={`${entry.id}-${index}`}
              ref={up ? current : undefined}
              title={`${entry.name}${entry.initiative !== undefined ? ` · ${entry.initiative}` : ""}`}
              aria-current={up ? "true" : undefined}
              className={cn(
                "relative size-8 shrink-0 overflow-hidden rounded-full border-2 bg-[#0d0b1c]",
                up
                  ? "border-[#d4ab3a] shadow-[0_0_10px_rgba(212,171,58,0.55)]"
                  : entry.kind === "enemy"
                    ? "border-[rgba(220,38,38,0.6)] opacity-80"
                    : "border-[rgba(74,222,128,0.55)] opacity-80",
              )}
            >
              <TokenFace
                candidates={faceOf(entry)}
                name={entry.name}
                enemy={entry.kind === "enemy"}
                className={cn("absolute inset-0 size-full text-[10px]", entry.hidden && "opacity-50")}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const PIPS: Array<{ key: keyof TurnHudBudget; label: string }> = [
  { key: "action", label: "Action" },
  { key: "bonus", label: "Bonus" },
  { key: "reaction", label: "Reaction" },
];

// Whose turn it is and, on yours, what you have left and the way to end it:
// three dots for the action, the bonus action and the reaction, then feet
// left, armour class and hit points, then End turn.
export function CompactTurnStrip({
  actorName,
  mine,
  budget,
  speedLeftFeet,
  ac,
  hp,
  onEndTurn,
  endingTurn,
}: {
  actorName: string;
  mine: boolean;
  budget?: TurnHudBudget | null;
  speedLeftFeet?: number | null;
  ac?: number | null;
  hp?: { current: number; max: number } | null;
  onEndTurn?: () => void;
  endingTurn?: boolean;
}) {
  if (!actorName) {
    return null;
  }
  const stats = [
    typeof speedLeftFeet === "number" ? `${speedLeftFeet} ft` : null,
    typeof ac === "number" ? `AC ${ac}` : null,
    hp ? `HP ${hp.current}/${hp.max}` : null,
  ].filter(Boolean);
  return (
    <div className="board-compact-strip flex min-h-9 items-center gap-2 rounded-lg border border-[rgba(107,99,148,0.35)] bg-[rgba(13,11,28,0.85)] px-2 py-1">
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-[12px] font-medium", mine ? "text-[#f4e0a6]" : "text-stone-300")}>
          {mine ? `${actorName} · your turn` : `${actorName}'s turn`}
        </p>
        {mine && (budget || stats.length) ? (
          <p className="flex items-center gap-2 font-mono text-[11px] text-stone-300">
            {budget ? (
              <span className="flex items-center gap-1" aria-label={PIPS.map((pip) => `${pip.label} ${budget[pip.key] ? "left" : "spent"}`).join(", ")}>
                {PIPS.map((pip) => (
                  <span
                    key={pip.key}
                    title={`${pip.label} ${budget[pip.key] ? "left" : "spent"}`}
                    className={cn(
                      "size-2.5 rounded-full border transition-colors duration-[420ms] ease-snap",
                      budget[pip.key] ? "border-[#e3c15c] bg-[#d4ab3a]" : "border-[#3a3358] bg-transparent",
                    )}
                  />
                ))}
              </span>
            ) : null}
            <span className="truncate">{stats.join(" · ")}</span>
          </p>
        ) : null}
      </div>
      {mine && onEndTurn ? (
        <button
          type="button"
          onClick={onEndTurn}
          disabled={endingTurn}
          className="motion-press shrink-0 rounded-lg border border-[rgba(212,171,58,0.55)] bg-[rgba(43,32,8,0.7)] px-3 py-1.5 text-[#f9ecc8] disabled:opacity-50"
        >
          <span className="block font-display text-[10px] font-semibold uppercase tracking-[0.16em]">End turn</span>
        </button>
      ) : null}
    </div>
  );
}

// The actions for your figure, sliding up under the board: big buttons in
// two rows, the move mode under them, and while a target is being chosen
// the pick-a-target line and the targets in their place. Every button is
// the same composer action or adjudication the wheel used (TokenHud.tsx).
export function CompactActionSheet({
  name,
  actions,
  aiming,
  onCancelAim,
  onClose,
  children,
}: {
  name: string;
  actions: HudAction[];
  // "Attack" or "Cast" while a target is being chosen.
  aiming?: string | null;
  onCancelAim?: () => void;
  onClose: () => void;
  // The move modes, or the target chips while aiming.
  children?: React.ReactNode;
}) {
  return (
    <section
      className="board-compact-sheet rounded-t-xl border border-b-0 border-[rgba(212,171,58,0.45)] bg-[rgba(13,11,28,0.97)] px-3 pb-3 pt-2 shadow-elev-2"
      aria-label={`Actions for ${name}`}
      data-no-pan=""
    >
      <div className="mx-auto mb-1.5 h-1 w-10 rounded-full bg-[rgba(143,138,171,0.45)]" aria-hidden="true" />
      <div className="mb-2 flex items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate font-display text-[11px] font-semibold uppercase tracking-[0.16em] text-[#f4e0a6]">
          {aiming ? `${aiming} · tap a target` : name}
        </h4>
        {aiming && onCancelAim ? (
          <button
            type="button"
            onClick={onCancelAim}
            className="motion-press rounded-md border border-[rgba(107,99,148,0.5)] px-2 py-0.5 text-[11px] text-[#aeaac6]"
          >
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close actions"
          className="motion-press flex size-7 items-center justify-center rounded-full border border-[rgba(107,99,148,0.6)] text-[#aeaac6]"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {aiming ? null : (
        <div className="grid grid-cols-3 gap-1.5" role="menu" aria-label={`Actions for ${name}`}>
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                title={action.disabled ?? action.label}
                aria-label={action.disabled ? `${action.label}: ${action.disabled}` : action.label}
                aria-disabled={action.disabled ? "true" : undefined}
                onClick={action.onPick}
                className={cn(
                  "motion-press flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg border text-[12px] font-medium",
                  action.disabled
                    ? "border-[rgba(107,99,148,0.3)] text-[#6f6a8c]"
                    : action.tone === "gold"
                      ? "border-[rgba(212,171,58,0.6)] bg-[rgba(43,32,8,0.55)] text-[#ecd287]"
                      : action.tone === "ember"
                        ? "border-[rgba(224,112,58,0.6)] bg-[rgba(60,20,8,0.5)] text-[#ffbe8f]"
                        : "border-[rgba(143,138,171,0.45)] bg-[rgba(21,18,41,0.8)] text-[#dedbec]",
                )}
              >
                <Icon className="size-4" />
                {action.label}
              </button>
            );
          })}
        </div>
      )}
      {children ? <div className={cn(aiming ? "" : "mt-2")}>{children}</div> : null}
    </section>
  );
}
