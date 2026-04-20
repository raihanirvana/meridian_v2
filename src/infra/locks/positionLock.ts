import { KeyedLock } from "./KeyedLock.js";

export class PositionLock {
  private readonly keyedLock = new KeyedLock();

  public isLocked(positionId: string): boolean {
    return this.keyedLock.isLocked(positionId);
  }

  public async withLock<T>(
    positionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.keyedLock.withLock(positionId, work);
  }
}
