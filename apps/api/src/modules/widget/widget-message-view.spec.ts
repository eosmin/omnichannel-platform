import { WIDGET_FILES_SELECT, widgetMessageView } from './widget-message-view'

const file = (id: string, position: number | null) => ({
  id,
  filename: `${id}.png`,
  contentType: 'image/png',
  fileSize: 3,
  position
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

describe('WIDGET_FILES_SELECT', () => {
  it('asks the database for the place of each file, in the order the agent chose, and no text', () => {
    expect(WIDGET_FILES_SELECT.select).toMatchObject({ position: true })
    expect(WIDGET_FILES_SELECT.select).not.toHaveProperty('caption')
    expect(WIDGET_FILES_SELECT.orderBy[0]).toEqual({ position: { sort: 'asc', nulls: 'last' } })
  })
})
