// Build 28: on a phone, Ask the DM and the lead's Direct are cells of the
// bottom bar, right after Chat, instead of a strip above the message box and
// an icon inside it. A closed Ask strip draws nothing, the message box has
// no Direct icon, and every cell up to Direct is on screen without a swipe,
// in a fight (with its Battle tab) as well as out of one. Ask opens the same
// strip, with its own box, from any tab, and while it is open the desk (the
// Hand and the message box) steps aside so the strip fits; Table closes it
// and brings the desk back. Direct arms a
// direction (its Private switch shows) and lights in the lead's ember, and
// a second press puts the box back to acting. On a wide screen nothing has
// moved: the strip's header and the composer's icon are where they were.
import { check, eventually, sleep } from "../lib.mjs";

const cellLabels = (page, root) =>
  page.evaluate((root) => {
    const nav = [...document.querySelectorAll(`${root}nav.cine-bottombar`)].find((node) => node.getClientRects().length);
    if (!nav) return null;
    const width = window.innerWidth;
    return [...nav.querySelectorAll(":scope > button")].map((button) => {
      const box = button.getBoundingClientRect();
      return {
        label: button.textContent.replace(/\d+/g, "").trim().toLowerCase(),
        left: box.left,
        right: box.right,
        whole: box.left >= -0.5 && box.right <= width + 0.5,
      };
    });
  }, root);

export default {
  name: "phone-bar-ask-direct",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids, viewport } = t;

    if (viewport !== "phone") {
      // A wide screen: the Ask strip's own toggle and the Direct icon stay.
      await t.open(`/campaigns/${ids.quietId}`);
      await eventually(() => page.locator(`${root}.cine-stage`).count(), { label: "the table's stage" });
      const head = page.locator(`${root}.ask-dock-head`).locator("visible=true");
      await eventually(() => head.count(), { label: "the Ask the DM toggle above the message box" });
      check((await page.locator(`${root}.composer-direct`).locator("visible=true").count()) === 1, "Direct is still an icon by the microphone");
      await t.shot("wide");
      return;
    }

    for (const [where, campaignId, fight] of [
      ["quiet", ids.quietId, false],
      ["fight", ids.campaignId, true],
    ]) {
      await t.open(`/campaigns/${campaignId}`);
      await eventually(() => page.locator(`${root}nav.cine-bottombar`).locator("visible=true").count(), { label: `the tab bar (${where})` });
      const bar = page.locator(`${root}nav.cine-bottombar`).locator("visible=true").first();
      await t.tap(bar.getByRole("button", { name: /^table$/i }));
      await sleep(600);

      const cells = await cellLabels(page, root);
      const labels = cells.map((cell) => cell.label);
      const chat = labels.indexOf("chat");
      check(chat >= 0, `Chat is on the bar (${where}): ${labels.join(", ")}`);
      check(labels[chat + 1] === "ask" && labels[chat + 2] === "direct", `Ask then Direct right after Chat (${where}): ${labels.join(", ")}`);
      if (fight) check(labels.includes("battle"), `the fight's Battle tab is there too: ${labels.join(", ")}`);
      const through = cells.slice(0, chat + 3);
      check(through.every((cell) => cell.whole), `every cell up to Direct is on screen without a swipe (${where}): ${through.map((cell) => `${cell.label} ${Math.round(cell.left)}-${Math.round(cell.right)}`).join(", ")}`);

      // The strip's header row and the box's Direct icon are gone; a closed
      // strip takes no height.
      check((await page.locator(`${root}.ask-dock-head`).locator("visible=true").count()) === 0, `no Ask the DM strip above the box (${where})`);
      check((await page.locator(`${root}.composer-direct`).locator("visible=true").count()) === 0, `no Direct icon in the box (${where})`);
      const dockHeight = await page.evaluate((root) => {
        const node = [...document.querySelectorAll(`${root}.ask-dock`)].find((dock) => dock.getClientRects().length);
        return node ? node.getBoundingClientRect().height : 0;
      }, root);
      check(dockHeight < 1, `a closed Ask strip is ${dockHeight}px tall (${where})`);
      await t.shot(`${where}-bar`);
    }

    // Ask, from another tab: the table comes back with the strip open.
    const bar = page.locator(`${root}nav.cine-bottombar`).locator("visible=true").first();
    await t.tap(bar.getByRole("button", { name: /^party$/i }));
    await sleep(500);
    const ask = bar.getByRole("button", { name: "Ask the DM" });
    await t.tap(ask);
    const askBox = page.getByRole("textbox", { name: /^Ask the DM about/ }).locator("visible=true");
    await eventually(() => askBox.count(), { label: "the Ask strip open with its box" });
    check((await ask.getAttribute("aria-current")) === "page", "Ask is lit while the strip is open");
    check((await bar.getByRole("button", { name: /^table$/i }).getAttribute("aria-current")) === null, "Table is not lit while Ask is open");
    // In the fight the strip, the Hand and the box were taller than the
    // screen together: the Ask view sets the desk aside, and the Ask box and
    // its button sit whole above the bar.
    await sleep(1200);
    const asking = await page.evaluate((root) => {
      const shown = (selector) => [...document.querySelectorAll(`${root}${selector}`)].find((node) => node.getClientRects().length);
      const bottom = (node) => (node ? node.getBoundingClientRect().bottom : null);
      const askButton = [...document.querySelectorAll(`${root}.ask-dock form button[type=submit]`)].find((node) => node.getClientRects().length);
      return {
        desk: Boolean(shown("form.cine-desk")),
        box: bottom(shown("textarea[aria-label^='Ask the DM about']")),
        button: bottom(askButton),
        bar: shown("nav.cine-bottombar")?.getBoundingClientRect().top ?? 0,
      };
    }, root);
    check(!asking.desk, "the desk steps aside while asking");
    check(asking.box !== null && asking.box <= asking.bar + 0.5, `the Ask box is above the bar (${Math.round(asking.box)} vs ${Math.round(asking.bar)})`);
    check(asking.button !== null && asking.button <= asking.bar + 0.5, "the Ask button is above the bar");
    await t.shot("ask-open");
    // Ask again closes it; so would Table.
    await t.tap(ask);
    await eventually(async () => (await askBox.count()) === 0, { label: "the Ask strip closed again" });
    await t.tap(ask);
    await eventually(() => askBox.count(), { label: "the Ask strip open once more" });
    await t.tap(bar.getByRole("button", { name: /^table$/i }));
    await eventually(async () => (await askBox.count()) === 0, { label: "Table closes the Ask strip" });
    await eventually(
      () =>
        page.evaluate((root) => {
          const well = [...document.querySelectorAll(`${root}[data-tour=composer-input]`)].find((node) => node.getClientRects().length);
          const nav = [...document.querySelectorAll(`${root}nav.cine-bottombar`)].find((node) => node.getClientRects().length);
          return Boolean(well && nav && well.getBoundingClientRect().bottom <= nav.getBoundingClientRect().top + 0.5);
        }, root),
      { label: "the message box back, whole, above the bar" },
    );

    // Direct: lit, the Private switch with it, then off again.
    const direct = bar.getByRole("button", { name: "Direct the story" });
    await t.tap(direct);
    await eventually(async () => (await direct.getAttribute("aria-pressed")) === "true", { label: "Direct on" });
    await eventually(() => page.getByRole("switch", { name: "Private" }).locator("visible=true").count(), { label: "the direction's Private switch" });
    await t.shot("direct-on");
    await t.tap(direct);
    await eventually(async () => (await direct.getAttribute("aria-pressed")) === "false", { label: "Direct off" });
    await eventually(async () => (await page.getByRole("switch", { name: "Private" }).locator("visible=true").count()) === 0, { label: "the Private switch gone" });
  },
};
