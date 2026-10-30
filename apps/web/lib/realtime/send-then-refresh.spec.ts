import { sendThenRefresh } from './send-then-refresh'

describe('sendThenRefresh', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('answers with what the send answered, after the screen has read again', async () => {
    const order: string[] = []
    const result = await sendThenRefresh(
      () => {
        order.push('send')
        return Promise.resolve('sent')
      },
      () => {
        order.push('refresh')
        return Promise.resolve()
      },
      1000
    )
    expect(result).toBe('sent')
    expect(order).toEqual(['send', 'refresh'])
  })

  it('does not hold the queue for a refresh that does not come back', async () => {
    const pending = sendThenRefresh(
      () => Promise.resolve('sent'),
      () => new Promise<void>(() => undefined),
      1000
    )
    await jest.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBe('sent')
  })

  it('does not hide a send that failed, and does not refresh for it', async () => {
    const refresh = jest.fn()
    await expect(
      sendThenRefresh(() => Promise.reject(new Error('refused')), refresh, 1000)
    ).rejects.toThrow('refused')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('does not fail because the refresh failed: the message is already stored', async () => {
    await expect(
      sendThenRefresh(
        () => Promise.resolve('sent'),
        () => Promise.reject(new Error('offline')),
        1000
      )
    ).resolves.toBe('sent')
  })
})
