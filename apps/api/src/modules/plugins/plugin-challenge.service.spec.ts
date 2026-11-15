import type { PinoLogger } from 'nestjs-pino'

import { PluginInstallLimits } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import {
  PinnedExchangeFailed,
  PinnedExchangeReasons,
  pinnedHttpsExchange,
  UnsafeUrlError
} from '@platform/core/url-safety'

import { ChallengeFailures, PluginChallengeService } from './plugin-challenge.service'

jest.mock('@platform/core/url-safety', () => ({
  ...jest.requireActual<object>('@platform/core/url-safety'),
  pinnedHttpsExchange: jest.fn()
}))
const exchange = jest.mocked(pinnedHttpsExchange)

const logger = { setContext: jest.fn(), warn: jest.fn() }
const service = new PluginChallengeService(logger as unknown as PinoLogger)
const ENDPOINT = 'https://hooks.acme.com/platform'

// What the plugin would answer: the value it was sent, echoed
function echoing(extra: Record<string, unknown> = {}) {
  exchange.mockImplementation((_url, options) => {
    const sent = JSON.parse(options.body) as { challenge: string }
    return Promise.resolve({
      status: 200,
      body: JSON.stringify({ challenge: sent.challenge, ...extra })
    })
  })
}

async function failureOf(run: Promise<void>): Promise<PlatformException> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(PlatformException)
  return error as PlatformException
}

describe('PluginChallengeService', () => {
  beforeEach(() => {
    exchange.mockReset()
    logger.warn.mockReset()
  })

  it('passes when the endpoint echoes the fresh value it was sent', async () => {
    echoing()

    await expect(service.run('acme-pos', ENDPOINT)).resolves.toBeUndefined()

    const [url, options] = exchange.mock.calls[0] ?? []
    expect(url).toBe(ENDPOINT)
    expect(options).toMatchObject({
      timeoutMs: PluginInstallLimits.CHALLENGE_TIMEOUT_MS,
      maxResponseBytes: PluginInstallLimits.CHALLENGE_MAX_RESPONSE_BYTES
    })
    expect(JSON.parse(options?.body ?? '{}')).toMatchObject({
      type: 'plugin.challenge',
      pluginId: 'acme-pos'
    })
  })

  it('sends a different value every time', async () => {
    echoing()

    await service.run('acme-pos', ENDPOINT)
    await service.run('acme-pos', ENDPOINT)

    const values = exchange.mock.calls.map(
      ([, options]) => (JSON.parse(options.body) as { challenge: string }).challenge
    )
    expect(new Set(values).size).toBe(2)
    expect(values[0]).toHaveLength(43)
  })

  it('fails when the endpoint answers with another value, with none, or with something that is not JSON', async () => {
    for (const body of ['{"challenge":"not-it"}', '{}', 'ok', '']) {
      exchange.mockResolvedValue({ status: 200, body })

      const failure = await failureOf(service.run('acme-pos', ENDPOINT))

      expect(failure.code).toBe(ErrorCodes.PLUGIN_CHALLENGE_FAILED)
      expect(failure.statusCode).toBe(HttpStatusCodes.PRECONDITION_FAILED)
      expect(failure.metadata).toEqual({ failure: ChallengeFailures.WRONG_ANSWER })
    }
  })

  it('fails for an address that is not on the public internet, and says so in a fixed word', async () => {
    exchange.mockRejectedValue(new UnsafeUrlError('its host is not on the public internet'))

    const failure = await failureOf(service.run('acme-pos', 'https://intranet.acme.com/x'))

    expect(failure.code).toBe(ErrorCodes.PLUGIN_CHALLENGE_FAILED)
    expect(failure.metadata).toEqual({ failure: ChallengeFailures.NOT_PUBLIC })
  })

  it('fails when the endpoint cannot be reached or does not answer 2xx, without repeating what it said', async () => {
    for (const error of [
      new PinnedExchangeFailed(PinnedExchangeReasons.BAD_STATUS, 500),
      new PinnedExchangeFailed(`${PinnedExchangeReasons.NO_ANSWER}:ECONNRESET`),
      new Error('secret=abc')
    ]) {
      exchange.mockRejectedValue(error)

      const failure = await failureOf(service.run('acme-pos', ENDPOINT))

      expect(failure.metadata).toEqual({ failure: ChallengeFailures.NO_ANSWER })
      expect(JSON.stringify([failure.message, failure.metadata])).not.toContain('secret')
    }
  })

  it('logs why, with the plugin and never the answer', async () => {
    exchange.mockResolvedValue({ status: 200, body: '{"challenge":"stolen-secret"}' })

    await failureOf(service.run('acme-pos', ENDPOINT))

    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [context] = logger.warn.mock.calls[0] as [Record<string, unknown>]
    expect(context).toMatchObject({ pluginId: 'acme-pos', failure: ChallengeFailures.WRONG_ANSWER })
    expect(JSON.stringify(context)).not.toContain('stolen-secret')
  })
})
