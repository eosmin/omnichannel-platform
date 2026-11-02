import type { PrismaService } from '@platform/core/database'
import { ExportStatus } from '@platform/core/queues'

import { ExportProgress, PROGRESS_MIN_INTERVAL_MS } from './export-progress'

// The write settles through a few promise steps: wait for all of them
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function build(total: number) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 })
  const prisma = { client: { export: { updateMany } } } as unknown as PrismaService
  let time = 10_000
  const progress = new ExportProgress(prisma, { id: 'e1', storeId: 's1' }, total, () => time)
  return {
    progress,
    updateMany,
    advance: (ms: number) => {
      time += ms
    }
  }
}

describe('ExportProgress.percentOf', () => {
  it('is a whole percent, never 100 while the file is being written, and 0 with nothing to count', () => {
    expect(ExportProgress.percentOf(1, 3)).toBe(33)
    expect(ExportProgress.percentOf(3, 3)).toBe(99)
    expect(ExportProgress.percentOf(9, 3)).toBe(99)
    expect(ExportProgress.percentOf(5, 0)).toBe(0)
  })
})

describe('ExportProgress', () => {
  it('writes the percent of the row of its own store, only while the row is pending', async () => {
    const { progress, updateMany } = build(100)
    progress.report(25)
    await settle()
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'e1', storeId: 's1', status: ExportStatus.PENDING },
      data: { progress: 25 }
    })
  })

  it('writes at most once per interval, and not again for the same percent', async () => {
    const { progress, updateMany, advance } = build(100)
    progress.report(10)
    await settle()
    progress.report(20)
    expect(updateMany).toHaveBeenCalledTimes(1)
    advance(PROGRESS_MIN_INTERVAL_MS)
    progress.report(10)
    expect(updateMany).toHaveBeenCalledTimes(1)
    progress.report(30)
    await settle()
    expect(updateMany).toHaveBeenCalledTimes(2)
  })

  it('does not fail the export when the write of the bar fails', async () => {
    const { progress, updateMany } = build(10)
    updateMany.mockRejectedValueOnce(new Error('down'))
    expect(() => progress.report(5)).not.toThrow()
    await settle()
  })
})
