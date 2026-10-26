/** Listeners in the order added; the same function added twice is two entries, each removed by its own remover. */
export class Listeners<Listener> {
  private readonly entries = new Set<{ listener: Listener }>();

  get size() {
    return this.entries.size;
  }

  add(listener: Listener) {
    const entry = { listener };
    this.entries.add(entry);
    return () => void this.entries.delete(entry);
  }

  /** The current listeners, unaffected by any added or removed while they run. */
  list() {
    return Array.from(this.entries, ({ listener }) => listener);
  }

  clear() {
    this.entries.clear();
  }
}
