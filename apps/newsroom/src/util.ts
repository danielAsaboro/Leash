/** Small shared helpers. */

/** URL-safe slug from a headline. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "story";
}

/** Stable non-negative 31-bit hash (for a deterministic diffusion seed per article). */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 1;
}

/** Collapse whitespace + cap length. */
export function tidy(s: string, max = 400): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}
