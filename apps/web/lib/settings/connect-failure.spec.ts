import { ApiError } from '@platform/api-client'
import { ChannelConnectFailureReasons } from '@platform/core/errors'

import { connectFailureReasonOf, isTokenFailure } from './connect-failure'

const refusal = (
  metadata: Record<string, unknown>,
  code = 'CHANNEL_CREDENTIALS_INVALID'
): ApiError => new ApiError(400, code, 'x', null, metadata)

describe('connectFailureReasonOf', () => {
  it.each(Object.values(ChannelConnectFailureReasons))(
    'reads the reason %s of a refused connection',
    reason => {
      expect(connectFailureReasonOf(refusal({ reason }))).toBe(reason)
    }
  )

  it.each([
    [
      'a reason this page does not know yet (a server newer than the page)',
      refusal({ reason: 'something_new' })
    ],
    ['a reason that is text with markup', refusal({ reason: '<b>call 555</b>' })],
    ['a reason that is not text', refusal({ reason: 7 })],
    ['no reason', refusal({})],
    [
      'another code, even with a reason of the list',
      refusal({ reason: 'token_rejected' }, 'VALIDATION_FAILED')
    ],
    ['an error that is not of the api', new TypeError('token_rejected')]
  ])('is nothing for %s, so the generic message shows', (_name, error) => {
    expect(connectFailureReasonOf(error)).toBeNull()
  })
})

describe('isTokenFailure', () => {
  it.each([
    ChannelConnectFailureReasons.TOKEN_MALFORMED,
    ChannelConnectFailureReasons.TOKEN_REJECTED,
    ChannelConnectFailureReasons.PERMISSION_MISSING,
    ChannelConnectFailureReasons.REQUEST_REJECTED
  ])('says %s is for the token field, which the focus goes back to', reason => {
    expect(isTokenFailure(reason)).toBe(true)
  })

  it.each([
    ChannelConnectFailureReasons.PROVIDER_BUSY,
    ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE,
    ChannelConnectFailureReasons.ACCOUNT_NOT_LINKED,
    ChannelConnectFailureReasons.OTHER_ACCOUNT
  ])('says %s is not: the token may be right and the field needs no attention', reason => {
    expect(isTokenFailure(reason)).toBe(false)
  })

  it('is false for no reason', () => {
    expect(isTokenFailure(null)).toBe(false)
  })
})
