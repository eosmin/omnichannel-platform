import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const filesIn = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === '.next' ? [] : filesIn(path)
    return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name) ? [path] : []
  })

// The generic rules of the files a channel takes (`@platform/core/channel-media`) are read by the server, the worker
// and the plugins. Imported from the browser, they would ship in every bundle, and the inbox sits at the ceiling of its
// script budget. The tables of each channel live in its own library (`libs/channels/*`), which the browser may not
// import at all (Nx boundaries): the last case below keeps a plugin library out of the web sources.
describe('the rules of the files a channel takes, in the browser', () => {
  const sources = [
    ...filesIn(resolve(__dirname, '..')),
    ...filesIn(resolve(__dirname, '../../../libs/api-client/src'))
  ]

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it('never imports the module, nor the files behind it', () => {
    const offenders = sources.filter(path =>
      /platform\/core\/channel-media|domain\/channel-media\b/.test(readFileSync(path, 'utf8'))
    )
    expect(offenders.map(path => path.slice(resolve(__dirname, '../../..').length + 1))).toEqual([])
  })

  it('is not reachable through the barrel of the domain either', () => {
    const barrel = readFileSync(resolve(__dirname, '../../../libs/core/domain/index.ts'), 'utf8')
    expect(barrel).not.toMatch(/channel-media/)
  })

  it('imports no library of a channel', () => {
    const offenders = sources.filter(path =>
      /@platform\/channels\//.test(readFileSync(path, 'utf8'))
    )
    expect(offenders.map(path => path.slice(resolve(__dirname, '../../..').length + 1))).toEqual([])
  })
})
