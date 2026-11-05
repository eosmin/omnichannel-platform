import { bubbleTextOf, UnsupportedKinds, unsupportedKindOf } from './unsupported-kind'

describe('unsupportedKindOf', () => {
  it.each([
    ['story_mention', UnsupportedKinds.STORY_MENTION],
    ['share', UnsupportedKinds.SHARE],
    ['ig_post', UnsupportedKinds.SHARE],
    ['location', UnsupportedKinds.LOCATION],
    ['image', UnsupportedKinds.MEDIA],
    ['audio', UnsupportedKinds.MEDIA],
    ['unsupported', UnsupportedKinds.OTHER],
    ['order', UnsupportedKinds.OTHER],
    ['something_new', UnsupportedKinds.OTHER]
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
})
