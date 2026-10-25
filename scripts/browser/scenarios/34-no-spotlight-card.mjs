// Build 28: a spotlight draws no card above the message box. On a phone the
// card (the heroes' faces, their names, the DM's question and Release) took
// half the screen from the story. With the spotlight on someone else the
// box says who the DM is waiting on; on the lead's own hero it asks for
// their move as ever; and the Lead tab's floor card still shows the DM's
// question and Open floor, so a stuck spotlight can still be lifted.
import { check, eventually, sleep } from "../lib.mjs";

const PROMPT = "Which way does the party take at the ford?";

export default {
  name: "no-spotlight-card",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids, base, api, viewport } = t;
    const floor = (data) => api.post(`${base}/api/campaigns/${ids.quietId}/floor`, { data });
    const phone = viewport === "phone";
    const bar = page.locator(`${root}nav.cine-bottombar`).locator("visible=true").first();
    try {
      for (const [who, characterId, placeholder] of [
        ["someone else", ids.corin, /^Waiting on Corin Vale/],
        ["the lead's own hero", ids.ama, /^What does Sister Ama do\?/],
      ]) {
        const response = await floor({ set: "spotlight", characterIds: [characterId], prompt: PROMPT });
        check(response.ok(), `the spotlight is set on ${who} (${response.status()})`);
        await t.open(`/campaigns/${ids.quietId}`);
        await eventually(() => page.locator(`${root}.cine-stage`).count(), { label: "the table's stage" });
        if (phone) {
          await t.tap(bar.getByRole("button", { name: /^table$/i }));
          await sleep(600);
        }
        const box = page.locator(`${root}[data-tour=composer-input] textarea`).locator("visible=true").first();
        await eventually(async () => placeholder.test((await box.getAttribute("placeholder")) ?? ""), {
          label: `the box's placeholder with the spotlight on ${who}`,
        });
        const desk = page.locator(`${root}form.session-desk`).locator("visible=true").first();
        check((await desk.locator(".session-banner").filter({ hasText: /Spotlight/ }).count()) === 0, `no Spotlight card over the box (${who})`);
        check((await desk.getByText(PROMPT).count()) === 0, `the DM's question is not over the box (${who})`);
        check((await desk.getByRole("button", { name: /^Release$/ }).count()) === 0, `no Release button over the box (${who})`);
        await t.shot(`spotlight-${characterId === ids.corin ? "other" : "mine"}`);
      }

      // The Lead tab keeps the question and the way to lift the spotlight.
      if (phone) {
        await t.tap(bar.getByRole("button", { name: /^lead$/i }));
      } else {
        await page.locator(`${root}[data-tour="tab-lead"]`).locator("visible=true").first().click();
      }
      await eventually(() => page.getByText(PROMPT).locator("visible=true").count(), { label: "the DM's question in the Lead tab" });
      const open = page.getByRole("button", { name: /^Open floor$/ }).locator("visible=true").first();
      await eventually(() => open.count(), { label: "Open floor in the Lead tab" });
      await t.shot("lead-floor");
      await open.click();
      await eventually(async () => (await page.getByText(PROMPT).locator("visible=true").count()) === 0, {
        label: "Open floor lifts the spotlight",
      });
    } finally {
      await floor({ set: "open" });
    }
  },
};
