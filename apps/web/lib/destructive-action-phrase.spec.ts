import { phraseMatches as inCore } from '@platform/core/domain'

import { phraseMatches as inWeb } from './destructive-action'

// The web keeps its own copy of the rule so that the domain barrel does not weigh on the inbox; until
// they are one (Step 7.7), both are held to the same cases
describe('phraseMatches in the web and in core', () => {
  it.each([
    ['My shop', 'My shop', true],
    ['  My shop ', 'My shop', true],
    ['My shop', 'My shop ', true],
    ['my shop', 'My shop', false],
    ['', 'My shop', false],
    ['My  shop', 'My shop', false]
  ])('reads %j against %j as %s', (typed, phrase, expected) => {
    expect(inWeb(typed, phrase)).toBe(expected)
    expect(inCore(typed, phrase)).toBe(expected)
  })
})
