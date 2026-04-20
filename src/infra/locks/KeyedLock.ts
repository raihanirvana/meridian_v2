export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  public isLocked(key: string): boolean {
    return this.tails.has(key);
  }

  public async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);

    this.tails.set(key, tail);

    await previous;

    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
