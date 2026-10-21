// The board's hover plate shows the figure's painting large, keeps the face
// chain (an uploaded portrait first), and sits clear of the board's edges.
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
register("./lib/register-jsx.mjs", import.meta.url);
const { TokenPlate } = await import("../src/app/campaigns/[campaignId]/BoardChrome.tsx");

const token = { id: "t1", refId: "e1", kind: "enemy", name: "Ogre Brute", x: 9, y: 1 };
const plate = (more) => renderToStaticMarkup(createElement(TokenPlate, {
  token, boardWidth: 10, boardHeight: 10, footprint: 1,
  face: ["/uploads/portrait.png", "/assets/placeholders/monster.webp"],
  health: "bloodied", conditions: [{ id: "prone", label: "Prone" }], ...more,
}));

const markup = plate();
assert.match(markup, /role="tooltip"/);
assert.match(markup, /pointer-events-none/);
assert.match(markup, /src="\/uploads\/portrait.png"/, "the uploaded portrait wins");
assert.match(markup, /size-\[124px\][^"]*sm:size-\[160px\]/, "the painting is shown large");
for (const text of ["Ogre Brute", "Prone"]) assert.ok(markup.includes(text), text);
// The margins and the gap are the screen's, like the plate: the camera's
// --ink is one over its zoom (BattleMapPanel.tsx), 1 off the board.
assert.match(markup, /left:clamp\(calc\(88px \* var\(--ink, 1\)\), 95%, calc\(100% - 88px \* var\(--ink, 1\)\)\)/, "kept off the right edge");
assert.match(markup, /translate:-50% calc\(6px \* var\(--ink, 1\)\)/, "below a figure in the top half");
assert.match(plate({ token: { ...token, y: 8 } }), /translate:-50% calc\(-100% - 6px \* var\(--ink, 1\)\)/, "above a figure in the bottom half");
// Its own size at any zoom, scaled back about the edge facing the figure.
assert.match(markup, /scale:var\(--ink, 1\);transform-origin:50% 0/, "drawn at its own size close up, from its top edge below a figure");
assert.match(plate({ token: { ...token, y: 8 } }), /transform-origin:50% 100%/, "from its bottom edge above a figure");
console.log("ok: hover plate shows the portrait large, edge-clamped, above or below the figure, its own size at any zoom");
