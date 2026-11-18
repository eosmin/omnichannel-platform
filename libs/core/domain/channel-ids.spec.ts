import {
  CHANNEL_ID_PATTERN,
  channelIdSchema,
  ChannelIds,
  ChannelHealthErrors,
  healthCodeOf,
  healthErrorOfReason,
  isOfficialChannelId
} from './channel-ids'

describe('channel ids', () => {
  it('lists the four official channels', () => {
    expect(Object.values(ChannelIds).sort()).toEqual(
      ['instagram', 'messenger', 'web_widget', 'whatsapp'].sort()
    )
  })

  it('accepts every official id as a well-formed id', () => {
    for (const id of Object.values(ChannelIds)) expect(id).toMatch(CHANNEL_ID_PATTERN)
  })

  it.each(['ab', 'Telegram', '1abc', 'a b c', 'a'.repeat(33), '', 'tele.gram'])(
    'rejects %j as an id',
    id => {
      expect(CHANNEL_ID_PATTERN.test(id)).toBe(false)
    }
  )

  it.each(['abc', 'a'.repeat(32), 'my-channel', 'my_channel2'])('accepts %j as an id', id => {
    expect(CHANNEL_ID_PATTERN.test(id)).toBe(true)
  })

  it('tells an official id from any other', () => {
    expect(isOfficialChannelId('whatsapp')).toBe(true)
    expect(isOfficialChannelId('telegram')).toBe(false)
    expect(isOfficialChannelId(undefined)).toBe(false)
  })

  it('channelIdSchema checks only the shape of an id', () => {
    expect(channelIdSchema.safeParse('telegram').success).toBe(true)
    expect(channelIdSchema.safeParse('Telegram!').success).toBe(false)
  })
})

describe('healthErrorOfReason', () => {
  it('keeps what the owner can fix as a verdict, and the plain failure for the rest', () => {
    expect(healthErrorOfReason('token_rejected')).toBe(ChannelHealthErrors.TOKEN_REJECTED)
    expect(healthErrorOfReason('provider_busy')).toBe(ChannelHealthErrors.CHECK_FAILED)
    expect(healthErrorOfReason(undefined)).toBe(ChannelHealthErrors.CHECK_FAILED)
  })

  it('treats a missing linked account, and its old name, as the plain failure: the login ends before a connection exists', () => {
    expect(healthErrorOfReason('linked_account_missing')).toBe(ChannelHealthErrors.CHECK_FAILED)
    expect(healthErrorOfReason('page_without_instagram')).toBe(ChannelHealthErrors.CHECK_FAILED)
  })

  it('never throws for a name it does not know: it is called from the catch of a health check', () => {
    expect(healthErrorOfReason('a_reason_of_a_newer_plugin' as never)).toBe(
      ChannelHealthErrors.CHECK_FAILED
    )
  })
})

describe('healthCodeOf', () => {
  it('says nothing for a connection with no failure', () => {
    expect(healthCodeOf(null)).toBeNull()
  })

  it('keeps every code of ours as it is', () => {
    for (const code of Object.values(ChannelHealthErrors)) expect(healthCodeOf(code)).toBe(code)
  })

  it('turns any text a plugin wrote into plugin_reported, whatever it says', () => {
    expect(healthCodeOf('Invalid OAuth access token - Cannot parse')).toBe(
      ChannelHealthErrors.PLUGIN_REPORTED
    )
    expect(healthCodeOf('Click https://evil.example to fix it')).toBe(
      ChannelHealthErrors.PLUGIN_REPORTED
    )
    // Looking like a code is not being one: only the exact names count
    expect(healthCodeOf('token_rejected ')).toBe(ChannelHealthErrors.PLUGIN_REPORTED)
    expect(healthCodeOf('TOKEN_REJECTED')).toBe(ChannelHealthErrors.PLUGIN_REPORTED)
  })
})
