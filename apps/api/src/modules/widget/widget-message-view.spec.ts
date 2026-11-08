import { WIDGET_FILES_SELECT, widgetMessageView } from './widget-message-view'

const file = (id: string, position: number | null, caption: string | null) => ({
  id,
  filename: `${id}.png`,
  contentType: 'image/png',
  fileSize: 3,
  position,
  caption
})

const row = (media: ReturnType<typeof file>[], content: string | null = null) => ({
  id: 'm1',
  content,
  authorType: 'agent',
  createdAt: new Date('2026-11-08T10:00:00Z'),
  media
})

describe('widgetMessageView', () => {
  it('gives each file its own text, the first one included, so the visitor never guesses', () => {
    const view = widgetMessageView(
      row([file('a', 0, 'uno'), file('b', 1, 'dos'), file('c', 2, null)], 'uno')
    )

    expect(view?.attachments.map(attachment => attachment.caption)).toEqual(['uno', 'dos', null])
  })

  it('shows the text of the message under no file when its first file is not delivered', () => {
    const view = widgetMessageView(row([file('b', 1, 'dos')], 'uno'))

    expect(view?.content).toBe('')
    expect(view?.attachments.map(attachment => attachment.caption)).toEqual(['dos'])
  })

  it('keeps the text of the message for a message sent before the columns (no places)', () => {
    const view = widgetMessageView(row([file('a', null, null), file('b', null, null)], 'uno'))

    expect(view?.content).toBe('uno')
    expect(view?.attachments.map(attachment => attachment.caption)).toEqual([null, null])
  })

  it('leaves the content as it is when the message has no files', () => {
    expect(widgetMessageView(row([], 'hola'))?.content).toBe('hola')
  })
})

describe('WIDGET_FILES_SELECT', () => {
  it('asks the database for the place and the text of each file, in the order the agent chose', () => {
    expect(WIDGET_FILES_SELECT.select).toMatchObject({ position: true, caption: true })
    expect(WIDGET_FILES_SELECT.orderBy[0]).toEqual({ position: { sort: 'asc', nulls: 'last' } })
  })
})
