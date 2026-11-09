import { bubbleTextOf, unsupportedKindOf } from './unsupported-kind'

describe('unsupportedKindOf', () => {
  // One sentence for everything a channel does not let the team see; only a file that could not be fetched differs.
  // No name of a channel or of a form of one provider is known here.
  it.each([
    ['image', 'media'],
    ['audio', 'media'],
    ['sticker', 'media'],
    ['story_mention', 'notice'],
    ['ig_post', 'notice'],
    ['location', 'notice'],
    ['unsupported', 'notice'],
    ['order', 'notice'],
    ['something_new', 'notice']
  ])('names %s as %s', (type, kind) => {
    expect(unsupportedKindOf(type)).toBe(kind)
  })
})

describe('bubbleTextOf', () => {
  const message = { content: 'hola', hasLocation: false, unsupportedType: null }

  it('draws the words of an ordinary message', () => {
    expect(bubbleTextOf(message)).toBe('hola')
  })

  it.each([
    ['no content', { content: null }],
    ['an empty content', { content: '' }],
    ['a location, which has its card', { hasLocation: true }],
    [
      'the marker of a type it cannot read, which is a sentence',
      { content: '[story_mention]', unsupportedType: 'story_mention' }
    ]
  ])('draws no words for %s', (_name, over) => {
    expect(bubbleTextOf({ ...message, ...over })).toBeNull()
  })

  it('does not repeat the names of a shared contact, which its cards show', () => {
    expect(
      bubbleTextOf({
        content: 'Ana, Beto',
        hasLocation: false,
        hasContacts: true,
        unsupportedType: null
      })
    ).toBeNull()
    expect(
      bubbleTextOf({
        content: 'Ana, Beto',
        hasLocation: false,
        hasContacts: false,
        unsupportedType: null
      })
    ).toBe('Ana, Beto')
  })
})
