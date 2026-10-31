import { mentionSegments } from './mention-segments'

describe('mentionSegments', () => {
  it('is one plain part without names', () => {
    expect(mentionSegments('hello @Ana', [])).toEqual([{ text: 'hello @Ana', isMention: false }])
  })

  it('marks the name of each mentioned teammate', () => {
    expect(mentionSegments('@Ana look at this, @Luis too', ['Ana', 'Luis'])).toEqual([
      { text: '@Ana', isMention: true },
      { text: ' look at this, ', isMention: false },
      { text: '@Luis', isMention: true },
      { text: ' too', isMention: false }
    ])
  })

  it('does not take the start of a longer name or an address for a mention', () => {
    expect(mentionSegments('@Anabel and ana@Ana.com', ['Ana'])).toEqual([
      { text: '@Anabel and ana@Ana.com', isMention: false }
    ])
  })

  it('prefers the longest name and takes names with spaces and symbols literally', () => {
    expect(mentionSegments('@Ana Maria (c) and @Ana', ['Ana', 'Ana Maria (c)'])).toEqual([
      { text: '@Ana Maria (c)', isMention: true },
      { text: ' and ', isMention: false },
      { text: '@Ana', isMention: true }
    ])
  })
})
