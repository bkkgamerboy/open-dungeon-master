// What rides on the board keeps its drawn size at any zoom. The camera layer
// carries --ink, one over its zoom (BattleMapPanel.tsx); the intent badge,
// the name plate (test-token-plate.mjs) and the action wheel scale by it, so
// the phone's close-up, several times the fit, no longer blows a 21 px badge
// up into a red disc five squares wide over the party. The intent's
// sentence is chrome: it renders apart from the layer, for the frame's top.
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
register("./lib/register-jsx.mjs", import.meta.url);
const { IntentLayer, IntentToast } = await import("../src/app/campaigns/[campaignId]/BoardIntent.tsx");
const { TokenHud } = await import("../src/app/campaigns/[campaignId]/TokenHud.tsx");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

const armour = { id: "t-armour", refId: "e1", kind: "enemy", name: "Animated Armor", x: 22, y: 21 };
const isabel = { id: "t-isabel", refId: "c1", kind: "pc", name: "Isabel Chapman", x: 22, y: 19 };
const tokens = [armour, isabel];
const intent = { actorTokenId: armour.id, verb: "Slam", verbKind: "melee", targetTokenId: isabel.id, source: "likely", round: 10 };
const layer = (more = {}) =>
  renderToStaticMarkup(
    createElement(IntentLayer, {
      intents: [intent],
      tokens,
      footprints: {},
      boardWidth: 46,
      boardHeight: 36,
      round: 10,
      litId: null,
      onLit: () => {},
      ...more,
    }),
  );

test("the intent badge is scaled back by the camera's zoom about its centre", () => {
  const markup = layer();
  assert.match(markup, /class="intent-badge/);
  assert.match(markup, /scale:var\(--ink, 1\);transform-origin:0 0/);
});

test("the badge sits a screen-sized gap above its figure, below it along the top rows", () => {
  assert.match(layer(), /top:58\.33[0-9]*%;margin-top:calc\(-13px \* var\(--ink, 1\)\)/, "above: the figure's top edge, 13 px up");
  const high = layer({ tokens: [{ ...armour, y: 1 }, isabel] });
  assert.match(high, /top:5\.55[0-9]*%;margin-top:calc\(13px \* var\(--ink, 1\)\)/, "below: the figure's bottom edge, 13 px down");
});

test("the sentence is not drawn inside the zoomed layer", () => {
  const markup = layer({ litId: armour.id });
  assert.ok(!markup.includes("intent-toast"), "no sentence in the layer");
  assert.match(markup, /class="intent-scale"/, "the arc to its mark still draws there");
});

test("the sentence renders as chrome for the pressed intent only", () => {
  const toast = (litId) =>
    renderToStaticMarkup(createElement(IntentToast, { intents: [intent], tokens, round: 10, litId, faceOf: () => [] }));
  assert.equal(toast(null), "");
  const markup = toast(armour.id);
  assert.match(markup, /class="intent-toast/);
  assert.ok(markup.includes("Animated Armor will likely Slam Isabel Chapman"));
  assert.ok(!/--ink/.test(markup), "the frame's own size, no zoom to undo");
  assert.equal(renderToStaticMarkup(createElement(IntentToast, { intents: [intent], tokens, round: 11, litId: armour.id, faceOf: () => [] })), "", "a stale round says nothing");
});

test("the wheel is scaled back by the zoom and opens clear of a figure drawn big", () => {
  const hud = (tilePx, footprint = 1) =>
    renderToStaticMarkup(
      createElement(TokenHud, {
        token: isabel,
        boardWidth: 46,
        boardHeight: 36,
        footprint,
        tilePx,
        actions: [
          { id: "a", label: "Attack", icon: () => null, onPick: () => {} },
          { id: "b", label: "Dash", icon: () => null, onPick: () => {} },
        ],
        onClose: () => {},
      }),
    );
  assert.match(hud(44), /scale:var\(--ink, 1\);transform-origin:0 0/);
  // The close button hangs radius + 16 below the centre (the arc opens up):
  // 56 for a figure the wheel clears already, wider for a big one.
  assert.match(hud(44), /top:72px/);
  assert.match(hud(0), /top:72px/, "unmeasured, the radius it always had");
  assert.match(hud(80, 2), /top:122px/, "a Large figure 160 px across: 80 + 26 clear");
});

console.log(`\n${passed} board ink checks passed`);
