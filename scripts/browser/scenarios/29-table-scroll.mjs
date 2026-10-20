// The table opens on its newest line, not its first (the table that came
// back scrolled to the top of a long story). Opening the campaign, coming
// back to the Table tab from another, and reloading all land at the foot of
// the transcript, and stay there once late layout settles. A reader who
// scrolled up to reread and switched away comes back to where they were.
import { check, eventually, sleep } from "../lib.mjs";

// The transcript the reader sees: the one scroll box with a size.
function transcript(page, root) {
  return page.locator(`${root}.session-transcript`).locator("visible=true").first();
}

const metrics = (box) =>
  box.evaluate((el) => ({ top: Math.round(el.scrollTop), height: el.scrollHeight, client: el.clientHeight }));

const fromFoot = (m) => m.height - m.top - m.client;

async function atFoot(page, root, label) {
  const box = transcript(page, root);
  await eventually(() => box.count(), { timeoutMs: 30_000, label: `the transcript (${label})` });
  await eventually(async () => (await box.textContent())?.includes("Backend request failed"), {
    timeoutMs: 30_000,
    label: `the last line in the transcript (${label})`,
  });
  // Long enough to scroll at all, or the check proves nothing.
  const first = await metrics(box);
  check(first.height > first.client * 3, `the story is several screens long (${first.height} of ${first.client} px)`);
  await eventually(async () => fromFoot(await metrics(box)) < 40, {
    timeoutMs: 8_000,
    label: `the transcript at its foot (${label})`,
  });
  // Late layout (fonts, cards, the composer) must not leave it short of the foot.
  await sleep(1_500);
  const settled = await metrics(box);
  check(fromFoot(settled) < 40, `${label}: still at the foot once it settles (${fromFoot(settled)} px short)`);
  return box;
}

async function openTab(t, name) {
  await t.tap(t.page.locator(`${t.root}nav.cine-bottombar button`).filter({ hasText: new RegExp(`^${name}$`, "i") }).first());
  await sleep(500);
}

export default {
  name: "table-scroll",
  viewports: ["phone", "desktop"],
  async run(t) {
    const { page, root, ids, viewport } = t;
    // Pictures arrive late, as on a phone: after the transcript first lands.
    await page.route(/\/assets\/ui\/door\/.*\.webp/, async (route) => {
      await sleep(1_200);
      await route.continue();
    });
    await t.open(`/campaigns/${ids.longId}`);
    let box = await atFoot(page, root, "on opening");
    await t.shot("opened");

    if (viewport === "phone") {
      // Away to another tab and back.
      await openTab(t, "Party");
      await openTab(t, "Table");
      box = await atFoot(page, root, "back from the Party tab");
      await t.shot("back");

      // A reader who scrolled up to reread keeps their place across tabs.
      await box.evaluate((el) => {
        el.scrollTop = 400;
        el.dispatchEvent(new Event("scroll"));
      });
      await sleep(400);
      await openTab(t, "Party");
      await openTab(t, "Table");
      const kept = await metrics(transcript(page, root));
      check(Math.abs(kept.top - 400) < 60, `a reader who scrolled up comes back to their place (scrollTop ${kept.top}, wanted ~400)`);
    }

    // Coming back to the game: in the app, home and back in through the
    // campaign's tile; in a browser, a reload.
    if (t.app) {
      await t.open(`/campaigns/${ids.longId}`);
    } else {
      await page.reload();
    }
    await atFoot(page, root, t.app ? "back in from the app's home" : "after a reload");
    await t.shot("reentered");
  },
};
