import { isDocsOnly } from './affected'

describe('isDocsOnly', () => {
  it('is true when every changed file is under docs/', () => {
    expect(isDocsOnly(['docs/INDEX.md', 'docs/TDD_01_Architecture.md'])).toBe(true)
  })

  it('is false as soon as one file is code, configuration or another document', () => {
    expect(isDocsOnly(['docs/INDEX.md', 'libs/core/http/src/index.ts'])).toBe(false)
    expect(isDocsOnly(['CLAUDE.md'])).toBe(false)
    expect(isDocsOnly(['docsx/readme.md'])).toBe(false)
  })

  it('is false for no change at all, so that the caller decides what nothing means', () => {
    expect(isDocsOnly([])).toBe(false)
  })
})
