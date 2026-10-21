// Build 23: an ally the lead took over ("Play this ally yourself") before it
// was ever saved had no Save to library on its card, the companion card's
// button being for companions and the player's for sheets with a library
// row. On Ally Road the lead's Garrick Thorn is such an ally, built by hand
// with a blank brief: his card offers the save, the save files him in the
// lead's library as a companion, once however often it is pressed, and his
// card, linked now, keeps the save and shows no "Hand to the DM" repair.
import { check, eventually, sleep } from "../lib.mjs";

export default {
  name: "taken-over-save",
  viewports: ["desktop", "phone"],
  async run(t) {
    const { page, root, ids, api, base } = t;
    const cards = () => page.locator(`${root}[data-party-card]`).locator("visible=true");
    const garrickCard = () => page.locator(`${root}[data-party-card="${ids.garrick}"]`).locator("visible=true").first();
    const openParty = async () => {
      await eventually(() => page.locator(`${root}.cine-stage`).count(), { timeoutMs: 30_000, label: "the table's stage" });
      await sleep(1_500);
      for (const selector of [`${root}[data-tour="tab-party"]`, `${root}.cine-party button`]) {
        if ((await cards().count()) >= 2) break;
        const door = page.locator(selector).locator("visible=true").first();
        if (await door.count()) {
          await t.tap(door);
          await sleep(800);
        }
      }
      await eventually(async () => (await cards().count()) >= 2, { timeoutMs: 30_000, label: "two party cards" });
    };

    await t.open(`/campaigns/${ids.allyRoadId}`);
    await openParty();
    const save = garrickCard().getByRole("button", { name: /save to library/i });
    await eventually(() => save.count(), { label: "Save to library on Garrick's card" });
    await save.first().scrollIntoViewIfNeeded();
    await t.shot("garrick-card");
    await t.tap(save.first());
    // The first viewport files him; the next finds him filed and saves onto him.
    await eventually(
      async () => (await garrickCard().getByText(/added to your library as a companion|^saved$/i).count()) > 0,
      { label: "the save confirmed on the card" },
    );
    check((await garrickCard().getByText(/could not|not linked/i).count()) === 0, "no error on Garrick's card");
    await t.shot("garrick-saved");

    const response = await api.get(`${base}/api/characters?role=companion`);
    const shelf = (await response.json()).characters ?? [];
    const filed = shelf.filter((entry) => entry.name === "Garrick Thorn");
    check(filed.length === 1, `Garrick filed once as a companion (${filed.length})`);
    check(filed[0]?.level === 3, `filed at the level he plays at (${filed[0]?.level})`);

    // Reloaded, the card reads its link: still saveable, and the repair for
    // a companion seated by the wrong door is not offered for him.
    await t.open(`/campaigns/${ids.allyRoadId}`);
    await openParty();
    await eventually(() => garrickCard().getByRole("button", { name: /save to library/i }).count(), {
      label: "Save to library still on Garrick's card",
    });
    check(
      (await garrickCard().getByText(/filed in the library as an ally the DM plays/i).count()) === 0,
      "no wrong-door repair notice on a taken-over ally",
    );
    check((await garrickCard().getByRole("button", { name: /^hand to the dm$/i }).count()) === 0, "no Hand to the DM button");
    check((await garrickCard().getByRole("button", { name: /hand garrick thorn back to the dm/i }).count()) === 1, "Hand back stays");
  },
};
