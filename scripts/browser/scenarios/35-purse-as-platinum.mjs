// Build 29: the purse weighs as platinum, 500 gp to the pound. A table
// carrying platinum had it recorded as the gold it was worth, and the
// Carried list weighed every one of those gold pieces as a coin: 39,949 gp
// came to 798.98 lb. The list's coin row now reads the purse as the
// platinum it is carried as (3,995 pp, 79.9 lb), and the Carried tile and
// the list's total agree with it.
import { check, eventually, sleep } from "../lib.mjs";

const GOLD = 39_949;
const GEAR = [
  { name: "Mace", qty: 1, weight: 4, equipped: true },
  { name: "Rope, hempen (50 feet)", qty: 1, weight: 10 },
];

export default {
  name: "purse-as-platinum",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids, base, api } = t;
    const sheetUrl = `${base}/api/campaigns/${ids.quietId}/sheets/${ids.ama}`;
    const before = await (await api.get(`${base}/api/campaigns/${ids.quietId}`)).json().catch(() => null);
    const was = before?.sheets?.find?.((sheet) => sheet.id === ids.ama) ?? null;
    const set = await api.patch(sheetUrl, { data: { gold: GOLD, equipment: GEAR, reason: "browser check: the purse as platinum" } });
    check(set.ok(), `Ama's purse and pack are set (${set.status()})`);
    try {
      await t.open(`/campaigns/${ids.quietId}`);
      await eventually(() => page.locator(`${root}.cine-stage`).count(), { label: "the table's stage" });
      const card = page.locator(`${root}button[title="View full character sheet"]`).filter({ hasText: "Sister Ama" }).locator("visible=true").first();
      for (const selector of [`${root}[data-tour="tab-party"]`, `${root}.cine-party button`]) {
        if (await card.count()) break;
        const door = page.locator(selector).locator("visible=true").first();
        if (await door.count()) {
          await t.tap(door);
          await sleep(800);
        }
      }
      await eventually(() => card.count(), { timeoutMs: 20_000, label: "Sister Ama's party card" });
      await t.tap(card);

      // The tile: 14 lb of gear and 79.9 lb of coin.
      const tile = page.getByRole("button", { name: /Show what makes up this load/ }).locator("visible=true").first();
      await eventually(() => tile.count(), { timeoutMs: 20_000, label: "the Carried tile" });
      const tileText = (await tile.textContent()) ?? "";
      check(/93\.9\/\d+ lb/.test(tileText), `the Carried tile reads 93.9 lb (${tileText.trim()})`);
      await t.tap(tile);

      const list = page.getByRole("dialog", { name: /What Sister Ama carries/ });
      await eventually(() => list.count(), { label: "the Carried list" });
      const coinRow = list.locator("tfoot tr").first();
      const cells = (await coinRow.locator("th, td").allTextContents()).map((text) => text.replace(/\s+/g, " ").trim());
      check(/Coins, as platinum/.test(cells[0]), `the coin row says platinum (${cells[0]})`);
      check(/39,949 gp carried as 3,995 pp, 50 to the pound/.test(cells[0]), `the coin row says what the gold is carried as (${cells[0]})`);
      check(cells[1] === "3,995", `the count is the platinum pieces (${cells[1]})`);
      check(cells[2] === "0.02 lb", `each coin is a fiftieth of a pound (${cells[2]})`);
      check(cells[3] === "79.9 lb", `the purse weighs 79.9 lb, not 798.98 (${cells[3]})`);
      const sum = ((await list.locator("tr.load-sum").textContent()) ?? "").replace(/\s+/g, " ");
      check(/93\.9 lb/.test(sum), `the list's total matches the tile (${sum.trim()})`);
      await list.locator("tfoot").scrollIntoViewIfNeeded();
      await t.shot("carried-list");
    } finally {
      await api.patch(sheetUrl, {
        data: { gold: was?.gold ?? 0, equipment: was?.equipment ?? [{ name: "Mace", qty: 1, equipped: true }, { name: "Component pouch", qty: 1 }], reason: "browser check: put back" },
      });
    }
  },
};
