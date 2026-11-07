import {
  isExpiryNoticeDue,
  isRecheckDue,
  lastAskedAt,
  readTokenAttemptAt,
  readTokenInfo,
  tokenInfoSchema,
  TokenInfoKeys,
  tokenExpiryOf,
  TokenExpiryLimits,
  TokenExpiryStates,
  type TokenInfo
} from './channel-token-expiry'

const NOW = new Date('2026-11-07T12:00:00.000Z')
const DAY = 86_400_000
const HOUR = 3_600_000
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString()
const info = (over: Partial<TokenInfo> = {}): TokenInfo => ({
  kind: 'page',
  isValid: true,
  expiresAt: at(30 * DAY),
  scopes: [],
  checkedAt: at(-HOUR),
  expiryNotifiedFor: null,
  ...over
})

describe('tokenExpiryOf', () => {
  it('says unknown when nothing was ever read', () => {
    expect(tokenExpiryOf(null, NOW)).toEqual({
      state: TokenExpiryStates.UNKNOWN,
      expiresAt: null,
      checkedAt: null,
      kind: 'unknown'
    })
  })

  it('tells a token that does not expire, one that will, one that has, and one that is not valid', () => {
    expect(tokenExpiryOf(info({ expiresAt: null }), NOW).state).toBe('never')
    expect(tokenExpiryOf(info(), NOW).state).toBe('expires')
    expect(tokenExpiryOf(info({ expiresAt: at(-1) }), NOW).state).toBe('expired')
    expect(tokenExpiryOf(info({ expiresAt: at(0) }), NOW).state).toBe('expired')
    // Not valid wins over any date
    expect(tokenExpiryOf(info({ isValid: false }), NOW).state).toBe('invalid')
    expect(tokenExpiryOf(info({ isValid: false, expiresAt: null }), NOW).state).toBe('invalid')
  })
})

describe('readTokenInfo', () => {
  it('reads what has the shape and takes anything else for no information', () => {
    expect(readTokenInfo({ tokenInfo: info() })).toEqual(info())
    for (const bad of [
      null,
      undefined,
      [],
      'x',
      {},
      { tokenInfo: 'x' },
      { tokenInfo: { ...info(), kind: 'robot' } },
      { tokenInfo: { ...info(), expiresAt: 'tomorrow' } },
      { tokenInfo: { ...info(), isValid: 'yes' } }
    ]) {
      expect(readTokenInfo(bad)).toBeNull()
    }
  })
})

describe('isExpiryNoticeDue', () => {
  const warn = TokenExpiryLimits.WARN_DAYS * DAY

  it('is due inside the warning time, and not before it or after the token stopped', () => {
    expect(isExpiryNoticeDue(info({ expiresAt: at(warn) }), NOW)).toBe(true)
    expect(isExpiryNoticeDue(info({ expiresAt: at(warn + 1000) }), NOW)).toBe(false)
    expect(isExpiryNoticeDue(info({ expiresAt: at(DAY) }), NOW)).toBe(true)
    expect(isExpiryNoticeDue(info({ expiresAt: at(0) }), NOW)).toBe(false)
    expect(isExpiryNoticeDue(info({ expiresAt: at(-DAY) }), NOW)).toBe(false)
  })

  it('is not due for a token that does not expire or is not valid', () => {
    expect(isExpiryNoticeDue(info({ expiresAt: null }), NOW)).toBe(false)
    expect(isExpiryNoticeDue(info({ isValid: false, expiresAt: at(DAY) }), NOW)).toBe(false)
  })

  it('announces a date once, and the next date again', () => {
    const date = at(2 * DAY)
    expect(isExpiryNoticeDue(info({ expiresAt: date, expiryNotifiedFor: date }), NOW)).toBe(false)
    expect(isExpiryNoticeDue(info({ expiresAt: date, expiryNotifiedFor: at(DAY) }), NOW)).toBe(true)
  })
})

describe('isRecheckDue', () => {
  it('asks what was never asked, and what was asked longer ago than its window', () => {
    expect(isRecheckDue(null, null, NOW)).toBe(true)
    expect(
      isRecheckDue(info({ checkedAt: at(-(TokenExpiryLimits.RECHECK_HOURS * HOUR)) }), null, NOW)
    ).toBe(true)
    expect(
      isRecheckDue(
        info({ checkedAt: at(-(TokenExpiryLimits.RECHECK_HOURS * HOUR - 1000)) }),
        null,
        NOW
      )
    ).toBe(false)
  })

  it('asks a token that does not expire less often, while the last question was answered', () => {
    const never = (hours: number): TokenInfo =>
      info({ expiresAt: null, checkedAt: at(-hours * HOUR) })
    expect(isRecheckDue(never(48), null, NOW)).toBe(false)
    expect(isRecheckDue(never(TokenExpiryLimits.RECHECK_NEVER_DAYS * 24), null, NOW)).toBe(true)
    // One that is not valid is asked about as often as any other: the person may have renewed it
    expect(
      isRecheckDue(info({ isValid: false, expiresAt: null, checkedAt: at(-21 * HOUR) }), null, NOW)
    ).toBe(true)
    // A question that failed after the last answer puts the token on the short window again
    expect(isRecheckDue(never(48), at(-21 * HOUR), NOW)).toBe(true)
  })

  it('counts a question that failed as asked, so it is not asked again at once', () => {
    expect(isRecheckDue(null, at(-HOUR), NOW)).toBe(false)
    expect(isRecheckDue(null, at(-(TokenExpiryLimits.RECHECK_HOURS * HOUR)), NOW)).toBe(true)
    expect(isRecheckDue(info({ checkedAt: at(-40 * HOUR) }), at(-HOUR), NOW)).toBe(false)
  })
})

describe('lastAskedAt and readTokenAttemptAt', () => {
  it('takes the later of the answer and the attempt, and null if there is none', () => {
    expect(lastAskedAt(null, null)).toBeNull()
    expect(lastAskedAt(info({ checkedAt: at(-DAY) }), at(-HOUR))).toBe(
      new Date(at(-HOUR)).getTime()
    )
    expect(lastAskedAt(info({ checkedAt: at(-HOUR) }), at(-DAY))).toBe(
      new Date(at(-HOUR)).getTime()
    )
  })

  it('reads the attempt from the metadata, and takes anything else for none', () => {
    expect(readTokenAttemptAt({ tokenAttemptAt: at(-HOUR) })).toBe(at(-HOUR))
    for (const bad of [null, [], {}, { tokenAttemptAt: 'yesterday' }, { tokenAttemptAt: 5 }]) {
      expect(readTokenAttemptAt(bad)).toBeNull()
    }
  })
})

describe('TokenInfoKeys', () => {
  it('are fields of the schema the SQL of the write relies on', () => {
    const fields = Object.keys(tokenInfoSchema.shape)
    for (const key of Object.values(TokenInfoKeys)) expect(fields).toContain(key)
  })
})
