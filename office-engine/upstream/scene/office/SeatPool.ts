// 上游办公室原始实现，保留 MIT 许可；本地适配详见 office-engine/README.md。
/**
 * Reservation pool for a fixed ordered list of seat identifiers (the desk/pc
 * spawn points in the Tiled map). Used to hand each dynamically-added agent a
 * distinct seat. Ported verbatim from shahar061/the-office (office/SeatPool.ts).
 */
export class SeatPool {
  private readonly seats: readonly string[];
  private claimed = new Set<string>();

  // constructor：保留原版办公室的绘制、交互或资源管理行为。
  constructor(seats: readonly string[]) {
    this.seats = seats;
  }

  /** Reserve the first unoccupied seat in list order, or null if all taken. */
  // reserveNext：保留原版办公室的绘制、交互或资源管理行为。
  reserveNext(): string | null {
    for (const seat of this.seats) {
      if (!this.claimed.has(seat)) {
        this.claimed.add(seat);
        return seat;
      }
    }
    return null;
  }

  /** Release a previously-reserved seat. Idempotent. */
  // release：保留原版办公室的绘制、交互或资源管理行为。
  release(seat: string): void {
    this.claimed.delete(seat);
  }

  // isReserved：保留原版办公室的绘制、交互或资源管理行为。
  isReserved(seat: string): boolean {
    return this.claimed.has(seat);
  }
}
