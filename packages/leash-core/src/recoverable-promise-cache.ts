/**
 * Single-entry async cache whose failed loads are never retained.
 * Concurrent callers for the same key share one load; a new key replaces the value.
 */
export class RecoverablePromiseCache<T> {
  #entry: { key: string; promise: Promise<T> } | null = null;

  async get(key: string, load: () => Promise<T>): Promise<T> {
    if (this.#entry?.key === key) return this.#entry.promise;

    const promise = load();
    const entry = { key, promise };
    this.#entry = entry;
    try {
      return await promise;
    } catch (error) {
      if (this.#entry === entry) this.#entry = null;
      throw error;
    }
  }
}
