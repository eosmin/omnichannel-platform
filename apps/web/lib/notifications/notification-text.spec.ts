import { badgeLabel, notificationTextKeys, safeActionPath } from './notification-text'

describe('notificationTextKeys with people', () => {
  const has = () => true
  const people = { author: 'Ana', customer: 'Lucia' }

  it('uses the text that names them when the notification carries them', () => {
    expect(notificationTextKeys('notifications.conversation.mentioned', has, people).body).toBe(
      'notifications.conversation.mentioned.bodyWithPeople'
    )
  })

  it('keeps the plain text for a notification saved without them, or a type without that text', () => {
    expect(notificationTextKeys('notifications.conversation.mentioned', has, {}).body).toBe(
      'notifications.conversation.mentioned.body'
    )
    expect(
      notificationTextKeys('notifications.export.ready', key => !key.endsWith('WithPeople'), people)
        .body
    ).toBe('notifications.export.ready.body')
  })
})

describe('notificationTextKeys with whose', () => {
  it('names the customer of a queue notification that carries it', () => {
    expect(
      notificationTextKeys('notifications.conversation.unassigned_queue', () => true, {
        customer: 'Lucia'
      }).body
    ).toBe('notifications.conversation.unassigned_queue.bodyWithCustomer')
  })

  it('keeps the plain text for one saved without the customer', () => {
    expect(
      notificationTextKeys('notifications.conversation.unassigned_queue', () => true, {}).body
    ).toBe('notifications.conversation.unassigned_queue.body')
  })
})

describe('notificationTextKeys with a reason', () => {
  const written = (key: string) =>
    key.endsWith('.reason.EXPORT_TOO_LARGE') || !key.includes('.reason.')

  it('uses the text written for the reason the notification carries', () => {
    expect(
      notificationTextKeys('notifications.export.failed', written, { reason: 'EXPORT_TOO_LARGE' })
        .body
    ).toBe('notifications.export.failed.reason.EXPORT_TOO_LARGE')
  })

  it('keeps the plain text for a reason with no text, no reason, or a value that is not a code', () => {
    const plain = 'notifications.export.failed.body'
    expect(
      notificationTextKeys('notifications.export.failed', written, { reason: 'SOMETHING_NEW' }).body
    ).toBe(plain)
    expect(notificationTextKeys('notifications.export.failed', written, {}).body).toBe(plain)
    expect(
      notificationTextKeys('notifications.export.failed', () => true, { reason: '../body' }).body
    ).toBe(plain)
    expect(
      notificationTextKeys('notifications.export.failed', () => true, { reason: 7 }).body
    ).toBe(plain)
    // A code with a digit is a code
    expect(
      notificationTextKeys('notifications.export.failed', () => true, { reason: 'E2E_REASON' }).body
    ).toBe('notifications.export.failed.reason.E2E_REASON')
  })
})

describe('notificationTextKeys', () => {
  it('uses the title and body of the key when both exist', () => {
    const keys = notificationTextKeys('notifications.export.ready', () => true)
    expect(keys).toEqual({
      title: 'notifications.export.ready.title',
      body: 'notifications.export.ready.body'
    })
  })

  it('falls back to the generic text when the key has no message', () => {
    const keys = notificationTextKeys('notifications.future.thing', () => false)
    expect(keys.title).toBe('notifications.unknown.title')
  })

  it('falls back when only one half exists', () => {
    const keys = notificationTextKeys('notifications.half', key => key.endsWith('.title'))
    expect(keys.body).toBe('notifications.unknown.body')
  })
})

describe('badgeLabel', () => {
  it.each([
    [0, '0'],
    [99, '99'],
    [100, '99+'],
    [4000, '99+']
  ])('shows %i as %s', (count, label) => {
    expect(badgeLabel(count)).toBe(label)
  })
})

describe('safeActionPath', () => {
  it('keeps a path of the app', () => {
    expect(safeActionPath('/s/1/exports')).toBe('/s/1/exports')
  })

  it('keeps a path with a query and a hash', () => {
    expect(safeActionPath('/s/1/inbox/2?tab=notes#top')).toBe('/s/1/inbox/2?tab=notes#top')
  })

  it('keeps a path with an encoded slash in the query and one with accents', () => {
    expect(safeActionPath('/s/1/inbox?next=%2Finbox')).toBe('/s/1/inbox?next=%2Finbox')
    expect(safeActionPath('/s/1/tags/café')).toBe('/s/1/tags/café')
  })

  it.each([
    ['null', null],
    ['empty', ''],
    ['not a path', 'inbox'],
    ['protocol-relative', '//evil.test'],
    ['another origin', 'https://evil.test'],
    ['a scheme', 'javascript:alert(1)'],
    ['a backslash', '/\\evil.test'],
    ['a tab (the browser drops it: "//evil.test")', '/\t/evil.test'],
    ['a line feed', '/\n/evil.test'],
    ['a carriage return', '/\r/evil.test'],
    ['a NUL', '/\u0000/evil.test'],
    ['a C1 control', '/\u0085/evil.test'],
    ['a space', '/ /evil.test'],
    ['a zero-width space', '/\u200b/evil.test'],
    ['a bidi override', '/s/\u202eexe'],
    ['an encoded slash', '/%2f/evil.test'],
    ['an encoded backslash', '/%5Cevil.test'],
    ['a dot segment', '/s/../../evil'],
    ['an encoded dot segment', '/s/%2e%2e/evil'],
    ['a tab after the query mark', '/?\t//evil.test']
  ])('refuses %s', (_name, path) => {
    expect(safeActionPath(path)).toBeNull()
  })
})
