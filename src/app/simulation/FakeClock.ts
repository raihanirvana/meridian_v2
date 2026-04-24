export class FakeClock {
  private currentIso: string;

  public constructor(initialIso: string) {
    this.currentIso = FakeClock.normalize(initialIso);
  }

  public now(): string {
    return this.currentIso;
  }

  public set(iso: string): string {
    this.currentIso = FakeClock.normalize(iso);
    return this.currentIso;
  }

  public advanceMinutes(minutes: number): string {
    if (!Number.isFinite(minutes)) {
      throw new Error(
        `FakeClock.advanceMinutes requires a finite number, received ${minutes}`,
      );
    }

    const next = new Date(Date.parse(this.currentIso) + minutes * 60_000);
    this.currentIso = FakeClock.normalize(next.toISOString());
    return this.currentIso;
  }

  private static normalize(iso: string): string {
    const parsedAt = Date.parse(iso);
    if (Number.isNaN(parsedAt)) {
      throw new Error(`Invalid ISO timestamp for FakeClock: ${iso}`);
    }

    return new Date(parsedAt).toISOString();
  }
}
