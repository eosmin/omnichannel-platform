import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { ErrorCodes, resourceNotFound } from '@platform/core/errors'

// `resourceNotFound(what)` writes "<what> not found" itself: a caller that says "not found" too makes the person read it twice (B5)
const ROOT = join(__dirname, '..')

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })

describe('the text of a resource that is not found', () => {
  it('is said once by the factory', () => {
    const error = resourceNotFound('Media')
    expect(error.message).toBe('Media not found')
    expect(error.code).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
  })

  it('is never repeated by a caller of the factory', () => {
    const repeated = sources(ROOT).filter(file =>
      /resourceNotFound\(\s*(['"`])[^'"`]*\bnot found\b/i.test(readFileSync(file, 'utf8'))
    )
    expect(repeated).toEqual([])
  })
})
