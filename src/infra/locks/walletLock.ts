import { KeyedLock } from "./KeyedLock.js";

export class WalletLock {
  private readonly keyedLock = new KeyedLock();

  public isLocked(wallet: string): boolean {
    return this.keyedLock.isLocked(wallet);
  }

  public async withLock<T>(
    wallet: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.keyedLock.withLock(wallet, work);
  }
}
