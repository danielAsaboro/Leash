export const LEASH_MARK_VIEWBOX = 64;
export const LEASH_MARK_STROKE = 11;
export const LEASH_MARK_TILE_RADIUS = 16;

export const LEASH_MARK_NODES = [
  { cx: 32, cy: 15, r: 9 },
  { cx: 18, cy: 42, r: 9 },
  { cx: 46, cy: 42, r: 9 },
] as const;

export const LEASH_MARK_LINKS = [
  { x1: 32, y1: 20, x2: 20.5, y2: 36.5 },
  { x1: 32, y1: 20, x2: 43.5, y2: 36.5 },
  { x1: 24, y1: 42, x2: 40, y2: 42 },
] as const;

export const LEASH_MARK_CUTOUT = { cx: 32, cy: 31.5, r: 4.75 } as const;

type LeashIconPalette = {
  tile: string;
  mark: string;
  cutout: string;
};

export function getLeashIconSvgMarkup(
  palette: LeashIconPalette = {
    tile: "#f1efe6",
    mark: "#191712",
    cutout: "#f1efe6",
  },
) {
  const { tile, mark, cutout } = palette;

  const links = LEASH_MARK_LINKS.map(
    ({ x1, y1, x2, y2 }) =>
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${mark}" stroke-width="${LEASH_MARK_STROKE}" stroke-linecap="round" stroke-linejoin="round" />`,
  ).join("");

  const nodes = LEASH_MARK_NODES.map(
    ({ cx, cy, r }) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${mark}" />`,
  ).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LEASH_MARK_VIEWBOX} ${LEASH_MARK_VIEWBOX}" fill="none"><rect width="${LEASH_MARK_VIEWBOX}" height="${LEASH_MARK_VIEWBOX}" rx="${LEASH_MARK_TILE_RADIUS}" fill="${tile}" />${links}${nodes}<circle cx="${LEASH_MARK_CUTOUT.cx}" cy="${LEASH_MARK_CUTOUT.cy}" r="${LEASH_MARK_CUTOUT.r}" fill="${cutout}" /></svg>`;
}
