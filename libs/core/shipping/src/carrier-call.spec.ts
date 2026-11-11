import { ShipmentLimits } from '@platform/core/domain'
import {
  CarrierAuthError,
  CarrierRejectedError,
  CarrierUnavailableError
} from '@platform/plugins/sdk'

import { callCreate, withDeadline } from './carrier-call'

afterEach(() => {
  jest.useRealTimers()
})

describe('a call to a carrier', () => {
  it('answers what the carrier answered', async () => {
    await expect(withDeadline(() => Promise.resolve(7))).resolves.toBe(7)
  })

  it('gives the outcome up as unknown when the carrier does not answer in time', async () => {
    jest.useFakeTimers()
    const pending = withDeadline(() => new Promise<never>(() => undefined))
    const caught = pending.catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(ShipmentLimits.PROVIDER_TIMEOUT_MS + 1)
    expect(await caught).toBeInstanceOf(CarrierUnavailableError)
  })

  it('turns a plugin that throws at once into a rejected call, not a thrown one', async () => {
    await expect(
      withDeadline(() => {
        throw new CarrierRejectedError('no')
      })
    ).rejects.toBeInstanceOf(CarrierRejectedError)
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a plugin may reject with anything
    await expect(withDeadline(() => Promise.reject('not an error'))).rejects.toThrow('not an error')
  })
})

describe('asking again', () => {
  it('asks a carrier without an idempotent create once, whatever happens', async () => {
    const run = jest.fn().mockRejectedValue(new CarrierUnavailableError('down'))
    await expect(callCreate(false, run)).rejects.toBeInstanceOf(CarrierUnavailableError)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('asks an idempotent carrier again with a growing pause, and stops at the limit', async () => {
    jest.useFakeTimers()
    const run = jest.fn().mockRejectedValue(new CarrierUnavailableError('down'))
    const caught = callCreate(true, run).catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(ShipmentLimits.RETRY_BASE_DELAY_MS * (1 + 2) + 1)
    expect(await caught).toBeInstanceOf(CarrierUnavailableError)
    expect(run).toHaveBeenCalledTimes(ShipmentLimits.IDEMPOTENT_ATTEMPTS)
  })

  it('stops asking as soon as the carrier answers', async () => {
    jest.useFakeTimers()
    const run = jest
      .fn()
      .mockRejectedValueOnce(new CarrierUnavailableError('down'))
      .mockResolvedValue('guide')
    const result = callCreate(true, run)
    await jest.advanceTimersByTimeAsync(ShipmentLimits.RETRY_BASE_DELAY_MS + 1)
    await expect(result).resolves.toBe('guide')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not take a refusal of a repeated call as "nothing was made": the first attempt may have made the guide', async () => {
    jest.useFakeTimers()
    const run = jest
      .fn()
      .mockRejectedValueOnce(new CarrierUnavailableError('down'))
      .mockRejectedValue(new CarrierRejectedError('duplicate reference'))
    const caught = callCreate(true, run).catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(ShipmentLimits.RETRY_BASE_DELAY_MS + 1)
    expect(await caught).toBeInstanceOf(CarrierUnavailableError)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not take an authentication error of a repeated call as "nothing was made" either', async () => {
    jest.useFakeTimers()
    const run = jest
      .fn()
      .mockRejectedValueOnce(new CarrierUnavailableError('down'))
      .mockRejectedValue(new CarrierAuthError('401'))
    const caught = callCreate(true, run).catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(ShipmentLimits.RETRY_BASE_DELAY_MS + 1)
    expect(await caught).toBeInstanceOf(CarrierUnavailableError)
  })

  it('never asks again after a refusal, even from an idempotent carrier', async () => {
    const run = jest.fn().mockRejectedValue(new CarrierRejectedError('bad address'))
    await expect(callCreate(true, run)).rejects.toBeInstanceOf(CarrierRejectedError)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
