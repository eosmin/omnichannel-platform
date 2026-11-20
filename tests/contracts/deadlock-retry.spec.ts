import { DEADLOCK_DETECTED, DEADLOCK_TRIES, retryOnDeadlock } from '../helpers/deadlock-retry'

const deadlock = (): Error =>
  Object.assign(new Error('deadlock detected'), { code: DEADLOCK_DETECTED })

describe('retryOnDeadlock', () => {
  it('returns the result of a first try that works, without repeating it', async () => {
    const attempt = jest.fn(() => Promise.resolve('plan'))
    await expect(retryOnDeadlock(attempt)).resolves.toBe('plan')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('repeats the work after a deadlock and returns the try that works', async () => {
    const attempt = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValueOnce('plan')
    await expect(retryOnDeadlock(attempt)).resolves.toBe('plan')
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('gives up with the deadlock after the tries are spent', async () => {
    const attempt = jest.fn(() => Promise.reject(deadlock()))
    await expect(retryOnDeadlock(attempt)).rejects.toMatchObject({ code: DEADLOCK_DETECTED })
    expect(attempt).toHaveBeenCalledTimes(DEADLOCK_TRIES)
  })

  it('does not repeat any other failure, a lock timeout included', async () => {
    const timeout = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03'
    })
    const attempt = jest.fn(() => Promise.reject(timeout))
    await expect(retryOnDeadlock(attempt)).rejects.toBe(timeout)
    expect(attempt).toHaveBeenCalledTimes(1)
    const plain = jest.fn(() => Promise.reject(new Error('boom')))
    await expect(retryOnDeadlock(plain)).rejects.toThrow('boom')
    expect(plain).toHaveBeenCalledTimes(1)
  })
})
