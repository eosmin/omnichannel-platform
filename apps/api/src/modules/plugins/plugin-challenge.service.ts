import { randomBytes } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PluginInstallLimits } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import {
  PinnedExchangeFailed,
  pinnedHttpsExchange,
  UnsafeUrlError
} from '@platform/core/url-safety'

import { challengeBody, isChallengeAnswered } from './plugin-install-rules'

// The reason is kept for the log and never sent back with what the other side said: the owner is told only that the address did
// not pass, and why in a fixed word
export const ChallengeFailures = {
  NOT_PUBLIC: 'not_public',
  NO_ANSWER: 'no_answer',
  WRONG_ANSWER: 'wrong_answer'
} as const

// Before the platform trusts the webhook endpoint of a plugin it asks it for something only the plugin's side could answer
// (TDD_10 §6.3): a POST with a fresh random value, to be echoed. The address is resolved now and the connection goes to the
// address that was checked (a name that leads to a private address, or changes after the check, is refused), no redirect is
// followed and the answer is read up to a ceiling.
@Injectable()
export class PluginChallengeService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(PluginChallengeService.name)
  }

  async run(pluginId: string, endpoint: string): Promise<void> {
    const challenge = randomBytes(PluginInstallLimits.CHALLENGE_BYTES).toString('base64url')
    let answer: string
    try {
      const result = await pinnedHttpsExchange(endpoint, {
        body: challengeBody(pluginId, challenge),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        timeoutMs: PluginInstallLimits.CHALLENGE_TIMEOUT_MS,
        maxResponseBytes: PluginInstallLimits.CHALLENGE_MAX_RESPONSE_BYTES
      })
      answer = result.body
    } catch (error) {
      if (error instanceof UnsafeUrlError) this.fail(pluginId, ChallengeFailures.NOT_PUBLIC)
      const reason = error instanceof PinnedExchangeFailed ? error.reason : 'unknown'
      this.fail(pluginId, ChallengeFailures.NO_ANSWER, reason)
    }
    if (!isChallengeAnswered(answer, challenge)) this.fail(pluginId, ChallengeFailures.WRONG_ANSWER)
  }

  private fail(pluginId: string, failure: string, detail?: string): never {
    this.logger.warn({ pluginId, failure, detail }, 'a plugin did not pass the install challenge')
    throw new PlatformException(
      ErrorCodes.PLUGIN_CHALLENGE_FAILED,
      'the webhook endpoint of the plugin did not answer the check',
      HttpStatusCodes.PRECONDITION_FAILED,
      { failure }
    )
  }
}
