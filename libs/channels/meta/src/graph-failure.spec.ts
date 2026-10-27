import { ErrorCodes } from '@platform/core/errors'

import { graphFailure } from './graph-failure'

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
})
