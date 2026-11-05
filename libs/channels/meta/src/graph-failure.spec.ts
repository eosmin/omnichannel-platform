import { ChannelConnectFailureReasons, ErrorCodes } from '@platform/core/errors'

import { graphFailure, graphUnexpected, graphUnreachable } from './graph-failure'

const graphError = (code: number): unknown => ({
  error: { message: 'secret-token-echo', type: 'OAuthException', code, fbtrace_id: 'trace' }
})

describe('graphFailure', () => {
  it.each([190, 10, 200, 250, 299])('says the credentials are invalid for Graph code %i', code => {
    const error = graphFailure(400, graphError(code))
    expect(error.code).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
    expect(error.retryable).toBe(false)
  })

  it.each([4, 17, 80008, 2])(
    'asks to try again for the code %i even when Meta answers it with HTTP 403',
    code => {
      const error = graphFailure(403, graphError(code))
      expect(error.code).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
      expect(error.retryable).toBe(true)
    }
  )

  it('says there is no profile, for good, when Meta has none to show', () => {
    const error = graphFailure(400, graphError(2018218))
    expect(error.code).toBe(ErrorCodes.CHANNEL_PROFILE_UNAVAILABLE)
    expect(error.retryable).toBe(false)
  })

  it.each([401, 403])('says the credentials are invalid for HTTP %i', status => {
    expect(graphFailure(status, null).code).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
  })

  it.each([4, 17, 32, 613, 80008])('asks to try again after the throttle code %i', code => {
    const error = graphFailure(400, graphError(code))
    expect(error.code).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
    expect(error.retryable).toBe(true)
  })

  it.each([408, 425])('asks to try again a read after HTTP %i', status => {
    expect(graphFailure(status, null).retryable).toBe(true)
    expect(graphFailure(status, null, { safeToRepeat: false }).retryable).toBe(false)
  })

  it.each([429, 500, 503])('asks to try again after HTTP %i', status => {
    expect(graphFailure(status, null).retryable).toBe(true)
  })

  it('asks to try again after a temporary Meta failure', () => {
    expect(graphFailure(400, graphError(2)).retryable).toBe(true)
  })

  it('does not ask to try again for a request Meta refuses on its merits', () => {
    const error = graphFailure(400, graphError(100))
    expect(error.code).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
    expect(error.retryable).toBe(false)
  })

  it('survives a body that is not a Graph error', () => {
    expect(graphFailure(400, '<html>').retryable).toBe(false)
    expect(graphFailure(400, { error: 'x' }).retryable).toBe(false)
  })

  it('keeps nothing of what Meta said', () => {
    const error = graphFailure(400, graphError(190))
    expect(JSON.stringify(error)).not.toContain('secret-token-echo')
    expect(error.message).not.toContain('secret-token-echo')
  })

  it('reads an outage before a permission code: a 5xx with code 200 is not a bad token', () => {
    const error = graphFailure(503, graphError(200))
    expect(error.code).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
    expect(error.retryable).toBe(true)
  })

  it.each([130429, 131056])('asks to try again after the WhatsApp throttle %i', code => {
    expect(graphFailure(400, graphError(code)).retryable).toBe(true)
  })

  it('asks to try again after the WhatsApp outage 131016', () => {
    expect(graphFailure(400, graphError(131016)).retryable).toBe(true)
  })

  describe('for a call that is not safe to repeat (a send)', () => {
    const send = { safeToRepeat: false }

    it.each([
      ['a 500', 500, null],
      ['a 503', 503, null],
      ['an outage code', 400, graphError(2)],
      ['a WhatsApp outage code', 400, graphError(131016)]
    ])('does not try again after %s: the message may already be out', (_name, status, body) => {
      expect(graphFailure(status, body, send).retryable).toBe(false)
    })

    it.each([
      ['a 429', 429, null],
      ['a throttle code', 400, graphError(80008)],
      ['a WhatsApp throttle', 400, graphError(130429)]
    ])('still tries again after %s: Meta did not do the work', (_name, status, body) => {
      expect(graphFailure(status, body, send).retryable).toBe(true)
    })

    it('still says the credentials are invalid', () => {
      expect(graphFailure(400, graphError(190), send).code).toBe(
        ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      )
    })
  })

  it.each([132001, 132015, 132016])(
    'says a template that cannot be sent (%i) is not approved, for good',
    code => {
      const error = graphFailure(400, { error: { code } })
      expect(error.code).toBe(ErrorCodes.CHANNEL_TEMPLATE_NOT_APPROVED)
      expect(error.retryable).toBe(false)
    }
  )
})

describe('the outcome of a send that got no clear answer', () => {
  it.each([500, 503])('is unknown after HTTP %i of a call that changes something', status => {
    const error = graphFailure(status, null, { safeToRepeat: false })
    expect(error.outcomeUnknown).toBe(true)
    expect(error.retryable).toBe(false)
  })

  it('is unknown after an outage code of a send, and not for a read', () => {
    expect(graphFailure(400, graphError(2), { safeToRepeat: false }).outcomeUnknown).toBe(true)
    expect(graphFailure(400, graphError(2)).outcomeUnknown).toBe(false)
  })

  it('is known after a refusal or a throttle: Meta did not do the work', () => {
    expect(graphFailure(400, graphError(100), { safeToRepeat: false }).outcomeUnknown).toBe(false)
    expect(graphFailure(429, null, { safeToRepeat: false }).outcomeUnknown).toBe(false)
    expect(graphFailure(403, null, { safeToRepeat: false }).outcomeUnknown).toBe(false)
  })

  it('is unknown when a send got no answer at all', () => {
    expect(graphUnreachable({ safeToRepeat: false }).outcomeUnknown).toBe(true)
    expect(graphUnreachable().outcomeUnknown).toBe(false)
  })
})

describe('graphFailure, what it keeps of the answer for the logs', () => {
  const answer = (code: number, subcode?: number): unknown => ({
    error: {
      message: 'Bearer secret-token-echo',
      type: 'OAuthException',
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      fbtrace_id: 'trace'
    }
  })

  it('carries the numeric code and subcode of Graph, and nothing else of the answer', () => {
    const error = graphFailure(400, answer(100, 2494073))

    expect(error.providerCode).toBe(100)
    expect(error.providerSubcode).toBe(2494073)
    expect(JSON.stringify(error)).not.toContain('secret-token-echo')
    expect(String(error.message)).not.toContain('secret-token-echo')
  })

  it('keeps the code when there is no subcode, and nothing when the body is not a Graph error', () => {
    expect(graphFailure(400, answer(131053)).providerSubcode).toBeUndefined()
    expect(graphFailure(400, answer(131053)).providerCode).toBe(131053)
    expect(graphFailure(500, 'html page').providerCode).toBeUndefined()
  })

  it('carries them for every kind of failure it classifies', () => {
    expect(graphFailure(400, answer(190)).providerCode).toBe(190)
    expect(graphFailure(400, answer(131047)).providerCode).toBe(131047)
    expect(graphFailure(400, answer(4)).providerCode).toBe(4)
  })
})

// The reason that reaches the person when connecting a channel fails: a name of a closed list, chosen from
// the numbers of Meta's answer and never from its words
describe('the reason a Graph failure gives', () => {
  it.each([
    [190, 400],
    [190, 401]
  ])('says the token was refused for the Graph code %i (HTTP %i)', (code, status) => {
    expect(graphFailure(status, graphError(code)).reason).toBe(
      ChannelConnectFailureReasons.TOKEN_REJECTED
    )
  })

  it.each([102, 104, 3])(
    'says the token was refused for HTTP 401 with the code %i: a 401 is the token',
    code => {
      expect(graphFailure(401, graphError(code)).reason).toBe(
        ChannelConnectFailureReasons.TOKEN_REJECTED
      )
    }
  )

  it('says the token was refused for HTTP 401 with no readable answer', () => {
    expect(graphFailure(401, null).reason).toBe(ChannelConnectFailureReasons.TOKEN_REJECTED)
  })

  it.each([10, 200, 250, 299])('says a permission is missing for the Graph code %i', code => {
    expect(graphFailure(400, graphError(code)).reason).toBe(
      ChannelConnectFailureReasons.PERMISSION_MISSING
    )
  })

  it('says a permission is missing for HTTP 403 with no readable answer', () => {
    expect(graphFailure(403, null).reason).toBe(ChannelConnectFailureReasons.PERMISSION_MISSING)
  })

  it('says the request was refused for the Graph code 100', () => {
    expect(graphFailure(400, graphError(100)).reason).toBe(
      ChannelConnectFailureReasons.REQUEST_REJECTED
    )
  })

  it.each([4, 17, 32, 613, 80008, 130429])('asks to wait for the throttle code %i', code => {
    expect(graphFailure(400, graphError(code)).reason).toBe(
      ChannelConnectFailureReasons.PROVIDER_BUSY
    )
  })

  it.each([
    [500, undefined],
    [502, undefined],
    [408, undefined],
    [400, 1],
    [400, 131000]
  ])('says Meta is unavailable for HTTP %i and code %p', (status, code) => {
    const body = code === undefined ? null : graphError(code)
    expect(graphFailure(status, body).reason).toBe(
      ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE
    )
  })

  it('says nothing for a code it has no words for', () => {
    expect(graphFailure(400, graphError(9999)).reason).toBeUndefined()
  })

  it('says Meta is unavailable when it gave no answer, and its answer was unexpected when it was not one', () => {
    expect(graphUnreachable().reason).toBe(ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE)
    expect(graphUnexpected().reason).toBe(ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED)
  })

  it('never carries the words of the answer, which can echo the token it was called with', () => {
    const error = graphFailure(400, graphError(190))
    expect(JSON.stringify([error.message, error.reason, error.metadata])).not.toContain(
      'secret-token-echo'
    )
  })

  describe('which answer wins when the status and the code disagree', () => {
    it('reads a refused token for HTTP 403 with the code 190: the code is the token', () => {
      expect(graphFailure(403, graphError(190)).reason).toBe(
        ChannelConnectFailureReasons.TOKEN_REJECTED
      )
    })

    it('reads a throttle for HTTP 401 with a throttle code: Meta did not do the work, wait', () => {
      expect(graphFailure(401, graphError(4)).reason).toBe(
        ChannelConnectFailureReasons.PROVIDER_BUSY
      )
    })

    it('reads an outage for HTTP 500 with the code 190: the server side is read before the credentials', () => {
      expect(graphFailure(500, graphError(190)).reason).toBe(
        ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE
      )
    })

    it.each([199, 300])('has no reason for the code %i, outside the permission range', code => {
      expect(graphFailure(400, graphError(code)).reason).toBeUndefined()
    })
  })
})
