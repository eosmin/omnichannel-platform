import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const filesIn = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === '.next' ? [] : filesIn(path)
    return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name) ? [path] : []
  })

// The full table of error codes (`ErrorCodes`, about 120 of them) is one binding for the bundler, so
// reading any code from it ships all of them to every page: about 1 KB of the script budget of the inbox.
// The browser reads `ClientErrorCodes`, and the messages tell which codes the page knows.
describe('the error codes in the browser', () => {
  const sources = [
    ...filesIn(resolve(__dirname, '..')),
    ...filesIn(resolve(__dirname, '../../../libs/api-client/src'))
  ]

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it('never imports the full table', () => {
    const offenders = sources.filter(path =>
      /(?<![A-Za-z])ErrorCodes\b/.test(readFileSync(path, 'utf8'))
    )
    expect(offenders.map(path => path.slice(resolve(__dirname, '../../..').length + 1))).toEqual([])
  })
})
