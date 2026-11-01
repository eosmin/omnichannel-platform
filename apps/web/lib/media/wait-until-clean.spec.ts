import { ApiError } from '@platform/api-client'

import { waitUntilClean } from './wait-until-clean'

const notReady = (): ApiError => new ApiError(409, 'FILE_NOT_READY', 'x')
const noSleep = (): Promise<void> => Promise.resolve()

describe('waitUntilClean', () => {
  it('asks again while the file is not ready and stops at the first answer', async () => {
    const check = jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValueOnce(notReady())
      .mockRejectedValueOnce(notReady())
      .mockResolvedValue({})
    await waitUntilClean(check, { signal: new AbortController().signal, sleep: noSleep })
    expect(check).toHaveBeenCalledTimes(3)
  })

  it('throws an infected file and any other failure at once', async () => {
    const infected = new ApiError(403, 'FILE_INFECTED', 'x')
    const check = jest.fn<Promise<unknown>, []>().mockRejectedValue(infected)
    await expect(
      waitUntilClean(check, { signal: new AbortController().signal, sleep: noSleep })
    ).rejects.toBe(infected)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('gives up as not ready when the tries run out', async () => {
    const check = jest.fn<Promise<unknown>, []>().mockRejectedValue(notReady())
    await expect(
      waitUntilClean(check, {
        signal: new AbortController().signal,
        maxTries: 3,
        sleep: noSleep
      })
    ).rejects.toMatchObject({ code: 'FILE_NOT_READY' })
    expect(check).toHaveBeenCalledTimes(3)
  })

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController()
    const check = jest.fn<Promise<unknown>, []>().mockRejectedValue(notReady())
    const sleep = jest.fn(() => {
      controller.abort()
      return Promise.resolve()
    })
    await expect(waitUntilClean(check, { signal: controller.signal, sleep })).rejects.toBeDefined()
    expect(check).toHaveBeenCalledTimes(1)
  })
})
