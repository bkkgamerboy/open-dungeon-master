// Build 33: Copy text is the first row of a DM passage's three-dots menu.
// It sat near the bottom, under Reroll, Continue, Edit and the pins, and on
// a phone it is the row the table reaches for most.
import { check, eventually, sleep } from "../lib.mjs";

export default {
  name: "copy-first",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids, viewport } = t;
    // The quiet table: out of a fight a wide screen shows the passages
    // themselves, where a fight puts the Chronicle beside the board.
    await t.open(`/campaigns/${ids.quietId}`);
    if (viewport === "phone") {
      const bar = page.locator(`${root}nav.cine-bottombar`).locator("visible=true").first();
      await eventually(() => bar.count(), { label: "the tab bar" });
      await t.tap(bar.getByRole("button", { name: /^table$/i }));
      await sleep(600);
    }
    const passages = page.locator(`${root}.session-dm`).locator("visible=true");
    await eventually(() => passages.count(), { timeoutMs: 30_000, label: "a DM passage" });
    const more = passages.last().getByRole("button", { name: "Passage actions" });
    await eventually(() => more.count(), { label: "the passage's three-dots button" });
    await t.tap(more.first());
    const rows = page.getByRole("menuitem").locator("visible=true");
    await eventually(() => rows.count(), { label: "the passage menu's rows" });
    const first = (await rows.first().innerText()).trim();
    check(first.startsWith("Copy text"), `the first row is Copy text, not "${first.split("\n")[0]}"`);
    await t.shot("copy-first");
    await page.keyboard.press("Escape");
  },
};
