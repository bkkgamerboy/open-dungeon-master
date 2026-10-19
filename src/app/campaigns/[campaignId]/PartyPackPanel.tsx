"use client";

import { useEffect, useState } from "react";
import { appConfirm } from "@/components/ui/ConfirmDialog";
import { GameIcon } from "@/components/ui/GameIcon";
import { SectionHead } from "@/components/ui/SectionHead";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import {
  PACK_ANIMAL_KINDS,
  MAX_PACK_ANIMALS,
  boxAt,
  packAnimalKind,
  packReach,
  type PackAnimal,
  type PlaceRef,
  type StorageBox,
} from "@/lib/dm/pack-logic";
import type { PartyItem, PartyState } from "@/lib/dm/party-logic";
import type { CharacterSheet } from "@/lib/schemas/sheet";
import { formatCopper } from "@/lib/srd/currency";
import { loadLine } from "@/lib/srd/encumbrance";
import { ui } from "@/lib/ui";
import { KitButton } from "./PanelKit";

// The Party tab's Pack section: the shared pack and the common purse, the
// pack animals that carry the pack, and the storage boxes rented in towns
// (src/lib/dm/pack-logic.ts for the rules, /party/pack for the moves).
//
// A player moves things in and out of their own characters' hands; the
// party lead (or whoever runs the story) makes the party's decisions and
// moves things for the companions. Every move is a table note the DM reads.

type Hand = { id: string; name: string; equipment: CharacterSheet["equipment"]; gold: number; copper: number };

function eachLb(item: { name: string; weight?: number }): number | null {
  return loadLine({ name: item.name, qty: 1, weight: item.weight }).eachLb;
}

function weightOf(items: PartyItem[]): { lb: number; unknown: number } {
  let lb = 0;
  let unknown = 0;
  for (const item of items) {
    const each = eachLb(item);
    if (each === null) unknown += 1;
    else lb += each * item.qty;
  }
  return { lb: Math.round(lb * 10) / 10, unknown };
}

function itemLabel(item: { name: string; qty: number; charges?: number }): string {
  return `${item.name}${item.qty > 1 ? ` ×${item.qty}` : ""}${typeof item.charges === "number" ? ` (${item.charges} charges)` : ""}`;
}

function glyphFor(animal: PackAnimal): string {
  const slug = packAnimalKind(animal.kind)?.slug ?? "";
  return slug === "draft-horse" ? "mount-draft-horse" : slug === "camel" ? "mount-camel" : "mount-pony";
}

// Gold typed by a person ("12.5") as copper.
function copperFrom(text: string): number {
  const value = Number(text.replace(",", "."));
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
}

export function PartyPackPanel({
  campaignId,
  party,
  sheets,
  meUserId,
  steersStory,
  decides,
  here,
  inCombat,
}: {
  campaignId: string;
  party: PartyState | undefined;
  sheets: CharacterSheet[];
  meUserId: string;
  steersStory: boolean;
  // The party lead, or whoever runs the story: buys, leaves and rents.
  decides: boolean;
  here: PlaceRef | null;
  inCombat: boolean;
}) {
  const [busy, setBusy] = useState(false);
  // The last answer, with a count so the same refusal twice still replays
  // its entrance (the line is keyed on it).
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "error"; seq: number } | null>(null);
  // Whether the place the party stands has a market, keyed by the place it
  // was asked of, so a move reads as "no market" until the answer lands.
  const [marketFor, setMarketFor] = useState<{ placeId: string; market: boolean }>({ placeId: "", market: false });
  const [open, setOpen] = useState<"" | "stow" | "purse" | "buy" | "boxPut" | "boxCoins">("");
  // The form fields, shared by whichever form is open.
  const [who, setWho] = useState("");
  const [item, setItem] = useState("");
  const [qty, setQty] = useState("1");
  const [gold, setGold] = useState("");
  const [kind, setKind] = useState("mule");
  const [animalName, setAnimalName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [takingFor, setTakingFor] = useState<{ from: "pack" | "box"; name: string; qty: string } | null>(null);

  const hereId = here?.id ?? "";
  const hereName = here?.name ?? "";
  // A town, for buying and renting, is a place with a market, as the Market
  // tab decides it.
  useEffect(() => {
    let live = true;
    if (!campaignId || !hereId) {
      return;
    }
    fetch(`/api/campaigns/${campaignId}/shops`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        // Whoever runs the story reads every shop in the campaign, so the
        // ones here are picked the way the server picks them (listShopsAt).
        const shops: Array<{ locationId?: string; locationName?: string }> = Array.isArray(data?.shops) ? data.shops : [];
        const name = (hereName ?? "").toLowerCase();
        const at = shops.filter(
          (shop) => (shop.locationId ? shop.locationId === hereId : (shop.locationName ?? "").toLowerCase() === name),
        );
        if (live) setMarketFor({ placeId: hereId, market: at.length > 0 });
      })
      .catch(() => {
        if (live) setMarketFor({ placeId: hereId, market: false });
      });
    return () => {
      live = false;
    };
  }, [campaignId, hereId, hereName]);

  if (!party) {
    return null;
  }
  const market = Boolean(hereId) && marketFor.placeId === hereId && marketFor.market;

  const hands: Hand[] = sheets
    .filter(
      (sheet) =>
        (!sheet.isCompanion && sheet.userId === meUserId) ||
        (steersStory && sheet.isCompanion && sheet.companionKind !== "guest" && !sheet.summon),
    )
    .map((sheet) => ({ id: sheet.id, name: sheet.name, equipment: sheet.equipment, gold: sheet.gold, copper: sheet.copper }));
  const reach = packReach(party.packAnimals, party.animalsLeftAt, hereId || null);
  const load = weightOf(party.inventory);
  const boxHere: StorageBox | null = hereId ? boxAt(party.storage, hereId) : null;
  const otherBoxes = party.storage.filter((box) => box.place.id !== hereId);
  const firstHand = hands[0]?.id ?? "";
  const handOf = (id: string) => hands.find((hand) => hand.id === id) ?? null;
  const looseGear = (id: string) => (handOf(id)?.equipment ?? []).filter((row) => !row.equipped && !row.attuned);

  const say = (text: string, tone: "ok" | "error") => {
    setNotice((current) => ({ text, tone, seq: (current?.seq ?? 0) + 1 }));
  };

  async function send(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/party/pack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        say(typeof data.error === "string" ? data.error : "That did not work.", "error");
        return false;
      }
      say(typeof data.message === "string" ? data.message : "Done.", "ok");
      return true;
    } catch {
      say("Could not reach the server.", "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const openForm = (form: typeof open) => {
    setOpen(open === form ? "" : form);
    setWho(firstHand);
    setItem("");
    setQty("1");
    setGold("");
    setNotice(null);
  };

  const handOptions = hands.map((hand) => ({ value: hand.id, label: hand.name }));
  const qtyNumber = Math.max(1, Math.min(999, Math.floor(Number(qty) || 1)));

  // Taking an item out: straight to the one pair of hands there is, or ask
  // whose.
  async function take(from: "pack" | "box", name: string, to: string, count: number) {
    const body =
      from === "pack"
        ? to === "box"
          ? { do: "box_put", from: "pack", name, qty: count }
          : { do: "take", characterId: to, name, qty: count }
        : { do: "box_take", to, name, qty: count };
    if (await send(body)) setTakingFor(null);
  }

  const takeTargets = (from: "pack" | "box") => [
    ...hands.map((hand) => ({ value: hand.id, label: `To ${hand.name}` })),
    ...(from === "pack" && boxHere && decides ? [{ value: "box", label: `Into the ${boxHere.place.name} box` }] : []),
    ...(from === "box" && decides && reach.reachable ? [{ value: "pack", label: "Into the shared pack" }] : []),
  ];

  const itemRows = (items: PartyItem[], from: "pack" | "box", canTake: boolean) => (
    <ul className="space-y-1">
      {items.map((entry) => {
        const each = eachLb(entry);
        const asking = takingFor?.from === from && takingFor.name === entry.name;
        const targets = takeTargets(from);
        return (
          <li key={`${entry.name}:${entry.slug ?? ""}:${entry.charges ?? ""}`} className="rounded-lg border border-stone-800 bg-stone-950/40 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-sm text-stone-200">{itemLabel(entry)}</span>
              <span className="shrink-0 font-mono text-[11px] text-stone-500">{each === null ? "? lb" : `${Math.round(each * entry.qty * 10) / 10} lb`}</span>
              {canTake && targets.length ? (
                <KitButton
                  disabled={busy || inCombat}
                  onClick={() => {
                    if (targets.length === 1 && entry.qty === 1) void take(from, entry.name, targets[0].value, 1);
                    else setTakingFor(asking ? null : { from, name: entry.name, qty: String(entry.qty) });
                  }}
                >
                  Take
                </KitButton>
              ) : null}
            </div>
            {asking ? (
              <div className="reveal mt-1.5 flex flex-wrap items-center gap-1.5">
                {entry.qty > 1 ? (
                  <label className="flex items-center gap-1 text-xs text-stone-400">
                    How many
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={entry.qty}
                      value={takingFor?.qty ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        setTakingFor((current) => (current ? { ...current, qty: value } : current));
                      }}
                      className={cn(ui.input, "w-16 py-1 text-sm")}
                    />
                  </label>
                ) : null}
                {targets.map((target) => (
                  <KitButton
                    key={target.value}
                    disabled={busy}
                    onClick={() => void take(from, entry.name, target.value, Math.max(1, Math.min(entry.qty, Math.floor(Number(takingFor?.qty) || 1))))}
                  >
                    {target.label}
                  </KitButton>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  // A character, then one of their loose items, then how many.
  const gearPicker = (sources: Array<{ value: string; label: string }>) => {
    const fromPack = who === "pack";
    const gear = fromPack ? party.inventory : looseGear(who);
    const chosen = gear.find((row) => row.name === item);
    return (
      <div className="space-y-1.5">
        <Select<string> size="sm" label="Whose" value={who} onChange={(value) => { setWho(value); setItem(""); }} options={sources} />
        <Select<string>
          size="sm"
          label="Which item"
          placeholder={gear.length ? "Choose an item" : "Nothing loose to move"}
          value={item}
          onChange={setItem}
          disabled={!gear.length}
          options={gear.map((row) => ({ value: row.name, label: itemLabel(row) }))}
        />
        {chosen && chosen.qty > 1 ? (
          <label className="flex items-center gap-2 text-xs text-stone-400">
            How many
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={chosen.qty}
              value={qty}
              onChange={(event) => setQty(event.target.value)}
              className={cn(ui.input, "w-20 py-1 text-sm")}
            />
            <span>of {chosen.qty}</span>
          </label>
        ) : null}
      </div>
    );
  };

  const goldField = (
    <label className="flex items-center gap-2 text-xs text-stone-400">
      Gold
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        value={gold}
        onChange={(event) => setGold(event.target.value)}
        placeholder="10"
        className={cn(ui.input, "w-24 py-1 text-sm")}
      />
      <span className="text-[11px] text-stone-500">0.1 is a silver piece</span>
    </label>
  );

  const herdNames = party.packAnimals.map((animal) => animal.name);
  const herdLeft = party.animalsLeftAt;
  const herdHere = herdLeft && herdLeft.id === hereId;

  return (
    <section className="reveal space-y-3" aria-label="Pack and storage">
      <SectionHead title="Shared pack" glyph="tab-loot" level="h3" aside={`${load.lb}${load.unknown ? "+" : ""} / ${reach.capacityLb} lb`} />
      <p
        key={notice?.seq ?? 0}
        role={notice?.tone === "error" ? "alert" : "status"}
        className={cn("text-xs", notice ? "reveal" : "hidden", notice?.tone === "error" ? "text-red-300" : "text-emerald-300")}
      >
        {notice?.text}
      </p>

      {/* ---- the shared pack ---- */}
      <div className="space-y-2">
        <p className="text-xs text-stone-400">
          {reach.carrier === "hands"
            ? `Carried by hand: up to ${reach.capacityLb} lb. A pack animal carries much more.`
            : herdLeft && !herdHere
              ? `With ${reach.carriedBy} at ${herdLeft.name}: out of reach until you go back.`
              : `Carried by ${reach.carriedBy}: up to ${reach.capacityLb} lb.`}
          {load.lb > reach.capacityLb ? " Over the limit: nothing more goes in until it is lighter." : ""}
        </p>
        {party.inventory.length ? itemRows(party.inventory, "pack", reach.reachable) : <p className="text-xs text-stone-500">Empty.</p>}
        <div className="flex flex-wrap gap-1.5">
          {hands.length && reach.reachable ? (
            <KitButton disabled={inCombat} onClick={() => openForm("stow")}>Put something in</KitButton>
          ) : null}
          {hands.length ? <KitButton disabled={inCombat} onClick={() => openForm("purse")}>Purse</KitButton> : null}
          <span className="inline-flex items-center gap-1 text-xs text-stone-400">
            <GameIcon icon={{ kind: "glyph", key: "coin-purse" }} size="size-5" /> {formatCopper(party.copper)}
          </span>
        </div>
        {open === "stow" ? (
          <div className="reveal space-y-2 rounded-xl border border-amber-500/30 bg-stone-900/60 p-2.5">
            {gearPicker(handOptions)}
            <KitButton tone="primary" disabled={busy || !item} onClick={async () => {
              if (await send({ do: "stow", characterId: who, name: item, qty: qtyNumber })) setOpen("");
            }}>
              Put in the pack
            </KitButton>
          </div>
        ) : null}
        {open === "purse" ? (
          <div className="reveal space-y-2 rounded-xl border border-amber-500/30 bg-stone-900/60 p-2.5">
            <Select<string> size="sm" label="Whose purse" value={who} onChange={setWho} options={handOptions.map((option) => ({ ...option, label: `${option.label} (${formatCopper((handOf(option.value)?.gold ?? 0) * 100 + (handOf(option.value)?.copper ?? 0))})` }))} />
            {goldField}
            <div className="flex flex-wrap gap-1.5">
              <KitButton tone="primary" disabled={busy || !copperFrom(gold)} onClick={async () => {
                if (await send({ do: "deposit", characterId: who, copper: copperFrom(gold) })) setOpen("");
              }}>Put in the common purse</KitButton>
              <KitButton disabled={busy || !copperFrom(gold)} onClick={async () => {
                if (await send({ do: "withdraw", characterId: who, copper: copperFrom(gold) })) setOpen("");
              }}>Take from it</KitButton>
            </div>
          </div>
        ) : null}
      </div>

      {/* ---- pack animals ---- */}
      <SectionHead title="Pack animals" glyph="mount-pony" level="h3" aside={party.packAnimals.length ? `${party.packAnimals.length}` : undefined} />
      <div className="space-y-2">
        {party.packAnimals.length ? (
          <ul className="space-y-1.5">
            {party.packAnimals.map((animal) => {
              const kindName = packAnimalKind(animal.kind)?.name ?? animal.kind;
              const hurt = animal.hp < animal.maxHp;
              return (
                <li key={animal.id} className="flex items-start gap-2 rounded-lg border border-stone-800 bg-stone-950/40 px-2 py-1.5">
                  <GameIcon icon={{ kind: "glyph", key: glyphFor(animal) }} size="size-7" className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    {renaming?.id === animal.id ? (
                      <span className="flex gap-1.5">
                        <input
                          value={renaming.name}
                          maxLength={40}
                          onChange={(event) => setRenaming({ id: animal.id, name: event.target.value })}
                          aria-label={`New name for ${animal.name}`}
                          className={cn(ui.input, "min-w-0 flex-1 py-1 text-sm")}
                        />
                        <KitButton disabled={busy || !renaming.name.trim()} onClick={async () => {
                          if (await send({ do: "rename_animal", animalId: animal.id, name: renaming.name })) setRenaming(null);
                        }}>Save</KitButton>
                      </span>
                    ) : (
                      <p className="text-sm text-stone-100">
                        {animal.name} <span className="text-xs text-stone-500">{kindName}</span>
                      </p>
                    )}
                    <p className={cn("text-[11px]", hurt ? "text-amber-300" : "text-stone-500")}>
                      {animal.hp}/{animal.maxHp} HP · AC {animal.ac} · carries {animal.carry} lb
                    </p>
                  </div>
                  {decides && renaming?.id !== animal.id ? (
                    <span className="flex shrink-0 flex-col gap-1">
                      <KitButton onClick={() => setRenaming({ id: animal.id, name: animal.name })}>Rename</KitButton>
                      {market && !herdLeft ? (
                        <KitButton tone="danger" disabled={busy || inCombat} onClick={async () => {
                          const price = formatCopper(Math.floor((packAnimalKind(animal.kind)?.priceCp ?? 0) / 2));
                          if (await appConfirm(`Sell ${animal.name} for ${price}? It goes into the common purse.`, { title: `Sell ${animal.name}?`, actionLabel: "Sell" })) {
                            void send({ do: "sell_animal", animalId: animal.id });
                          }
                        }}>Sell</KitButton>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-stone-500">None yet. A mule costs 8 gp in a town&rsquo;s market and carries 420 lb.</p>
        )}
        {party.packAnimals.length ? (
          <p className="text-xs text-stone-400">
            {herdLeft
              ? `${herdNames.join(" and ")} ${herdNames.length > 1 ? "wait" : "waits"} at ${herdLeft.name} with the shared pack.`
              : `With the party. Leave ${herdNames.length > 1 ? "them" : "it"} somewhere a beast cannot follow, like a dungeon; the shared pack stays too.`}
          </p>
        ) : null}
        {decides && party.packAnimals.length ? (
          <div className="flex flex-wrap gap-1.5">
            {herdLeft ? (
              <KitButton disabled={busy || inCombat || !herdHere} title={herdHere ? undefined : `Go back to ${herdLeft.name} to fetch them`} onClick={() => void send({ do: "bring_animals" })}>
                {herdHere ? `Bring ${herdNames.length > 1 ? "them" : herdNames[0]} along` : `Waiting at ${herdLeft.name}`}
              </KitButton>
            ) : (
              <KitButton disabled={busy || inCombat || !here} onClick={() => void send({ do: "leave_animals" })}>
                Leave {herdNames.length > 1 ? "them" : herdNames[0]} {here ? `at ${here.name}` : "here"}
              </KitButton>
            )}
          </div>
        ) : null}
        {decides && market && !herdLeft && party.packAnimals.length < MAX_PACK_ANIMALS ? (
          <KitButton disabled={inCombat} onClick={() => { openForm("buy"); setWho("purse"); }}>Buy a pack animal</KitButton>
        ) : null}
        {open === "buy" ? (
          <div className="reveal space-y-2 rounded-xl border border-amber-500/30 bg-stone-900/60 p-2.5">
            <Select<string>
              size="sm"
              label="Which animal"
              value={kind}
              onChange={setKind}
              options={PACK_ANIMAL_KINDS.map((entry) => ({
                value: entry.slug,
                label: `${entry.name} · ${formatCopper(entry.priceCp)} · ${entry.carry} lb`,
                hint: entry.blurb,
              }))}
            />
            <input
              value={animalName}
              maxLength={40}
              onChange={(event) => setAnimalName(event.target.value)}
              placeholder="Name it (Bramble)"
              aria-label="The animal's name"
              className={cn(ui.input, "w-full py-1 text-sm")}
            />
            <Select<string>
              size="sm"
              label="Who pays"
              value={who || "purse"}
              onChange={setWho}
              options={[{ value: "purse", label: `The common purse (${formatCopper(party.copper)})` }, ...handOptions]}
            />
            <KitButton tone="primary" disabled={busy} onClick={async () => {
              if (await send({ do: "buy_animal", kind, name: animalName, payer: who || "purse" })) {
                setOpen("");
                setAnimalName("");
              }
            }}>Buy</KitButton>
          </div>
        ) : null}
      </div>

      {/* ---- storage ---- */}
      <SectionHead title="Storage" glyph="ui-storage" level="h3" aside={party.storage.length ? `${party.storage.length}` : undefined} />
      <div className="space-y-2">
        {boxHere ? (
          <div className="space-y-2 rounded-xl border border-stone-700 bg-stone-900/40 p-2.5">
            <p className="text-sm text-stone-100">
              {boxHere.place.name} <span className="text-xs text-emerald-300">you are here</span>
            </p>
            {boxHere.inventory.length ? itemRows(boxHere.inventory, "box", true) : <p className="text-xs text-stone-500">Nothing stored yet.</p>}
            <p className="text-xs text-stone-400">Coin stored: {formatCopper(boxHere.copper)}</p>
            <div className="flex flex-wrap gap-1.5">
              {hands.length || decides ? <KitButton disabled={inCombat} onClick={() => openForm("boxPut")}>Store something</KitButton> : null}
              {hands.length || decides ? <KitButton disabled={inCombat} onClick={() => { openForm("boxCoins"); if (!hands.length) setWho("purse"); }}>Coin</KitButton> : null}
              {decides && !boxHere.inventory.length && boxHere.copper === 0 ? (
                <KitButton tone="danger" disabled={busy} onClick={() => void send({ do: "give_up_box" })}>Give up this box</KitButton>
              ) : null}
            </div>
            {open === "boxPut" ? (
              <div className="reveal space-y-2 rounded-xl border border-amber-500/30 bg-stone-900/60 p-2.5">
                {gearPicker([...(decides && reach.reachable ? [{ value: "pack", label: "The shared pack" }] : []), ...handOptions])}
                <KitButton tone="primary" disabled={busy || !item} onClick={async () => {
                  if (await send({ do: "box_put", from: who, name: item, qty: qtyNumber })) setOpen("");
                }}>Store it</KitButton>
              </div>
            ) : null}
            {open === "boxCoins" ? (
              <div className="reveal space-y-2 rounded-xl border border-amber-500/30 bg-stone-900/60 p-2.5">
                <Select<string>
                  size="sm"
                  label="Whose purse"
                  value={who}
                  onChange={setWho}
                  options={[...(decides ? [{ value: "purse", label: `The common purse (${formatCopper(party.copper)})` }] : []), ...handOptions]}
                />
                {goldField}
                <div className="flex flex-wrap gap-1.5">
                  <KitButton tone="primary" disabled={busy || !copperFrom(gold) || !who} onClick={async () => {
                    if (await send({ do: "box_coins", direction: "deposit", with: who, copper: copperFrom(gold) })) setOpen("");
                  }}>Store it</KitButton>
                  <KitButton disabled={busy || !copperFrom(gold) || !who} onClick={async () => {
                    if (await send({ do: "box_coins", direction: "withdraw", with: who, copper: copperFrom(gold) })) setOpen("");
                  }}>Take it out</KitButton>
                </div>
              </div>
            ) : null}
          </div>
        ) : decides && market && here ? (
          <KitButton disabled={busy || inCombat} onClick={() => void send({ do: "rent_box" })}>Rent a storage box in {here.name}</KitButton>
        ) : !party.storage.length ? (
          <p className="text-xs text-stone-500">Rent a box in any town with a market; it keeps things safe until you come back.</p>
        ) : null}
        {otherBoxes.map((box) => (
          <div key={box.place.id} className="rounded-lg border border-stone-800 bg-stone-950/30 px-2.5 py-2">
            <p className="text-sm text-stone-300">{box.place.name}</p>
            <p className="text-xs text-stone-500">
              {[...box.inventory.map(itemLabel), ...(box.copper ? [formatCopper(box.copper)] : [])].join(", ") || "Empty"}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
