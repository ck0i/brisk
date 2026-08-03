export class EventBatcher<T> {
  private readonly pending: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastFlush = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly consume: (events: readonly T[]) => void,
    private readonly frameMs = 16,
  ) {
    if (!Number.isFinite(frameMs) || frameMs <= 0) {
      throw new RangeError("frameMs must be a positive finite number");
    }
  }

  get size(): number {
    return this.pending.length;
  }

  push(event: T): void {
    this.pending.push(event);
    if (this.timer !== undefined) return;

    const elapsed = performance.now() - this.lastFlush;
    if (elapsed >= this.frameMs) {
      this.flush();
      return;
    }

    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.flush();
      },
      Math.max(0, this.frameMs - elapsed),
    );
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;

    const events = this.pending.splice(0);
    this.lastFlush = performance.now();
    this.consume(events);
  }

  cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.length = 0;
  }
}
