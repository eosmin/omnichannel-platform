import { ProviderTimeoutError, withTimeout } from './timeout'

describe('withTimeout', () => {
  afterEach(() => jest.useRealTimers())

  it('answers what the work answers when it is quick', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000)).resolves.toBe('done')
  })

  it('rejects with a ProviderTimeoutError, which a caller can tell from any other failure, when it is late', async () => {
    jest.useFakeTimers()
    const late = withTimeout(new Promise<never>(() => undefined), 50)
    const caught = late.catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(60)

    expect(await caught).toBeInstanceOf(ProviderTimeoutError)
  })

  it('keeps the failure of the work when it fails before the time', async () => {
    const failure = new Error('boom')
    await expect(withTimeout(Promise.reject(failure), 1000)).rejects.toBe(failure)
  })
})
