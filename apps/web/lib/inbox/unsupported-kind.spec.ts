import { bubbleTextOf, unsupportedKindOf } from './unsupported-kind'

describe('unsupportedKindOf', () => {
  it.each([
    ['story_mention', 'storyMention'],
    ['share', 'share'],
    ['ig_post', 'share'],
    ['location', 'location'],
    ['image', 'media'],
    ['audio', 'media'],
    ['unsupported', 'other'],
    ['order', 'other'],
    ['something_new', 'other']
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
