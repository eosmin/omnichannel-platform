import en from '../messages/en.json'
import es from '../messages/es.json'

import { clientMessagesOf, SERVER_ONLY_MESSAGE_NAMESPACES } from './client-messages'

describe('clientMessagesOf', () => {
  it('leaves out the mail templates and keeps every other namespace', () => {
    const sent = clientMessagesOf({ email: { a: 'x' }, app: { title: 'T' }, orders: { x: 'y' } })
    expect(Object.keys(sent)).toEqual(['app', 'orders'])
  })

  it.each([
    ['en', en],
    ['es', es]
  ])('removes a real weight from the %s file and nothing a component reads', (_name, file) => {
    const sent = clientMessagesOf(file)
    for (const namespace of SERVER_ONLY_MESSAGE_NAMESPACES)
      expect(sent).not.toHaveProperty(namespace)
    expect(Object.keys(sent)).toHaveLength(
      Object.keys(file).length - SERVER_ONLY_MESSAGE_NAMESPACES.length
    )
  })
})
