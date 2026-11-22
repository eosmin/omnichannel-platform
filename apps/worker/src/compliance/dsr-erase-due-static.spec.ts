import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The erasure of a customer is carried out by ONE caller in the worker: the nightly sweep of the data requests that are due (Step 7.2-H2b-1).
// A job that carried a customer id in its payload, or any other file that imported the service, would be a second way to erase a person that
// no reviewer approved and no grace period delayed. The module that provides the service is the only other file that names it.
const WORKER_SRC = join(__dirname, '..')
const API_SRC = join(__dirname, '..', '..', '..', 'api', 'src')
const ERASURE_LIB = '@platform/core/customer-erasure'

function sourcesOf(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourcesOf(path)
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}
const relativeTo = (root: string, files: string[]): string[] =>
  files.map(file => relative(root, file)).sort()

describe('who may erase a customer in the worker', () => {
  it('lets only the sweep and the module that provides it import the erasure library', () => {
    const importers = sourcesOf(WORKER_SRC).filter(file =>
      readFileSync(file, 'utf8').includes(ERASURE_LIB)
    )

    expect(relativeTo(WORKER_SRC, importers)).toEqual([
      'compliance/dsr-erase-due.sweeper.ts',
      'compliance/dsr.module.ts'
    ])
  })

  it('lets only the sweep call the erasure service', () => {
    const callers = sourcesOf(WORKER_SRC).filter(file =>
      /\.erase\(/.test(readFileSync(file, 'utf8'))
    )

    expect(relativeTo(WORKER_SRC, callers)).toEqual(['compliance/dsr-erase-due.sweeper.ts'])
  })

  it('keeps the actor of the sweep out of the api: no request builds an actor that is the system or that names a data request', () => {
    const offenders = sourcesOf(API_SRC).filter(file => {
      const text = readFileSync(file, 'utf8')
      return (
        text.includes('dsrRequestId') ||
        /\bsystem:\s*true\b[^}]*userId|userId[^}]*\bsystem:\s*true\b/.test(text)
      )
    })

    expect(relativeTo(API_SRC, offenders)).toEqual([])
  })
})
