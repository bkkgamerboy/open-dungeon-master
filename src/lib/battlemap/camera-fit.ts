// The board's resting view (issue 87). The board is laid out as wide as the
// frame around it. Where the frame is as tall as the board (a phone held
// upright, a side panel with room) that is the whole board and the resting
// view is the plain one. Where the frame is a fixed window (the fight stage,
// the enlarged tabletop, the shared screen, the side panel or a phone on a
// short screen) a tall board would run out of the bottom, so the resting
// view shrinks it until all of it shows and centres it; a wide board in a
// window taller than it sits in the middle of the window rather than along
// its top edge with the table bare beneath (issue 189, the enlarged board).


export type FitCamera = { zoom: number; x: number; y: number };

export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 3;

export function fitCamera(frame: { width: number; height: number }, board: { width: number; height: number }): FitCamera {
  if (frame.width <= 0 || frame.height <= 0 || board.width <= 0 || board.height <= 0) {
    return { zoom: 1, x: 0, y: 0 };
  }
  // The board's height in frame pixels at zoom 1.
  const tall = (frame.width * board.height) / board.width;
  // A pixel of slack: a frame sized by its own board rounds either way.
  if (tall <= frame.height + 1) {
    return { zoom: 1, x: 0, y: Math.max(0, (frame.height - tall) / 2) };
  }

  const zoom = frame.height / tall;
  return { zoom, x: (frame.width - frame.width * zoom) / 2, y: 0 };
}

// The furthest out a view may go: the usual floor, or the fit when a tall
// board in a short window needs to go further to show whole.
export function minZoomFor(fit: FitCamera): number {
  return Math.min(MIN_ZOOM, fit.zoom);
}

// The nearest a view may come: three times the fit, or as near as shows a
// square this many pixels across, whichever is nearer. A board is laid out
// as wide as its frame, so a wide one on a phone has small squares at the
// fit: the Undercroft's 46 on a phone 400 px across are 9 px a square, and
// three times that left a figure a fingertip wide, the phone's close-up
// stopping at 15 squares across when it asked for 9.
export const MAX_TILE_PX = 72;

// The ceiling for a board whose squares are `tilePx` across at the fit.
export function maxZoomFor(tilePx: number): number {
  return tilePx > 0 ? Math.max(MAX_ZOOM, MAX_TILE_PX / tilePx) : MAX_ZOOM;
}

export function clampZoomTo(zoom: number, floor: number, ceiling: number = MAX_ZOOM): number {
  return Math.min(Math.max(floor, ceiling), Math.max(floor, zoom));
}
