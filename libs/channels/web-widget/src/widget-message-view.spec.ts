import { WIDGET_FILES_SELECT, widgetMessageView } from './widget-message-view'

const file = (id: string, position: number | null) => ({
  id,
  filename: `${id}.png`,
  contentType: 'image/png',
  fileSize: 3,
  position,
  scanResult: null as unknown
})

const video = (id: string, position: number | null, scanResult: unknown) => ({
  ...file(id, position),
  filename: `${id}.mp4`,
  contentType: 'video/mp4',
  scanResult
})

const row = (media: ReturnType<typeof file>[], content: string | null = null) => ({
  id: 'm1',
  content,
  authorType: 'agent',
  createdAt: new Date('2026-11-08T10:00:00Z'),
  media
})

describe('widgetMessageView', () => {
  it('gives the one text of the message and the files, with no text of their own', () => {
    const view = widgetMessageView(row([file('a', 0), file('b', 1)], 'uno'))

    expect(view?.content).toBe('uno')
    expect(view?.attachments).toEqual([
      { id: 'a', filename: 'a.png', contentType: 'image/png', size: 3 },
      { id: 'b', filename: 'b.png', contentType: 'image/png', size: 3 }
    ])
  })

  it('shows the text of the message under no file when its first file is not delivered', () => {
    const view = widgetMessageView(row([file('b', 1)], 'uno'))

    expect(view?.content).toBe('')
  })

  it('keeps the text of the message for a message sent before the places', () => {
    const view = widgetMessageView(row([file('a', null), file('b', null)], 'uno'))

    expect(view?.content).toBe('uno')
  })

  it('leaves the content as it is when the message has no files', () => {
    expect(widgetMessageView(row([], 'hola'))?.content).toBe('hola')
  })
})

describe('a file the platform could not clean of its metadata', () => {
  it('is not given to the visitor when a video was kept as it came', () => {
    const kept = video('v', 0, { avCleaning: 'untouched' })

    expect(widgetMessageView(row([kept], 'hola'))?.attachments).toEqual([])
  })

  it('is not given to the visitor when a video has no mark of the cleaning', () => {
    expect(widgetMessageView(row([video('v', 0, null)], 'hola'))?.attachments).toEqual([])
    expect(widgetMessageView(row([video('v', 0, { viruses: [] })], 'hola'))?.attachments).toEqual(
      []
    )
  })

  it('is given when the video carries the mark of the cleaning', () => {
    const view = widgetMessageView(row([video('v', 0, { sanitized: true })], 'hola'))

    expect(view?.attachments.map(a => a.id)).toEqual(['v'])
  })

  it('is given back to the visitor who sent it', () => {
    const own = {
      ...row([video('v', 0, { avCleaning: 'untouched' })], 'hola'),
      authorType: 'customer'
    }

    expect(widgetMessageView(own)?.attachments.map(a => a.id)).toEqual(['v'])
  })

  it('leaves a message of only such files with nothing to show', () => {
    expect(widgetMessageView(row([video('v', 0, null)]))).toBeNull()
  })

  it('does not show the text under another file when the first one is hidden', () => {
    const view = widgetMessageView(row([video('v', 0, null), file('b', 1)], 'uno'))

    expect(view?.content).toBe('')
    expect(view?.attachments.map(a => a.id)).toEqual(['b'])
  })
})

describe('WIDGET_FILES_SELECT', () => {
  it('reads what the rule of the files that may leave needs', () => {
    expect(WIDGET_FILES_SELECT.select).toMatchObject({ contentType: true, scanResult: true })
  })

  it('asks the database for the place of each file, in the order the agent chose, and no text', () => {
    expect(WIDGET_FILES_SELECT.select).toMatchObject({ position: true })
    expect(WIDGET_FILES_SELECT.select).not.toHaveProperty('caption')
    expect(WIDGET_FILES_SELECT.orderBy[0]).toEqual({ position: { sort: 'asc', nulls: 'last' } })
  })
})
