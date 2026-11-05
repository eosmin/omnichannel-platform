import { MetaSubscription } from '@platform/core/domain'

import { mergeSubscribedFields, readSubscribedFields } from './meta-subscription'

const APP = '1804256354142951'

// The answer of Meta for a Page that has our app, as the owner's Page returned it (no `category`)
const messenger = {
  link: 'https://www.facebook.com/games/?app_id=1804256354142951',
  name: 'omnichannel-dev',
  id: APP,
  subscribed_fields: [
    'messages',
    'message_echoes',
    'message_reactions',
    'message_edits',
    'messaging_referrals'
  ]
}

describe('readSubscribedFields', () => {
  it('reads the fields of our app, whatever else the entry carries', () => {
    expect(readSubscribedFields({ data: [messenger] }, APP)).toEqual(messenger.subscribed_fields)
    expect(readSubscribedFields({ data: [{ ...messenger, category: 'Business' }] }, APP)).toEqual(
      messenger.subscribed_fields
    )
  })

  it('has none for a Page with no apps, or where our app is not', () => {
    expect(readSubscribedFields({ data: [] }, APP)).toEqual([])
    expect(
      readSubscribedFields({ data: [{ id: '999', subscribed_fields: ['feed'] }] }, APP)
    ).toEqual([])
  })

  it('has none for our app when it has no list yet', () => {
    expect(readSubscribedFields({ data: [{ id: APP }] }, APP)).toEqual([])
  })

  it('never reads the fields of another app', () => {
    const answer = {
      data: [{ id: '999', subscribed_fields: ['feed', 'leadgen'] }, messenger]
    }
    expect(readSubscribedFields(answer, APP)).toEqual(messenger.subscribed_fields)
  })

  it('does not let an entry of another app that is badly shaped break the read', () => {
    const answer = {
      data: ['junk', null, { id: 5 }, { id: '999', subscribed_fields: 'x' }, messenger]
    }
    expect(readSubscribedFields(answer, APP)).toEqual(messenger.subscribed_fields)
  })

  it.each([
    ['no data', {}],
    ['data that is not a list', { data: {} }],
    ['an answer that is not an object', 'oops'],
    ['null', null],
    [
      'our entry with a list that is not a list',
      { data: [{ id: APP, subscribed_fields: 'messages' }] }
    ],
    ['our entry with a field that is not text', { data: [{ id: APP, subscribed_fields: [1] }] }]
  ])('refuses %s as an unexpected shape', (_name, answer) => {
    expect(readSubscribedFields(answer, APP)).toBeNull()
  })

  it.each([['../x'], ['Messages'], ['a,b'], ['x y'], ['']])(
    'refuses our entry when a field is %j: it cannot be sent back, and dropping it would unsubscribe it',
    name => {
      const answer = { data: [{ id: APP, subscribed_fields: ['messages', name] }] }
      expect(readSubscribedFields(answer, APP)).toBeNull()
    }
  )

  it('accepts a field name with a digit', () => {
    const answer = { data: [{ id: APP, subscribed_fields: ['messages', 'game_plays2'] }] }
    expect(readSubscribedFields(answer, APP)).toEqual(['messages', 'game_plays2'])
  })

  it('refuses an answer where our app is not found but there is more of it to read', () => {
    const more = {
      data: [{ id: '999', subscribed_fields: ['feed'] }],
      paging: { next: 'https://x' }
    }
    expect(readSubscribedFields(more, APP)).toBeNull()
    // Found in the part that was read: the rest does not matter
    expect(readSubscribedFields({ ...more, data: [...more.data, messenger] }, APP)).toEqual(
      messenger.subscribed_fields
    )
  })

  it('refuses a list longer than any Page has', () => {
    const many = Array.from({ length: MetaSubscription.MAX_FIELDS + 1 }, () => 'messages')
    expect(readSubscribedFields({ data: [{ id: APP, subscribed_fields: many }] }, APP)).toBeNull()
  })
})

describe('mergeSubscribedFields', () => {
  it('keeps what the app has and adds what the channel asks for, once', () => {
    expect(
      mergeSubscribedFields(
        messenger.subscribed_fields,
        'messages,message_reactions,messaging_referral'
      )
    ).toBe(
      'messages,message_echoes,message_reactions,message_edits,messaging_referrals,messaging_referral'
    )
  })

  it('is the same union in either order (as a set) and when repeated', () => {
    const instagram = 'messages,message_reactions,messaging_referral'
    const fromMessenger = mergeSubscribedFields(messenger.subscribed_fields, instagram)
    const fromInstagram = mergeSubscribedFields(
      instagram.split(','),
      messenger.subscribed_fields.join(',')
    )
    expect(new Set(fromMessenger.split(','))).toEqual(new Set(fromInstagram.split(',')))
    expect(mergeSubscribedFields(fromMessenger.split(','), instagram)).toBe(fromMessenger)
  })

  it('asks for its own fields on a Page where the app has none', () => {
    expect(mergeSubscribedFields([], 'messages,message_reactions')).toBe(
      'messages,message_reactions'
    )
  })

  it('does not put into the list a name that is not a name of a field', () => {
    expect(mergeSubscribedFields(['messages'], 'message_reactions,../x,A b')).toBe(
      'messages,message_reactions'
    )
  })
})
