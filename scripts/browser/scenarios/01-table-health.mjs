// The table opens and stands: the stage, the Hand, the board and the
// chronicle are there, nothing threw in the page, and no API call behind it
// failed. The baseline every other scenario assumes, and the first thing a
// broken build fails.
import { check, eventually } from "../lib.mjs";

export default {
  name: "table-health",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids } = t;
    await t.open(`/campaigns/${ids.campaignId}`);
    await eventually(() => page.locator(`${root}.cine-stage`).count(), { label: "the table's stage" });
    // A fight is on and it is Tavi's turn, so the Hand deals cards.
    await eventually(() => page.locator(`${root}.hand-card`).count(), { timeoutMs: 30_000, label: "the Hand's cards" });
    const cards = await page.locator(`${root}.hand-card`).count();
    check(cards >= 3, `the Hand shows ${cards} cards; a rogue on their turn has at least Attack, Dodge and Dash`);
    // The board is drawn (its tiles are in the page even where a phone tabs
    // it away) and the painted picture lands on it.
    await eventually(() => page.locator(`${root}[data-tile-x]`).count(), { timeoutMs: 30_000, label: "the board's tiles" });
    await eventually(() => page.locator(`${root}[aria-label^="Board view"] canvas[data-painted-map]`).count(), { timeoutMs: 30_000, label: "the painted board" });
    await t.shot("table");
  },
};
