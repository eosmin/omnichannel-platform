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

  it('keeps one timer when it is triggered again while a pass is running', async () => {
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
    expect(flush).toHaveBeenCalledTimes(1)
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
})
