// Build 24: the table gives its room to the story and the box being typed
// in. A fight has no red round banner over the message box; a player has no
// row of Do, Say and OOC pills, and the lead's Direct is an icon beside the
// microphone (on a phone, a cell of the bottom bar since build 28); the
// hand ends a turn with one tap on End beside its pips and deals no End
// turn card. On a phone with the keyboard up (the page shrunk to what is
// left above it), the tab bar steps aside, the hand's cards fold away, and
// the message box and Send are whole and on screen; when the keyboard
// closes the tab bar is back.
import { check, eventually, sleep } from "../lib.mjs";

export default {
  name: "table-room",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids, viewport } = t;
    await t.open(`/campaigns/${ids.campaignId}`);
    await eventually(() => page.locator(`${root}.cine-stage`).count(), { label: "the table's stage" });
    if (viewport === "phone") {
      const tableTab = page.locator(`${root}nav.cine-bottombar button`).filter({ hasText: /^table$/i }).first();
      await t.tap(tableTab);
      await sleep(800);
    }
    const hand = page.locator(`${root}section.hand`).locator("visible=true").first();
    await eventually(() => hand.locator(".hand-card").count(), { timeoutMs: 30_000, label: "the Hand's cards" });

    // The board keeps its own round line; the banner was in the desk.
    const desk = page.locator(`${root}form.session-desk`).locator("visible=true").first();
    check((await desk.getByText(/^Round \d+$/).count()) === 0, "no round banner over the message box");
    check((await desk.getByRole("button", { name: /^Skip turn$/ }).count()) === 0, "no Skip turn button over the message box");
    for (const pill of ["Do", "Say", "OOC"]) {
      check((await page.locator(`${root}.session-mode`).filter({ hasText: new RegExp(`^${pill}$`) }).count()) === 0, `no ${pill} pill`);
    }
    // One Direct on screen: the icon by the microphone on a wide screen, the
    // bottom bar's cell on a phone (build 28).
    check((await page.getByRole("button", { name: "Direct the story" }).locator("visible=true").count()) === 1, viewport === "phone" ? "Direct is a cell of the bottom bar" : "Direct is an icon by the microphone");
    const end = hand.getByRole("button", { name: /^End$/ });
    check((await end.count()) === 1, "End sits beside the hand's pips on your turn");
    check((await hand.locator(".hand-card").filter({ hasText: /End turn/ }).count()) === 0, "no End turn card");
    check((await hand.getByRole("button", { name: "How the hand works" }).count()) === 0, "the help is off the pips' row");
    await t.shot("table");

    if (viewport !== "phone") {
      return;
    }
    // The keyboard: the box takes the focus and the page shrinks to what an
    // open keyboard leaves of an upright phone.
    const full = page.viewportSize();
    await page.evaluate(() => document.querySelector("[data-tour=composer-input] textarea")?.focus());
    await sleep(300);
    await page.setViewportSize({ width: full.width, height: 480 });
    await eventually(() => page.evaluate(() => document.documentElement.dataset.keyboard === "open"), {
      label: "the page marked as typing with the keyboard up",
    });
    await sleep(500);
    const layout = await page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, shown: getComputedStyle(node).display !== "none" && box.height > 0 };
      };
      return {
        height: window.innerHeight,
        nav: rect("nav.cine-bottombar"),
        well: rect("[data-tour=composer-input]"),
        send: rect("button[aria-label=Send]"),
        fan: rect("section.hand .hand-fan"),
      };
    });
    await t.shot("keyboard");
    check(!layout.nav?.shown, "the tab bar steps aside while typing");
    check(!layout.fan?.shown, "the hand's cards fold away while typing");
    check(layout.well && layout.well.top >= 0 && layout.well.bottom <= layout.height + 1, `the message box is whole on screen (${Math.round(layout.well?.top)}-${Math.round(layout.well?.bottom)} of ${layout.height})`);
    check(layout.send && layout.send.bottom <= layout.height + 1, "Send is on screen");
    check((await hand.getByRole("button", { name: /^End$/ }).locator("visible=true").count()) === 1, "End stays in view");

    // The keyboard closes: the tab bar is back, and so are the cards.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.setViewportSize(full);
    await eventually(() => page.evaluate(() => document.documentElement.dataset.keyboard !== "open"), { label: "the typing mark gone" });
    await eventually(() => page.locator(`${root}nav.cine-bottombar`).locator("visible=true").count(), { label: "the tab bar back" });
    await eventually(() => hand.locator(".hand-card").locator("visible=true").count(), { label: "the cards back" });
  },
};
