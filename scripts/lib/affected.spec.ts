import { isDocsOnly, selectSteps } from './affected'

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

describe('selectSteps', () => {
  const steps = [
    { name: 'lint', command: ['lint'] },
    { name: 'test', command: ['test'], tests: true }
  ]

  it('leaves the test steps to CI by default', () => {
    expect(selectSteps(steps, { full: false }).map(s => s.name)).toEqual(['lint'])
  })

  it('keeps every step with --full', () => {
    expect(selectSteps(steps, { full: true }).map(s => s.name)).toEqual(['lint', 'test'])
  })
})
