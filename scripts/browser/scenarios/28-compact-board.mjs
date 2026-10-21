// The battle board on a phone held upright (useCompactBoard.ts): the board
// takes the screen, close up, its chrome around it rather than over it, and
// a tap on your figure raises the actions in a sheet under the board, not a
// wheel across it. On a wider screen nothing of that shows: the turn order
// and the wheel are on the board as they were. Since build 24 the close-up
// centres exactly on whoever is up, even Tavi at (2, 2) by the map's corner,
// with the dark frame showing past the edge.
import { check, eventually, sleep } from "../lib.mjs";

const figure = (page, root, name) =>
  page.evaluate(
    ({ prefix, who }) => {
      const node = [...document.querySelectorAll(`${prefix}[data-token-id]`)].find((element) =>
        element.getAttribute("aria-label")?.startsWith(who),
      );
      return node?.getAttribute("data-token-id") ?? null;
    },
    { prefix: root, who: name },
  );

async function tapFigure(t, id) {
  const box = await t.page.locator(`${t.root}[data-token-id="${id}"]`).first().boundingBox();
  check(Boolean(box), "your figure is on screen");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (t.touch) await t.page.touchscreen.tap(x, y);
  else await t.page.mouse.click(x, y);
  await sleep(600);
}

export default {
  name: "compact-board",
  viewports: ["phone", "desktop"],
  async run(t) {
    const { page, root, ids, viewport } = t;
    await t.open(`/campaigns/${ids.campaignId}`);
    if (viewport === "phone") {
      await t.tap(page.locator(`${root}nav.cine-bottombar button`).filter({ hasText: /battle/i }).first());
    }
    const board = page.locator(`${root}.board-dock [aria-label^="Board view"], ${root}[aria-label^="Board view"]`).locator("visible=true").first();
    await eventually(() => board.count(), { timeoutMs: 30_000, label: "the board" });
    const tavi = await eventually(() => figure(page, root, "Tavi Lockwhisper"), { timeoutMs: 20_000, label: "Tavi's figure" });

    if (viewport === "phone") {
      const viewportHeight = page.viewportSize()?.height ?? 892;
      const box = await board.boundingBox();
      check(box && box.height >= viewportHeight * 0.45, `the board fills the screen (${Math.round(box?.height ?? 0)} of ${viewportHeight} px tall)`);
      check((await page.locator(`${root}[data-compact-turns]`).count()) === 1, "the turn order is one row above the board");
      check((await page.locator(`${root}[aria-label="Zoom in"]`).locator("visible=true").count()) === 0, "no zoom buttons over the board");
      check((await page.getByRole("button", { name: /^End turn$/ }).locator("visible=true").count()) === 1, "End turn is in the strip");
      // Tavi's turn: his figure sits in the middle of the board, not off in
      // the corner the map's edge used to hold him to.
      const offCentre = async () => {
        const frame = await board.boundingBox();
        const figureBox = await page.locator(`${root}[data-token-id="${tavi}"]`).first().boundingBox();
        if (!frame || !figureBox) return Infinity;
        const dx = figureBox.x + figureBox.width / 2 - (frame.x + frame.width / 2);
        const dy = figureBox.y + figureBox.height / 2 - (frame.y + frame.height / 2);
        return Math.hypot(dx, dy) / Math.max(1, figureBox.width);
      };
      await eventually(async () => (await offCentre()) < 0.6, { timeoutMs: 8_000, label: "Tavi centred on the board" });
      await t.shot("board");

      await tapFigure(t, tavi);
      await eventually(() => page.locator(`${root}.board-compact-sheet`).count(), { label: "the actions sheet" });
      check((await page.locator(`${root}.token-sigil`).count()) === 0, "no wheel of actions across the board");
      await t.shot("sheet");
      await t.tap(page.locator(`${root}.board-compact-sheet`).getByRole("menuitem", { name: /^Attack/ }).first());
      await eventually(
        async () => /tap a target/i.test((await page.locator(`${root}.board-compact-sheet h4`).textContent()) ?? ""),
        { label: "the sheet asking for a target" },
      );
      await t.shot("aim");
      await t.tap(page.locator(`${root}.board-compact-sheet`).getByRole("button", { name: /^Cancel$/ }));
      await eventually(
        async () => !/tap a target/i.test((await page.locator(`${root}.board-compact-sheet h4`).textContent()) ?? ""),
        { label: "the aim cancelled" },
      );
      await t.tap(page.getByRole("button", { name: "Close actions" }));
      await eventually(async () => (await page.locator(`${root}.board-compact-sheet`).count()) === 0, { label: "the sheet closing" });
      return;
    }

    // A wide screen keeps the board as it was: no turn row above it, the
    // wheel on the figure.
    check((await page.locator(`${root}[data-compact-turns]`).count()) === 0, "no compact turn row on a wide screen");
    await tapFigure(t, tavi);
    await eventually(() => page.locator(`${root}.token-sigil`).count(), { label: "the wheel of actions on a wide screen" });
    check((await page.locator(`${root}.board-compact-sheet`).count()) === 0, "no actions sheet on a wide screen");
    await t.shot("wheel");
  },
};
