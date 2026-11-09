import { pluginNameOf } from './plugin-name'

const descriptor = { displayName: { es: 'Chat Acme', en: 'Acme Chat' } }

describe('pluginNameOf', () => {
  it('names the channel from its descriptor, in the language of the reader', () => {
    expect(pluginNameOf(descriptor, 'es', 'The server name')).toBe('Chat Acme')
    expect(pluginNameOf(descriptor, 'en', 'The server name')).toBe('Acme Chat')
  })

  it('reads a regional Spanish as Spanish', () => {
    expect(pluginNameOf(descriptor, 'es-MX', 'x')).toBe('Chat Acme')
  })

  it('takes English for a language the descriptor does not carry', () => {
    expect(pluginNameOf(descriptor, 'fr', 'x')).toBe('Acme Chat')
  })

  it('keeps the name of the server when there is no descriptor', () => {
    expect(pluginNameOf(null, 'es', 'The server name')).toBe('The server name')
    expect(pluginNameOf(undefined, 'en', 'The server name')).toBe('The server name')
  })
})
