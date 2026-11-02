import { badgeLabel, notificationTextKeys, safeActionPath } from './notification-text'

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

  it.each([null, '', '//evil.test', 'https://evil.test', 'javascript:alert(1)', '/\\evil.test'])(
    'refuses %s',
    path => {
      expect(safeActionPath(path)).toBeNull()
    }
  )
})
