import { createFlushScheduler } from './flush-scheduler'

function setup(waitingAfter: number[]) {
  const flush = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined)
  const waiting = jest.fn(() => new Array<never>(waitingAfter.shift() ?? 0))
  const scheduler = createFlushScheduler({ flush, waiting: waiting as never }, 'u1', {
    firstMs: 1000,
    maxMs: 4000
  })
  return { flush, scheduler }
}

describe('createFlushScheduler', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('sends once and stops when nothing is left', async () => {
    const { flush, scheduler } = setup([0])
    scheduler.trigger()
    await jest.advanceTimersByTimeAsync(10_000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith('u1')
  })

  it('tries again, waiting longer each time up to the maximum, while something is left', async () => {
    const { flush, scheduler } = setup([1, 1, 1, 1, 0])
    scheduler.trigger()
    await jest.advanceTimersByTimeAsync(0)
    expect(flush).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1000)
    expect(flush).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(1999)
    expect(flush).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(1)
    expect(flush).toHaveBeenCalledTimes(3)
    await jest.advanceTimersByTimeAsync(4000)
    expect(flush).toHaveBeenCalledTimes(4)
    await jest.advanceTimersByTimeAsync(4000)
    expect(flush).toHaveBeenCalledTimes(5)
    await jest.advanceTimersByTimeAsync(60_000)
    expect(flush).toHaveBeenCalledTimes(5)
  })

  it('starts the waits over after a pass that leaves nothing', async () => {
    const { flush, scheduler } = setup([1, 0, 1, 0])
    scheduler.trigger()
    await jest.advanceTimersByTimeAsync(1000)
    scheduler.trigger()
    await jest.advanceTimersByTimeAsync(0)
    expect(flush).toHaveBeenCalledTimes(3)
    await jest.advanceTimersByTimeAsync(1000)
    expect(flush).toHaveBeenCalledTimes(4)
  })

  it('answers a trigger made during a pass with one more pass, not with a second timer', async () => {
    let release: () => void = () => undefined
    const flush = jest.fn<Promise<void>, [string]>(
      () => new Promise<void>(resolve => (release = resolve))
    )
    const scheduler = createFlushScheduler({ flush, waiting: (() => [1]) as never }, 'u1', {
      firstMs: 1000,
      maxMs: 4000
    })
    scheduler.trigger()
    scheduler.trigger()
    release()
    await jest.advanceTimersByTimeAsync(0)
    scheduler.stop()
    await jest.advanceTimersByTimeAsync(60_000)
    // The pass that follows the request, and no retry of the first one
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('does nothing once stopped', async () => {
    const { flush, scheduler } = setup([1, 1])
    scheduler.trigger()
    await jest.advanceTimersByTimeAsync(0)
    scheduler.stop()
    await jest.advanceTimersByTimeAsync(60_000)
    scheduler.trigger()
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('runs again at once when it is asked while a pass is in flight, without waiting for a retry', async () => {
    let finishFirst: () => void = () => undefined
    const flush = jest
      .fn<Promise<void>, [string]>()
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finishFirst = resolve
          })
      )
      .mockResolvedValue(undefined)
    // A message written during the first pass is still waiting when it ends, then nothing is
    const waiting = jest.fn().mockReturnValueOnce([1]).mockReturnValue([])
    const scheduler = createFlushScheduler({ flush, waiting }, 'u1', { firstMs: 5000, maxMs: 5000 })

    scheduler.trigger()
    await jest.advanceTimersByTimeAsync(0)
    scheduler.trigger()
    finishFirst()
    await jest.advanceTimersByTimeAsync(0)

    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('treats a pass that threw as one that left something waiting, and tries again', async () => {
    const flush = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error('storage went away'))
      .mockResolvedValue(undefined)
    const waiting = jest.fn().mockReturnValueOnce([1]).mockReturnValue([])
    const scheduler = createFlushScheduler({ flush, waiting }, 'u1', { firstMs: 1000, maxMs: 1000 })

    scheduler.trigger()
    await jest.advanceTimersByTimeAsync(1000)

    expect(flush).toHaveBeenCalledTimes(2)
  })
})
