import { categoryRunner, inBatches } from './retention-batches'

describe('inBatches', () => {
  it('stops at the first batch that comes back short, and says nothing more waits', async () => {
    const takes = [500, 500, 120]
    const outcome = await inBatches(500, 10, () => {
      const taken = takes.shift() ?? 0
      return Promise.resolve({ taken, deleted: taken })
    })

    expect(outcome).toEqual({ deleted: 1120, more: false })
  })

  it('stops at the limit of batches and says that more waits', async () => {
    let calls = 0
    const outcome = await inBatches(500, 3, () => {
      calls += 1
      return Promise.resolve({ taken: 500, deleted: 500 })
    })

    expect(calls).toBe(3)
    expect(outcome).toEqual({ deleted: 1500, more: true })
  })

  it('counts what was removed, which can be less than what was taken', async () => {
    const outcome = await inBatches(500, 5, () => Promise.resolve({ taken: 10, deleted: 7 }))

    expect(outcome).toEqual({ deleted: 7, more: false })
  })

  it('does not hide a failure: the batch that throws throws out of the run', async () => {
    await expect(inBatches(500, 5, () => Promise.reject(new Error('down')))).rejects.toThrow('down')
  })
})

describe('a batch that throws after others deleted', () => {
  it('keeps what was deleted before it in the error, and the report has it', async () => {
    let calls = 0
    const run = inBatches(2, 5, () => {
      calls += 1
      return calls === 1
        ? Promise.resolve({ taken: 2, deleted: 2 })
        : Promise.reject(new Error('down'))
    })

    await expect(run).rejects.toMatchObject({ deleted: 2, message: 'down' })
  })

  it('records the partial count in the report and the category as failed', async () => {
    const report = { media: 0, more: [] as string[] }
    const failed: 'media'[] = []
    const seen: unknown[] = []
    const runCategory = categoryRunner(report, failed, (_category, error) => seen.push(error))

    await runCategory('media', () =>
      inBatches(
        2,
        5,
        (() => {
          let calls = 0
          return () => {
            calls += 1
            return calls === 1
              ? Promise.resolve({ taken: 2, deleted: 2 })
              : Promise.reject(new Error('down'))
          }
        })()
      )
    )

    expect(report.media).toBe(2)
    expect(failed).toEqual(['media'])
    expect((seen[0] as Error).message).toBe('down')
  })
})
