import {
  CHANNEL_ID_PATTERN,
  channelIdSchema,
  ChannelIds,
  ChannelType,
  isOfficialChannelId,
  officialChannelSchema
} from './channel-ids'

describe('channel ids', () => {
  it('lists the five official channels', () => {
    expect(Object.values(ChannelIds).sort()).toEqual(
      ['email', 'instagram', 'messenger', 'web_widget', 'whatsapp'].sort()
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
