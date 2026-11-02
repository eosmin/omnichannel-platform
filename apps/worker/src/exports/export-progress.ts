import type { PrismaService } from '@platform/core/database'
import { ExportStatus } from '@platform/core/queues'

// A file this far along is shown as 99 until it settles: 100 is the row turning `ready`
const MAX_WHILE_WRITING = 99
// A write per row would cost more than the export; the bar only needs to move now and then
export const PROGRESS_MIN_INTERVAL_MS = 1500

// The percent of an export that is written, kept on its row for the exports center to draw. It is told
// how many rows (or files) are done and writes at most once per interval, never waiting for the
// database: a bar that is late costs nothing, a file that waits for its bar is slower. A failed write is
// dropped, because the next one says more.
export class ExportProgress {
  private lastPercent = -1
  private lastWriteAt = 0
  private writing = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly row: { id: string; storeId: string },
    private readonly total: number,
    private readonly now: () => number = Date.now
  ) {}

  // The percent for `done` of the total; 0 when there is nothing to count
  static percentOf(done: number, total: number): number {
    if (total <= 0) return 0
    return Math.min(MAX_WHILE_WRITING, Math.max(0, Math.floor((done / total) * 100)))
  }

  // Puts the bar back at the start of an attempt
  start(): void {
    this.write(0)
  }

  report(done: number): void {
    const percent = ExportProgress.percentOf(done, this.total)
    const at = this.now()
    if (
      this.writing ||
      percent === this.lastPercent ||
      at - this.lastWriteAt < PROGRESS_MIN_INTERVAL_MS
    ) {
      return
    }
    this.write(percent)
  }

  private write(percent: number): void {
    this.writing = true
    this.lastPercent = percent
    this.lastWriteAt = this.now()
    void this.prisma.client.export
      .updateMany({
        // Not over a row that settled meanwhile
        where: { id: this.row.id, storeId: this.row.storeId, status: ExportStatus.PENDING },
        data: { progress: percent }
      })
      .catch(() => undefined)
      .finally(() => {
        this.writing = false
      })
  }
}
