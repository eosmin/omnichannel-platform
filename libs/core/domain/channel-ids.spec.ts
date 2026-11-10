import {
  CHANNEL_ID_PATTERN,
  channelIdSchema,
  ChannelIds,
  ChannelHealthErrors,
  ChannelType,
  healthErrorOfReason,
  isOfficialChannelId,
  officialChannelSchema
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

  it('keeps ChannelType as the official ids', () => {
    expect(ChannelType).toBe(ChannelIds)
  })

  it('channelIdSchema checks only the shape of an id', () => {
    expect(channelIdSchema.safeParse('telegram').success).toBe(true)
    expect(channelIdSchema.safeParse('Telegram!').success).toBe(false)
  })

  it('officialChannelSchema takes the official ids only', () => {
    expect(officialChannelSchema.safeParse('whatsapp').success).toBe(true)
    expect(officialChannelSchema.safeParse('telegram').success).toBe(false)
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
