export const TABLET_MIN_WIDTH = 744;

export function isTabletLayout(width: number, height: number): boolean {
  return Math.min(width, height) >= TABLET_MIN_WIDTH;
}
