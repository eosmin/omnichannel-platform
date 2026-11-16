import { withTimeout } from './with-timeout'

describe('withTimeout', () => {
  it('returns what the call answers in time', async () => {
    await expect(withTimeout(() => Promise.resolve('ok'), 50)).resolves.toBe('ok')
  })

  it('gives up on a call that does not answer, and does not wait for it', async () => {
    const started = Date.now()
    await expect(withTimeout(() => new Promise<string>(() => undefined), 30)).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('lets the error of a call that fails reach the caller', async () => {
    await expect(withTimeout(() => Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom')
  })

  it('treats a call that throws before it returns a promise as a call that failed', async () => {
    await expect(
      withTimeout(() => {
        throw new Error('sync')
      }, 50)
    ).rejects.toThrow('sync')
  })
})
