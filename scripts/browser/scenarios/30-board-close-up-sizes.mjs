// The phone's close-up board keeps what rides on it at the size it was drawn
// for. Close up, the board is zoomed several times over, and the enemy's
// intent badge, the sentence it spells out and a figure's name plate sat
// inside that zoom: on the Undercroft's 46-tile crypt they came out three
// times their size, a red badge as wide as five squares and a name across
// the top of the screen, over the very figures the player had to find. The
// figures themselves stopped growing at the camera's old zoom ceiling, a
// fingertip wide. Now the figure is a thumb's width, and the badge, the
// sentence and the plate stay their drawn size beside it, whatever the zoom.
import { check, eventually, sleep } from "../lib.mjs";

const box = async (locator) => (await locator.count()) ? locator.first().boundingBox() : null;

function overlap(a, b) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return w * h;
}

export default {
  name: "board-close-up-sizes",
  viewports: ["phone"],
  async run(t) {
    const { page, root, ids } = t;
    await t.open(`/campaigns/${ids.campaignId}`);
    await t.tap(page.locator(`${root}nav.cine-bottombar button`).filter({ hasText: /battle/i }).first());
    const board = page.locator(`${root}.board-dock [aria-label^="Board view"], ${root}[aria-label^="Board view"]`).locator("visible=true").first();
    await eventually(() => board.count(), { timeoutMs: 30_000, label: "the board" });
    // The camera eases to its close-up.
    await sleep(1_500);
    const frame = await board.boundingBox();
    check(Boolean(frame), "the board is on screen");

    const tavi = await eventually(
      () =>
        page.evaluate((prefix) => {
          const node = [...document.querySelectorAll(`${prefix}[data-token-id]`)].find((element) =>
            element.getAttribute("aria-label")?.startsWith("Tavi Lockwhisper"),
          );
          return node?.getAttribute("data-token-id") ?? null;
        }, root),
      { timeoutMs: 20_000, label: "Tavi's figure" },
    );
    const figure = await box(page.locator(`${root}[data-token-id="${tavi}"]`));
    check(Boolean(figure), "your figure is drawn");
    check(figure.width >= 32, `your figure is a thumb's width, not a fingertip's (${Math.round(figure.width)} px)`);
    check(
      figure.x >= frame.x && figure.y >= frame.y && figure.x + figure.width <= frame.x + frame.width && figure.y + figure.height <= frame.y + frame.height,
      "your figure is in view",
    );
    await t.shot("close-up");

    // The goblin next to Tavi means to hit someone: its badge stays a badge.
    const badge = page.locator(`${root}.intent-badge`).locator("visible=true");
    const badgeBox = await eventually(() => box(badge), { timeoutMs: 10_000, label: "the goblin's intent badge" });
    check(badgeBox.height <= 30 && badgeBox.width <= 60, `the intent badge keeps its size (${Math.round(badgeBox.width)} x ${Math.round(badgeBox.height)} px)`);
    check(overlap(badgeBox, figure) <= figure.width * figure.height * 0.25, "the intent badge does not cover your figure");

    // One tap spells out its sentence along the top of the board, at the size
    // of text, inside the screen, and holds it (a tap focused the badge just
    // before its click, and the click put out what the focus had lit). The
    // badge breathes, so it is never still enough for a locator's tap: it is
    // pressed at its centre, as a thumb would.
    const press = async (at) => {
      if (t.touch) await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
      else await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    };
    await press(badgeBox);
    const toast = page.locator(`${root}.intent-toast`).locator("visible=true");
    const toastBox = await eventually(() => box(toast), { timeoutMs: 5_000, label: "the intent's sentence" });
    check(toastBox.height <= 44, `the sentence is a line of text (${Math.round(toastBox.height)} px tall)`);
    check(
      toastBox.x >= frame.x - 1 && toastBox.x + toastBox.width <= frame.x + frame.width + 1 && toastBox.y >= frame.y - 1 && toastBox.y + toastBox.height <= frame.y + frame.height,
      "the sentence sits inside the board, on screen",
    );
    await sleep(400);
    await t.shot("intent");
    await press(await box(badge));
    await eventually(async () => (await toast.count()) === 0, { label: "the sentence put away" });

    // A tap on the goblin shows its plate and holds it (the tap's mousemove
    // put it up and its click took it down), a card, not the whole screen.
    const goblin = await page.evaluate((prefix) => {
      const node = [...document.querySelectorAll(`${prefix}[data-token-id]`)].find(
        (element) => !element.getAttribute("aria-label")?.startsWith("Tavi") && !element.getAttribute("aria-label")?.startsWith("Bree"),
      );
      return node?.getAttribute("data-token-id") ?? null;
    }, root);
    if (goblin) {
      const at = await box(page.locator(`${root}[data-token-id="${goblin}"]`));
      if (at) {
        await press(at);
        const plate = page.locator(`${root}[role="tooltip"]`).locator("visible=true");
        const plateBox = await eventually(() => box(plate), { timeoutMs: 5_000, label: "the goblin's plate" });
        check(plateBox.width <= 200, `the plate is a card (${Math.round(plateBox.width)} px wide)`);
        await sleep(400);
        await t.shot("plate");
      }
    }
  },
};
