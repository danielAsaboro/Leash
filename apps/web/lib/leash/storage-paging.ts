/**
 * Pure paging + selection helpers for the Settings → Storage model-cache list. No `server-only`,
 * no Node — the card runs these in the browser as the user pages and ticks checkboxes.
 * Unit-tested by scripts/smoke-storage-paging.ts.
 */
export interface Paged<T> {
  slice: T[];
  page: number;
  pages: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Slice `items` into a clamped 1-based page of size `perPage` (perPage floored to 1). */
export function paginate<T>(items: T[], page: number, perPage: number): Paged<T> {
  const total = items.length;
  const size = Math.max(1, Math.floor(perPage) || 1);
  const pages = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (clamped - 1) * size;
  return { slice: items.slice(start, start + size), page: clamped, pages, total, hasPrev: clamped > 1, hasNext: clamped < pages };
}

/** Sum `bytes` of files whose `file` key is in `selected`. */
export function sumSelectedBytes(files: { file: string; bytes: number }[], selected: ReadonlySet<string>): number {
  return files.reduce((n, f) => (selected.has(f.file) ? n + f.bytes : n), 0);
}
